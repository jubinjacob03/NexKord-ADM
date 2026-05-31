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

let dashboardMessage = null;
const DASHBOARD_CHANNEL_ID = process.env.AMONGUS_DASHBOARD_CHANNEL_ID;

/**
 * Builds the Among Us dashboard payload with interactive buttons.
 * Creates a rich Discord UI container with server information and lobby creation buttons.
 *
 * @async
 * @returns {Promise<{components: Array}>} Discord message payload with container components
 *
 * @description
 * Constructs a dashboard containing:
 * - Banner image gallery
 * - Server IP and port information
 * - Three preset buttons: Classic, Chaos, and Ranked
 * - Connection instructions for mobile and PC users
 */
export async function buildAmongUsDashboardPayload() {
  const container = new ContainerBuilder().setAccentColor(0xff0000);

  const bannerGallery = new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(
      "https://raw.githubusercontent.com/jubinjacob03/jubinjacob03/main/Public-CDN/au-banner.png"
    ),
  );
  container.addMediaGalleryComponents(bannerGallery);

  const serverIp = process.env.IMPOSTOR_SERVER_IP || "play.nexkord.com";
  const connectionString = `${icon("HELP_WORLD")} **SERVER : ** \`${serverIp}\`    ${icon("MC_ADDRESS")} **PORT : ** \`22023\``;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(connectionString),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### ${icon("HELP_HEADER")} Among Us Custom Server\nClick the buttons below to create a lobby. Mobile users can use the deep link provided after creation to connect instantly.`
    ),
  );

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("au_create_classic")
        .setLabel("Create Classic")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("au_create_chaos")
        .setLabel("Create Chaos")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("au_create_ranked")
        .setLabel("Create Ranked")
        .setStyle(ButtonStyle.Success)
    )
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Posts or updates the Among Us dashboard in the configured Discord channel.
 * Automatically detects existing dashboard messages and updates them instead of creating duplicates.
 *
 * @async
 * @param {import('discord.js').Client} client - The Discord.js client instance
 * @returns {Promise<void>}
 *
 * @description
 * This function:
 * 1. Fetches the configured dashboard channel
 * 2. Searches for existing dashboard messages from the bot
 * 3. Updates the existing message or creates a new one
 * 4. Stores the message reference for future updates
 *
 * @example
 * client.once('ready', async () => {
 *   await postAmongUsDashboard(client);
 * });
 */
export async function postAmongUsDashboard(client) {
  if (!DASHBOARD_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(DASHBOARD_CHANNEL_ID);
    if (!channel) return;

    const messages = await channel.messages.fetch({ limit: 10 });
    const existingMsg = messages.find((m) => m.author.id === client.user.id);

    const payload = await buildAmongUsDashboardPayload();

    if (existingMsg) {
      dashboardMessage = await existingMsg.edit(payload);
    } else {
      dashboardMessage = await channel.send(payload);
    }
  } catch (error) {
    console.error("[AmongUs] Failed to post dashboard:", error);
  }
}
