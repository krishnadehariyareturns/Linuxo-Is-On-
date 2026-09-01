const { SlashCommandBuilder, ContainerBuilder, ButtonStyle, MessageFlags } = require('discord.js');

const REFRESH_MS = 5000;
const MAX_TICKS = 9; // 9 x 5s = 45s of live updates, then the panel freezes

function formatUptime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;

    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function buildPanel(client) {
    const uptime = formatUptime(client.uptime);
    // client.ws.ping only updates when a heartbeat ack comes in (roughly every 30-40s),
    // so it can repeat across a couple of refreshes — that's expected, not a bug.
    const ping = client.ws.ping >= 0 ? `${client.ws.ping}ms` : 'calculating...';

    return new ContainerBuilder()
        .addMediaGalleryComponents((gallery) => gallery
            .addItems(
                (mediaGalleryItem) => mediaGalleryItem
                    .setURL("https://res.cloudinary.com/e2k80pfo/image/upload/v1787726833/New_Project_B4F9276.gif"),
            )
        )
        .addSeparatorComponents((separator) => separator
            .setDivider(true)
        )
        .addSectionComponents((section) => section
            .addTextDisplayComponents(
                (textDisplay) => textDisplay
                    .setContent(`## 🐧 Linuxo\n\n**Linuxo Bot**\nVersion: \`v0.1.0\`\nStatus: 🟢 Online\nUptime: \`${uptime}\`\nLatency: \`${ping}\`\n\n\`linuxo@discord:~$\``),
            )
            .setButtonAccessory((button) => button
                .setStyle(ButtonStyle.Secondary)
                .setCustomId("p_339719003125583873")
                .setLabel("Ctrl + C")
            )
        )
        .addSeparatorComponents((separator) => separator
            .setDivider(true)
        )
        .addTextDisplayComponents((textDisplay) => textDisplay
            .setContent("-# 2026 Linuxo owned by MoonX <3")
        );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('startup')
        .setDescription('Show the Linuxo startup panel'),

    async execute(interaction) {
        await interaction.reply({
            components: [buildPanel(interaction.client)],
            flags: MessageFlags.IsComponentsV2,
        });

        let ticks = 0;
        const interval = setInterval(async () => {
            ticks++;
            try {
                await interaction.editReply({
                    components: [buildPanel(interaction.client)],
                    flags: MessageFlags.IsComponentsV2,
                });
            } catch (err) {
                clearInterval(interval);
                return;
            }
            if (ticks >= MAX_TICKS) {
                clearInterval(interval);
            }
        }, REFRESH_MS);
    },

    buttons: {
        p_339719003125583873: async (interaction) => {
            const invokerId = interaction.message.interactionMetadata?.user?.id;

            if (invokerId && invokerId !== interaction.user.id) {
                await interaction.reply({
                    content: 'Oops, Error 404',
                    ephemeral: true,
                });
                return;
            }

            await interaction.deferUpdate();
            await interaction.message.delete();
        },
    },
};
