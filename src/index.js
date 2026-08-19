import { Client, Events, GatewayIntentBits, ActivityType } from "discord.js";
import dotenv from "dotenv";
import { initBotLogger } from "./utils/logger.js";
import { handleSlashCommand } from "./commands.js";
import {
  initAkinator,
  handleAkinatorMessage,
  handleAkinatorButton,
} from "./games/akinator/game.js";
import { closeClient } from "./games/akinator/tlsClient.js";
import {
  initCinema,
  handleCinemaButton,
  handleCinemaModal,
  handleCinemaSelect,
} from "./games/cinema/controller.js";
import { initIcons } from "./utils/icons.js";

dotenv.config();

const idlePhrases = [
  "online",
  "cooling the CPU",
  "brewing potions",
  "floating in the void",
  "handling commands",
  "running game sessions",
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
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojisAndStickers,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  await initIcons(readyClient);
  console.log(
    `[NexKord - ADM] Successfully logged in as ${readyClient.user.tag}`,
  );
  console.log(
    "[NexKord - ADM] Bot is online and running on extreme low-memory profile.",
  );

  await initAkinator(client);
  await initCinema(client);

  setRandomPresence(readyClient);
  setInterval(() => setRandomPresence(readyClient), 300000);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleAkinatorMessage(message);
  } catch (error) {
    console.error("[Akinator] message handler error:", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
      await handleSlashCommand(interaction);
      return;
    }
    const handledByCinema = await handleCinemaButton(interaction);
    if (handledByCinema) return;
    const handledByCinemaModal = await handleCinemaModal(interaction);
    if (handledByCinemaModal) return;
    const handledByCinemaSelect = await handleCinemaSelect(interaction);
    if (handledByCinemaSelect) return;
    await handleAkinatorButton(interaction);
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

const shutdown = async () => {
  console.log("[NexKord - ADM] Shutting down gracefully...");
  await closeClient().catch(() => {});
  client.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
