import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} from "discord.js";
import { icon } from "../../utils/icons.js";
import { auditLog } from "../../utils/logger.js";

let dashboardMessage = null;
const DASHBOARD_CHANNEL_ID = process.env.AMONGUS_DASHBOARD_CHANNEL_ID;

let latestLog = "\u001b[1;34m[INFO]\u001b[0m Awaiting Lobby Requests...";

/**
 * Logs a message to the Among Us dashboard console
 * @param {string} message - The message to log
 */
export function logAmongUsConsole(message) {
  if (typeof message !== "string") return;

  const timestamp = new Date().toISOString().replace("T", " ").substring(11, 19);
  latestLog = `\u001b[1;34m[INFO]\u001b[0m \u001b[1;36m${timestamp} »\u001b[0m ${message}`;

  if (dashboardMessage) {
    buildAmongUsDashboardPayload()
      .then((payload) => {
        if (dashboardMessage && !dashboardMessage.deleted) {
          return dashboardMessage.edit(payload);
        }
      })
      .catch((error) => {
        auditLog("error", "DASHBOARD_UPDATE", `Failed to update dashboard: ${error.message}`);
      });
  }
}

/**
 * Builds the Among Us dashboard payload
 * @returns {Promise<Object>} Discord message payload
 */
export async function buildAmongUsDashboardPayload() {
  const container = new ContainerBuilder().setAccentColor(0x00ffff);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("HELP_HEADER")}⠀AMONG US • NexKord Server\n` +
      `Welcome to the NexKord custom Among Us server! Create lobbies with custom roles and settings.`
    )
  );

  const bannerGallery = new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(
      `https://raw.githubusercontent.com/jubinjacob03/jubinjacob03/main/Public-CDN/au-banner.png?v=${Date.now()}`
    )
  );
  container.addMediaGalleryComponents(bannerGallery);

  const serverIp = process.env.IMPOSTOR_SERVER_IP || "play.nexkord.com";
  const connectionString = `${icon("HELP_WORLD")}  **SERVER : ** \`${serverIp}\`  \u00A0\u00A0\u00A0\u00A0\u00A0\u00A0  ${icon("MC_ADDRESS")}  **PORT : ** \`22023\``;

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(connectionString));

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  const pad = "              ";
  const header = [
    `\u001b[36m${pad} _  _         _  __            _ \u001b[0m`,
    `\u001b[36m${pad}| \\| |_____ _| |/ /___ _ _ __| |\u001b[0m`,
    `\u001b[36m${pad}| .\` / -_) \\ / ' </ _ \\ '_/ _\` |\u001b[0m`,
    `\u001b[36m${pad}|_|\\_\\___/_\\_\\_|\\_\\___/_| \\__,_|\u001b[0m`,
    `\u001b[35m${pad}NexKord Server Management System\u001b[0m`,
    "",
    latestLog,
  ].join("\n");

  const consoleContent = `\`\`\`ansi\n${header}\n\`\`\``;
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(consoleContent));

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `${icon("LAUNCH_GREEN")}  **Quick Launch Presets**\n`
    )
  );

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("au_create_classic")
        .setLabel("Classic")
        .setEmoji(icon("LAUNCH_GREEN"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("au_create_chaos")
        .setLabel("Chaos")
        .setEmoji(icon("LAUNCH_MAGENTA"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("au_create_shapeshifter")
        .setLabel("Shapeshifter")
        .setEmoji(icon("LAUNCH_VIOLET"))
        .setStyle(ButtonStyle.Secondary)
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `${icon("EDITOR")}  **Advanced Options**\n`
    )
  );

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(false));

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("au_presets")
        .setLabel("View Presets")
        .setEmoji(icon("QUEUE"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("au_custom_menu")
        .setLabel("Custom Presets")
        .setEmoji(icon("EDITOR"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("au_reset")
        .setLabel("Reset Guide")
        .setEmoji(icon("REFRESH"))
        .setStyle(ButtonStyle.Secondary)
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  const ts = Math.floor(Date.now() / 1000);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# NexKord-ADM  •  <t:${ts}:f>`)
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Posts or updates the Among Us dashboard
 * @param {Object} client - Discord.js client instance
 */
export async function postAmongUsDashboard(client) {
  if (!DASHBOARD_CHANNEL_ID) {
    auditLog("warn", "AMONGUS_DASHBOARD", "Dashboard channel ID not configured");
    return;
  }

  try {
    const channel = await client.channels.fetch(DASHBOARD_CHANNEL_ID);
    if (!channel?.isTextBased()) {
      auditLog("error", "AMONGUS_DASHBOARD", "Dashboard channel not found or not text-based");
      return;
    }

    const messages = await channel.messages.fetch({ limit: 10 });
    const existingMsg = messages.find((m) => m.author.id === client.user.id);

    const payload = await buildAmongUsDashboardPayload();

    if (existingMsg) {
      dashboardMessage = await existingMsg.edit(payload);
      auditLog("info", "AmongUs", "Updated existing dashboard message.");
    } else {
      dashboardMessage = await channel.send(payload);
      auditLog("info", "AmongUs", "Posted new dashboard message.");
    }
  } catch (error) {
    auditLog("error", "AmongUs", `Failed to post dashboard: ${error.message}`);
  }
}
