import {
  SlashCommandBuilder,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from "discord.js";
import { sendCommand } from "./games/minecraft/pterodactyl.js";
import { createImpostorLobby } from "./games/amongus/impostor.js";
import { eReply, EPHEMERAL_COLOR } from "./utils/embed.js";
import { auditLog } from "./utils/logger.js";
import { icon } from "./utils/icons.js";

const COMMAND_SUGGESTIONS = [
  "op ",
  "deop ",
  "whitelist add ",
  "whitelist remove ",
  "whitelist list",
  "whitelist on",
  "whitelist off",
  "ban ",
  "pardon ",
  "kick ",
  "list",
  "seed",
  "say ",
  "time set day",
  "time set night",
  "time set noon",
  "time set midnight",
  "weather clear",
  "weather rain",
  "weather thunder",
  "gamemode survival ",
  "gamemode creative ",
  "gamemode spectator ",
  "gamemode adventure ",
  "tp ",
  "give ",
  "kill ",
  "xp add ",
  "clear ",
  "msh start",
  "msh stop",
  "msh status",
  "msh restart",
];

/**
 * Array of slash command definitions for Discord.
 * @type {Array<SlashCommandBuilder>}
 */
export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("mine")
    .setDescription("Minecraft server management commands")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("command")
        .setDescription("Send a console command to the Minecraft server")
        .addStringOption((option) =>
          option
            .setName("cmd")
            .setDescription("The command to execute")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("help")
        .setDescription("Display the available commands cheat sheet"),
    ),
  new SlashCommandBuilder()
    .setName("amongus")
    .setDescription("Among Us custom server management commands")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("room")
        .setDescription("Create a custom Among Us lobby on the NexKord server")
        .addStringOption((option) =>
          option
            .setName("preset")
            .setDescription("The preset to use for the lobby")
            .setRequired(true)
            .addChoices(
              { name: "Classic", value: "classic" },
              { name: "Chaos", value: "chaos" },
              { name: "Ranked", value: "ranked" }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("help")
        .setDescription("Display the Among Us commands and connection guide")
    ),
];

/**
 * Handles incoming application slash commands and autocomplete interactions.
 *
 * @async
 * @param {import('discord.js').Interaction} interaction - The Discord interaction event context
 * @returns {Promise<void>}
 *
 * @description
 * This function routes slash commands and autocomplete requests to their respective handlers.
 * It enforces role-based permissions and provides command suggestions for Minecraft commands.
 *
 * Supported commands:
 * - `/mine command <cmd>` - Execute Minecraft console commands
 * - `/mine help` - Display Minecraft command reference
 * - `/amongus room <preset>` - Create Among Us lobby
 * - `/amongus help` - Display Among Us command reference
 *
 * @example
 * client.on('interactionCreate', async (interaction) => {
 *   await handleSlashCommand(interaction);
 * });
 */
export async function handleSlashCommand(interaction) {
  if (interaction.isAutocomplete()) {
    const memberRoles = interaction.member?.roles?.cache;
    const hasRole =
      memberRoles?.has("1508887584032686201") ||
      memberRoles?.has("1473075468088377352");
    if (!hasRole) {
      await interaction.respond([]);
      return;
    }

    const focusedValue = interaction.options.getFocused().toLowerCase();

    const filtered = COMMAND_SUGGESTIONS.filter((choice) =>
      choice.toLowerCase().includes(focusedValue),
    );

    await interaction.respond(
      filtered.slice(0, 25).map((choice) => ({ name: choice, value: choice })),
    );
    return;
  }

  if (interaction.isChatInputCommand()) {
    const memberRoles = interaction.member?.roles?.cache;
    const hasRole =
      memberRoles?.has("1508887584032686201") ||
      memberRoles?.has("1473075468088377352");
    if (!hasRole) {
      return interaction.reply(
        eReply(
          "Access Denied",
          "Please ask the Minecraft Moderator to perform this action.",
        ),
      );
    }

    if (interaction.commandName === "mine") {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "command") {
        let cmd = interaction.options.getString("cmd").trim();

        if (cmd.startsWith("/")) cmd = cmd.substring(1);
        if (!cmd.startsWith("msh ") && !cmd.startsWith("mine ")) {
          cmd = `mine ${cmd}`;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          auditLog(
            "info",
            "SLASH_COMMAND",
            `${interaction.user.tag} executed via slash: ${cmd}`,
          );
          await sendCommand(cmd);
          await interaction.editReply(
            eReply(
              "Command Executed",
              `${icon("SUCCESS")} Successfully executed: \`${cmd}\``,
            ),
          );
        } catch (error) {
          auditLog(
            "error",
            "SLASH_COMMAND_FAIL",
            `${interaction.user.tag} failed: ${cmd} | Error: ${error.message}`,
          );
          await interaction.editReply(
            eReply("Command Failed", `${icon("ERROR")} ${error.message}`),
          );
        }
      } else if (subcommand === "help") {
        const container = new ContainerBuilder().setAccentColor(
          EPHEMERAL_COLOR,
        );

        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### ${icon("HELP_HEADER")} Minecraft Server Control Help\nWelcome to the command reference manual. Use this directory to manage your Minecraft server instance:`,
          ),
        );

        container.addSeparatorComponents(
          new SeparatorBuilder()
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small),
        );

        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${icon("HELP_ADMIN")} **Administrative Controls**\n* **Operator Powers**: \`op <player>\` | \`deop <player>\`\n* **Whitelist Setup**: \`whitelist <on | off | list>\`\n* **Whitelist Members**: \`whitelist <add | remove> <player>\`\n* **Player Access**: \`ban <player>\` | \`pardon <player>\` | \`kick <player>\`\n* **Server Info**: \`list\` | \`seed\` | \`say <message>\``,
          ),
        );

        container.addSeparatorComponents(
          new SeparatorBuilder()
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small),
        );

        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${icon("HELP_WORLD")} **Environment & World Settings**\n* **World Time**: \`time set <day | night | noon | midnight>\`\n* **Weather Loop**: \`weather <clear | rain | thunder>\``,
          ),
        );

        container.addSeparatorComponents(
          new SeparatorBuilder()
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small),
        );

        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${icon("HELP_GAMEPLAY")} **Gameplay Utilities**\n* **Player Gamemode**: \`gamemode <survival | creative | spectator>\`\n* **Teleportation**: \`tp <player> <target>\`\n* **Item Spawning**: \`give <player> <item> [amount]\`\n* **Experience (XP)**: \`xp add <player> <amount>\`\n* **Inventory Control**: \`clear <player>\` | \`kill <player>\``,
          ),
        );

        container.addSeparatorComponents(
          new SeparatorBuilder()
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small),
        );

        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${icon("HELP_MSH")} **MSH (Server Hibernation Daemon)**\n* **Power Trigger**: \`msh start\` | \`msh stop\`\n* **System Status**: \`msh status\` | \`msh restart\``,
          ),
        );

        const ts = Math.floor(Date.now() / 1000);
        container.addSeparatorComponents(
          new SeparatorBuilder()
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small),
        );
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# NexKord · <t:${ts}:f>`),
        );

        await interaction.reply({
          components: [container],
          flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
      }
    } else if (interaction.commandName === "amongus") {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "room") {
        const preset = interaction.options.getString("preset");

        await interaction.deferReply();
        try {
          auditLog("info", "SLASH_COMMAND", `${interaction.user.tag} executed /amongus room ${preset}`);

          const code = await createImpostorLobby(preset);

          const serverIp = process.env.IMPOSTOR_SERVER_IP || "play.nexkord.com";
          const deepLink = `amongus://init?servername=NexKord&serverip=${serverIp}&serverport=22023&usedtls=false`;

          await interaction.editReply(
            eReply(
              "Among Us Custom Lobby Created",
              `${icon("SUCCESS")} Successfully created a lobby on the NexKord Custom Server!\n\n` +
              `**Room Code:** \`${code}\`\n` +
              `**Preset:** \`${preset}\`\n\n` +
              `### How to Connect\n` +
              `**PC / Android:** Make sure your \`regionInfo.json\` is set to NexKord.\n` +
              `**iOS / Android (Auto):** Open Among Us in the background, then click this link:\n` +
              `[Tap here to connect to NexKord Server](${deepLink})`
            )
          );
        } catch (error) {
          auditLog("error", "SLASH_COMMAND_FAIL", `${interaction.user.tag} failed /amongus room: ${error.message}`);
          await interaction.editReply(
            eReply("Lobby Creation Failed", `${icon("ERROR")} ${error.message}`)
          );
        }
      } else if (subcommand === "help") {
        const helpEmbed = {
          color: EPHEMERAL_COLOR,
          title: `${icon("HELP_HEADER")} Among Us Commands & Info`,
          description: "Here is how to use the Among Us custom server integration:",
          fields: [
            {
              name: "🎮 Commands",
              value: "`/amongus room <preset>` - Creates a new lobby on the custom server.",
            },
            {
              name: "📋 Available Presets",
              value: "**Classic:** 2 Impostors, 15 Players, The Skeld\n**Chaos:** 3 Impostors, 15 Players, Mira HQ\n**Ranked:** 2 Impostors, 15 Players, Polus",
            },
            {
              name: "🔌 How to Connect",
              value: "**PC / Android:** Set your `regionInfo.json` to point to `play.nexkord.com`.\n**iOS / Android:** Use the deep link provided when a room is created.",
            }
          ],
        };
        await interaction.reply({ embeds: [helpEmbed], flags: MessageFlags.Ephemeral });
      }
    }
  }
}
