import { 
    SlashCommandBuilder, 
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} from 'discord.js';
import { sendCommand } from './games/minecraft/pterodactyl.js';
import { eReply, EPHEMERAL_COLOR } from './utils/embed.js';
import { auditLog } from './utils/logger.js';

const COMMAND_SUGGESTIONS = [
    'op ', 'deop ', 'whitelist add ', 'whitelist remove ', 'whitelist list', 'whitelist on', 'whitelist off',
    'ban ', 'pardon ', 'kick ', 'list', 'seed', 'say ',
    'time set day', 'time set night', 'time set noon', 'time set midnight',
    'weather clear', 'weather rain', 'weather thunder',
    'gamemode survival ', 'gamemode creative ', 'gamemode spectator ', 'gamemode adventure ',
    'tp ', 'give ', 'kill ', 'xp add ', 'clear ',
    'msh start', 'msh stop', 'msh status', 'msh restart'
];

export const commandDefinitions = [
    new SlashCommandBuilder()
        .setName('mine')
        .setDescription('Minecraft server management commands')
        .setDMPermission(false)
        .addSubcommand(subcommand =>
            subcommand
                .setName('command')
                .setDescription('Send a console command to the Minecraft server')
                .addStringOption(option =>
                    option.setName('cmd')
                        .setDescription('The command to execute')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('help')
                .setDescription('Display the available commands cheat sheet')
        )
];

/**
 * Handles incoming application slash commands and autocomplete interactions.
 * 
 * @param {import('discord.js').Interaction} interaction - The Discord interaction event context.
 * @returns {Promise<void>}
 */
export async function handleSlashCommand(interaction) {
    if (interaction.isAutocomplete()) {
        const memberRoles = interaction.member?.roles?.cache;
        const hasRole = memberRoles?.has("1508887584032686201") || memberRoles?.has("1473075468088377352");
        if (!hasRole) {
            await interaction.respond([]);
            return;
        }

        const focusedValue = interaction.options.getFocused().toLowerCase();
        
        const filtered = COMMAND_SUGGESTIONS.filter(choice => choice.toLowerCase().includes(focusedValue));
        
        await interaction.respond(
            filtered.slice(0, 25).map(choice => ({ name: choice, value: choice }))
        );
        return;
    }

    if (interaction.isChatInputCommand()) {
        const memberRoles = interaction.member?.roles?.cache;
        const hasRole = memberRoles?.has("1508887584032686201") || memberRoles?.has("1473075468088377352");
        if (!hasRole) {
            return interaction.reply(eReply("Access Denied", "Please ask the Minecraft Moderator to perform this action."));
        }

        if (interaction.commandName === 'mine') {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'command') {
                let cmd = interaction.options.getString('cmd').trim();

                if (cmd.startsWith('/')) cmd = cmd.substring(1);
                if (!cmd.startsWith('msh ') && !cmd.startsWith('mine ')) {
                    cmd = `mine ${cmd}`;
                }

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                try {
                    auditLog('info', 'SLASH_COMMAND', `${interaction.user.tag} executed via slash: ${cmd}`);
                    await sendCommand(cmd);
                    await interaction.editReply(eReply("Command Executed", `✅ Successfully executed: \`${cmd}\``));
                } catch (error) {
                    auditLog('error', 'SLASH_COMMAND_FAIL', `${interaction.user.tag} failed: ${cmd} | Error: ${error.message}`);
                    await interaction.editReply(eReply("Command Failed", `❌ ${error.message}`));
                }
            } else if (subcommand === 'help') {
                const container = new ContainerBuilder().setAccentColor(EPHEMERAL_COLOR);
                
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`### <:iconHelpHeader:1508917267507970240> Minecraft Server Control Help\nWelcome to the command reference manual. Use this directory to manage your Minecraft server instance:`)
                );
                
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                );
                
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`<:iconHelpAdmin:1508916118570401863> **Administrative Controls**\n* **Operator Powers**: \`op <player>\` | \`deop <player>\`\n* **Whitelist Setup**: \`whitelist <on | off | list>\`\n* **Whitelist Members**: \`whitelist <add | remove> <player>\`\n* **Player Access**: \`ban <player>\` | \`pardon <player>\` | \`kick <player>\`\n* **Server Info**: \`list\` | \`seed\` | \`say <message>\``)
                );
                
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                );
                
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`<:iconHelpWorld:1508916196685385789> **Environment & World Settings**\n* **World Time**: \`time set <day | night | noon | midnight>\`\n* **Weather Loop**: \`weather <clear | rain | thunder>\``)
                );
                
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                );
                
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`<:iconHelpGameplay:1508916323491516678> **Gameplay Utilities**\n* **Player Gamemode**: \`gamemode <survival | creative | spectator>\`\n* **Teleportation**: \`tp <player> <target>\`\n* **Item Spawning**: \`give <player> <item> [amount]\`\n* **Experience (XP)**: \`xp add <player> <amount>\`\n* **Inventory Control**: \`clear <player>\` | \`kill <player>\``)
                );
                
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                );
                
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`<:iconHelpMsh:1508916409210507527> **MSH (Server Hibernation Daemon)**\n* **Power Trigger**: \`msh start\` | \`msh stop\`\n* **System Status**: \`msh status\` | \`msh restart\``)
                );
                
                const ts = Math.floor(Date.now() / 1000);
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                );
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`-# NexKord-ADM · <t:${ts}:f>`)
                );

                await interaction.reply({
                    components: [container],
                    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
                });
            }
        }
    }
}
