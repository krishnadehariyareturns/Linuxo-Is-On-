'use strict';

const { fingerprint: stackFingerprint } = require('./errors');

/** Bounded ring buffer — cheap append, old entries fall off automatically. */
class RingBuffer {
    constructor(maxSize = 5000) {
        this.maxSize = maxSize;
        this.items = [];
    }

    push(item) {
        this.items.push(item);
        if (this.items.length > this.maxSize) this.items.shift();
    }

    toArray() {
        return this.items;
    }
}

/**
 * Strips variable-looking tokens (IDs, numbers, hex, uuids, quoted values)
 * out of an error message so two occurrences of "user 8823991 not found"
 * and "user 9911002 not found" collapse to the same semantic signature —
 * used for smart alert dedup, which is coarser than errors.fingerprint()
 * (that one already ignores message text entirely; this one still uses it,
 * just normalized).
 */
function semanticSignature(normalizedError) {
    if (!normalizedError) return 'unknown';
    const msg = String(normalizedError.message || '')
        .replace(/[0-9a-fA-F]{8,}/g, '#')
        .replace(/\b\d+\b/g, '#')
        .replace(/"[^"]*"|'[^']*'/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
    return `${normalizedError.name}:${normalizedError.code ?? ''}:${msg}`;
}

/**
 * ForensicsStore is the logger's "black box recorder": every emitted record
 * is fed into it (see core.js) and it answers the ten investigation
 * features on top of that shared history. It never affects what gets
 * logged — purely a read-side index over the same records.
 */
class ForensicsStore {
    constructor({ maxRecords = 5000, buildInfo = {} } = {}) {
        this.all = new RingBuffer(maxRecords);
        this.byTrace = new Map(); // traceId -> record[]
        this.groups = new Map(); // fingerprint -> { count, firstSeen, lastSeen, sample, command, name, traceIds:Set, buckets:number[] }
        this.smartSeen = new Map(); // semanticSignature -> { count, firstSeen, lastSeen, fingerprints:Set }
        this.debugOverrides = []; // [{ expiresAt, command, traceId, userId, guildId }]
        this.buildInfo = { startedAt: Date.now(), ...buildInfo };
        this.buildHistory = [{ ...this.buildInfo, changedAt: Date.now() }];
    }

    // ---- 6. Runtime/build change context -------------------------------
    /** Call again whenever a deploy/build actually rolls out (e.g. on BOT_READY after a restart with a new commit). */
    recordBuildChange(info) {
        this.buildInfo = { ...this.buildInfo, ...info, startedAt: Date.now() };
        this.buildHistory.push({ ...this.buildInfo, changedAt: Date.now() });
        if (this.buildHistory.length > 50) this.buildHistory.shift();
    }

    /** How long after the current build started did `timestamp` occur, and was there a build change nearby? */
    buildContextFor(timestampMs) {
        const msSinceStart = timestampMs - this.buildInfo.startedAt;
        const recentChange = msSinceStart >= 0 && msSinceStart < 10 * 60_000; // within 10 min of a build/deploy
        return {
            buildId: this.buildInfo.buildId,
            deployId: this.buildInfo.deployId,
            gitSha: this.buildInfo.gitSha,
            nodeVersion: this.buildInfo.nodeVersion,
            msSinceBuildStart: msSinceStart,
            recentlyDeployed: recentChange,
        };
    }

    // ---- ingest: called once per emitted record from core.js -----------
    ingest(record) {
        this.all.push(record);

        if (record.traceId) {
            if (!this.byTrace.has(record.traceId)) this.byTrace.set(record.traceId, []);
            const arr = this.byTrace.get(record.traceId);
            arr.push(record);
            if (arr.length > 200) arr.shift();
        }

        if (record.error && (record.level === 'error' || record.level === 'fatal')) {
            this._recordError(record);
        }
    }

    _recordError(record) {
        const fp = record.fingerprint || stackFingerprint(record.error, record);
        const now = Date.now();

        // ---- 3. Error grouping + trends ----
        let g = this.groups.get(fp);
        if (!g) {
            g = { fingerprint: fp, count: 0, firstSeen: now, lastSeen: now, sample: record, command: record.command, name: record.error.name, traceIds: new Set(), hourBuckets: new Map() };
            this.groups.set(fp, g);
        }
        g.count++;
        g.lastSeen = now;
        g.sample = record;
        if (record.traceId) g.traceIds.add(record.traceId);
        const hourBucket = Math.floor(now / 3_600_000);
        g.hourBuckets.set(hourBucket, (g.hourBuckets.get(hourBucket) || 0) + 1);

        // ---- 7. Smart alert deduplication (semantic, cross-trace) ----
        const sig = semanticSignature(record.error);
        let s = this.smartSeen.get(sig);
        if (!s) {
            s = { count: 0, firstSeen: now, lastSeen: now, fingerprints: new Set() };
            this.smartSeen.set(sig, s);
        }
        s.count++;
        s.lastSeen = now;
        s.fingerprints.add(fp);
    }

    // ---- 1. Error → forensic timeline / 2. Trace-based investigation ---
    /** Full chronological timeline for one trace, with deltas between steps. */
    getTimeline(traceId) {
        const records = (this.byTrace.get(traceId) || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        let prevTs = null;
        return records.map((r) => {
            const ts = new Date(r.timestamp).getTime();
            const deltaMs = prevTs === null ? 0 : ts - prevTs;
            prevTs = ts;
            return {
                timestamp: r.timestamp,
                deltaMs,
                level: r.level,
                event: r.event,
                message: r.message,
                status: r.status,
                command: r.command,
                customId: r.customId,
                error: r.error ? { name: r.error.name, message: r.error.message, code: r.error.code, httpStatus: r.error.httpStatus } : null,
            };
        });
    }

    /** Everything relevant to one trace id, assembled for a human or an AI summarizer. */
    investigate(traceId) {
        const timeline = this.getTimeline(traceId);
        if (!timeline.length) return null;

        const errorStep = timeline.find((t) => t.error) || null;
        const anchorTs = errorStep ? new Date(errorStep.timestamp).getTime() : new Date(timeline[timeline.length - 1].timestamp).getTime();

        const group = errorStep
            ? [...this.groups.values()].find((g) => g.traceIds.has(traceId))
            : null;

        const relatedTraces = group ? [...group.traceIds].filter((id) => id !== traceId).slice(-5) : [];

        return {
            traceId,
            timeline,
            errorSummary: errorStep ? errorStep.error : null,
            occurrenceCount: group ? group.count : timeline.length ? 1 : 0,
            firstSeen: group ? new Date(group.firstSeen).toISOString() : timeline[0].timestamp,
            lastSeen: group ? new Date(group.lastSeen).toISOString() : timeline[timeline.length - 1].timestamp,
            relatedTraceIds: relatedTraces,
            buildContext: this.buildContextFor(anchorTs),
            interactionTimeline: this.getInteractionTimeline({
                userId: timeline.find((t) => t.userId)?.userId,
                guildId: timeline.find((t) => t.guildId)?.guildId,
                aroundMs: anchorTs,
                windowMs: 5 * 60_000,
            }),
        };
    }

    // ---- 3. Error grouping + trends (read side) -------------------------
    /** Ranked list of error groups with a simple trend indicator (comparing the last hour bucket to the one before it). */
    getTrends({ limit = 10 } = {}) {
        const nowBucket = Math.floor(Date.now() / 3_600_000);
        return [...this.groups.values()]
            .map((g) => {
                const thisHour = g.hourBuckets.get(nowBucket) || 0;
                const lastHour = g.hourBuckets.get(nowBucket - 1) || 0;
                const trend = thisHour > lastHour ? 'up' : thisHour < lastHour ? 'down' : 'flat';
                return {
                    fingerprint: g.fingerprint,
                    name: g.name,
                    command: g.command,
                    count: g.count,
                    distinctTraces: g.traceIds.size,
                    firstSeen: new Date(g.firstSeen).toISOString(),
                    lastSeen: new Date(g.lastSeen).toISOString(),
                    lastHourCount: thisHour,
                    prevHourCount: lastHour,
                    trend,
                    sampleMessage: g.sample?.error?.message,
                };
            })
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }

    // ---- 4. Relevant-log filtering --------------------------------------
    /** Structured filter over the recent record window. All filters are AND'd; omit any you don't need. */
    filter({ level, event, command, guildId, userId, status, sinceMs, untilMs, hasError, limit = 100 } = {}) {
        const since = sinceMs ?? 0;
        const until = untilMs ?? Date.now();
        return this.all.toArray()
            .filter((r) => {
                const ts = new Date(r.timestamp).getTime();
                if (ts < since || ts > until) return false;
                if (level && r.level !== level) return false;
                if (event && r.event !== event) return false;
                if (command && r.command !== command) return false;
                if (guildId && r.guildId !== guildId) return false;
                if (userId && r.userId !== userId) return false;
                if (status && r.status !== status) return false;
                if (hasError !== undefined && Boolean(r.error) !== hasError) return false;
                return true;
            })
            .slice(-limit);
    }

    // ---- 5. Production debug mode ---------------------------------------
    /** Temporarily force verbose (trace-level) capture for a scope, without flipping the whole bot's log level in prod. */
    enableDebugMode({ durationMs = 10 * 60_000, command, userId, guildId } = {}) {
        const override = { expiresAt: Date.now() + durationMs, command, userId, guildId };
        this.debugOverrides.push(override);
        return override;
    }

    /** Called by core.js's _emit before the normal level check — true means "capture this even though it's below the configured floor". */
    isDebugForced(context = {}) {
        const now = Date.now();
        this.debugOverrides = this.debugOverrides.filter((o) => o.expiresAt > now);
        return this.debugOverrides.some((o) => (!o.command || o.command === context.command)
            && (!o.userId || o.userId === context.userId)
            && (!o.guildId || o.guildId === context.guildId));
    }

    // ---- 7. Smart alert deduplication (read side) ------------------------
    /** Should this semantic signature be suppressed right now, and how many times has it fired total? */
    smartDedupCheck(normalizedError) {
        const sig = semanticSignature(normalizedError);
        const s = this.smartSeen.get(sig);
        return { signature: sig, totalCount: s?.count || 0, distinctFingerprints: s ? s.fingerprints.size : 0 };
    }

    // ---- 8. Discord interaction timeline ----------------------------------
    /** Sequence of command/button interactions for a user/guild, optionally centered on a timestamp window — "what did this person do right before it broke". */
    getInteractionTimeline({ userId, guildId, aroundMs, windowMs = 15 * 60_000, limit = 50 } = {}) {
        const since = aroundMs !== undefined ? aroundMs - windowMs : 0;
        const until = aroundMs !== undefined ? aroundMs + windowMs : Date.now();
        return this.all.toArray()
            .filter((r) => {
                if (!['COMMAND_START', 'COMMAND_END', 'COMMAND_ERROR', 'BUTTON_START', 'BUTTON_END', 'BUTTON_ERROR'].includes(r.event)) return false;
                const ts = new Date(r.timestamp).getTime();
                if (ts < since || ts > until) return false;
                if (userId && r.userId !== userId) return false;
                if (guildId && r.guildId !== guildId) return false;
                return true;
            })
            .map((r) => ({ timestamp: r.timestamp, event: r.event, command: r.command, customId: r.customId, status: r.status, traceId: r.traceId }))
            .slice(-limit);
    }

    // ---- 9. Search/query system -------------------------------------------
    /** Free-text search across message/event/command/error fields, newest-first, lightly ranked by number of term hits. */
    search(query, { limit = 25 } = {}) {
        const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length) return [];

        const scored = [];
        for (const r of this.all.toArray()) {
            const haystack = [r.event, r.command, r.customId, r.message, r.error?.name, r.error?.message, r.traceId]
                .filter(Boolean).join(' ').toLowerCase();
            let score = 0;
            for (const t of terms) if (haystack.includes(t)) score++;
            if (score > 0) scored.push({ record: r, score });
        }

        return scored
            .sort((a, b) => b.score - a.score || new Date(b.record.timestamp) - new Date(a.record.timestamp))
            .slice(0, limit)
            .map(({ record, score }) => ({
                score,
                timestamp: record.timestamp,
                level: record.level,
                event: record.event,
                traceId: record.traceId,
                message: record.message,
            }));
    }
}

module.exports = { ForensicsStore, semanticSignature };
