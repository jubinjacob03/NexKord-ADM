import {
  Client,
  Events,
  GatewayIntentBits,
  ActivityType,
  MessageFlags,
} from "discord.js";
import dotenv from "dotenv";
import { initBotLogger } from "./utils/logger.js";
import { handleSlashCommand } from "./commands.js";
import {
  initAkinator,
  handleAkinatorMessage,
  handleAkinatorButton,
  shutdownAkinator,
} from "./games/akinator/game.js";
import {
  initCinema,
  handleCinemaButton,
  handleCinemaModal,
  handleCinemaSelect,
  shutdownCinema,
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
  allowedMentions: { parse: [], repliedUser: false },
});

let initialized = false;
let presenceTimer = null;
let shutdownPromise = null;

async function initialize(readyClient) {
  if (initialized) return;
  initialized = true;

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
  presenceTimer = setInterval(() => setRandomPresence(readyClient), 300000);
  presenceTimer.unref?.();
}

async function shutdown(exitCode = 0) {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      console.log("[NexKord - ADM] Shutting down gracefully...");
      if (presenceTimer) {
        clearInterval(presenceTimer);
        presenceTimer = null;
      }
      await Promise.allSettled([shutdownCinema(), shutdownAkinator()]);
      client.destroy();
    })();
  }
  await shutdownPromise;
  process.exit(exitCode);
}

async function respondToInteractionFailure(interaction) {
  try {
    if (interaction.isAutocomplete()) {
      if (!interaction.responded) await interaction.respond([]);
      return;
    }
    if (!interaction.isRepliable()) return;

    const content = "The interaction could not be completed. Please try again.";
    const ephemeralPayload = {
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [], repliedUser: false },
    };

    if (interaction.deferred) {
      try {
        await interaction.editReply({ content, components: [] });
      } catch {
        await interaction.followUp(ephemeralPayload);
      }
      return;
    }
    if (interaction.replied) {
      await interaction.followUp(ephemeralPayload);
      return;
    }
    await interaction.reply(ephemeralPayload);
  } catch (error) {
    console.error("[Interaction] Could not send failure response:", error);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  initialize(readyClient).catch((error) => {
    console.error("[FATAL] Initialization failed:", error);
    void shutdown(1);
  });
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
    await respondToInteractionFailure(interaction);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  void shutdown(1);
});

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught Exception:", error);
  void shutdown(1);
});

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error("[FATAL] Login failed:", error?.message ?? error);
  void shutdown(1);
});

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
