'use strict';

const DEFAULT_MODEL = 'openrouter/free'; // OpenRouter's auto-router over currently-available $0 models — avoids hardcoding a specific free model id that may be retired later.
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Minimal OpenRouter client — no SDK dependency, just fetch (built into
 * Node 18+). Deliberately small and swappable: pass `fetchImpl` in tests.
 */
async function callOpenRouter({ apiKey, model = DEFAULT_MODEL, messages, maxTokens = 700, temperature = 0.2, referer, title, fetchImpl = fetch, timeoutMs = 20_000 }) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetchImpl(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                // Optional but recommended by OpenRouter for attribution/rate-limit purposes.
                ...(referer ? { 'HTTP-Referer': referer } : {}),
                ...(title ? { 'X-Title': title } : {}),
            },
            body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const bodyText = await res.text().catch(() => '');
            throw new Error(`OpenRouter request failed (${res.status}): ${bodyText.slice(0, 300)}`);
        }

        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (!text) throw new Error('OpenRouter returned no completion content');
        return { text, model: data?.model || model, usage: data?.usage };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { callOpenRouter, DEFAULT_MODEL };
