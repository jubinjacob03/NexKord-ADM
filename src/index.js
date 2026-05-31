import { Client, Events, GatewayIntentBits, ActivityType } from "discord.js";
import dotenv from "dotenv";
import { initBotLogger } from "./utils/logger.js";
import {
  postMinecraftDashboard,
  handleMinecraftInteraction,
  updateDashboardWithStats,
  updateDashboardWithConsole,
} from "./games/minecraft/dashboard.js";
import {
  postAmongUsDashboard,
} from "./games/amongus/dashboard.js";
import { handleAmongUsInteraction } from "./games/amongus/controller.js";
import { connectWebSocket } from "./games/minecraft/pterodactyl.js";
import { initUptimeMonitor } from "./games/minecraft/uptimeMonitor.js";
import { handleSlashCommand } from "./commands.js";
import { initIcons } from "./utils/icons.js";

dotenv.config();

const idlePhrases = [
  "🟢 holding the uptime",
  "🧊 cooling the CPU",
  "⛏️ deep in the mines",
  "☕ brewing potions",
  "🧱 stacking blocks",
  "🌙 surviving the night",
  "🔥 keeping the TPS high",
  "🌌 floating in the void",
  "💣 planting the bomb",
  "💫 surviving the red zone",
  "🎒 looting the airdrop",
  "🛠️ faking tasks",
  "🔌 fixing wiring",
  "🍀 checking the cams",
];

const setRandomPresence = (client) => {
  const phrase = idlePhrases[Math.floor(Math.random() * idlePhrases.length)];
  client.user.setPresence({
    activities: [{ name: phrase, type: ActivityType.Custom }],
    status: "online",
  });
};

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
  await postAmongUsDashboard(client);

  connectWebSocket({
    onStatsUpdate: updateDashboardWithStats,
    onConsoleUpdate: updateDashboardWithConsole,
  });

  initUptimeMonitor(client);

  setRandomPresence(readyClient);
  setInterval(() => setRandomPresence(readyClient), 300000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
      await handleSlashCommand(interaction);
    } else {
      const handledByAmongUs = await handleAmongUsInteraction(interaction);
      if (!handledByAmongUs) {
        await handleMinecraftInteraction(interaction);
      }
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

/**
 * Handles graceful shutdown of the NexKord-ADM client.
 * Destroys the client and exits the process.
 */
const shutdown = () => {
  console.log("[NexKord - ADM] Shutting down gracefully...");
  client.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
