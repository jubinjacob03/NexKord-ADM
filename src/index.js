import { Client, Events, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import { initBotLogger } from "./utils/logger.js";
import {
  postMinecraftDashboard,
  handleMinecraftInteraction,
  updateDashboardWithStats,
  updateDashboardWithConsole,
} from "./games/minecraft/dashboard.js";
import { connectWebSocket } from "./games/minecraft/pterodactyl.js";
import { initUptimeMonitor } from "./games/minecraft/uptimeMonitor.js";
import { handleSlashCommand } from "./commands.js";
import { initIcons } from "./utils/icons.js";

dotenv.config();

initBotLogger();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildEmojisAndStickers,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  initIcons(readyClient);
  console.log(
    `[NexKord - ADM] Successfully logged in as ${readyClient.user.tag}`,
  );
  console.log(
    "[NexKord - ADM] Bot is online and running on extreme low-memory profile.",
  );

  await postMinecraftDashboard(client);

  connectWebSocket({
    onStatsUpdate: updateDashboardWithStats,
    onConsoleUpdate: updateDashboardWithConsole,
  });

  initUptimeMonitor(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
      await handleSlashCommand(interaction);
    } else {
      await handleMinecraftInteraction(interaction);
    }
  } catch (error) {
    console.error("Interaction error:", error);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught Exception:", err);
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN);

const shutdown = () => {
  console.log("[NexKord - ADM] Shutting down gracefully...");
  client.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
