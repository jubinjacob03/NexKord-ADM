import { Client, Events, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize the Discord client with only the necessary intents to save memory
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once(Events.ClientReady, (readyClient) => {
    console.log(`[NexKord - ADM] Successfully logged in as ${readyClient.user.tag}`);
    console.log('[NexKord - ADM] Bot is online and running on extreme low-memory profile.');
});

// Basic message listener
client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;

    if (message.content === '!ping') {
        message.reply('Pong! NexKord - ADM is online.');
    }
});

// Login using token from environment
client.login(process.env.DISCORD_TOKEN);
