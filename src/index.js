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
import { handleSlashCommand } from "./commands.js";

dotenv.config();

initBotLogger();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, async (readyClient) => {
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

client.login(process.env.DISCORD_TOKEN);
