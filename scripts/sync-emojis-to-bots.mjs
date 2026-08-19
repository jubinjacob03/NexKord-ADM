import { REST, Routes } from "discord.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const GUILD_ID = process.env.GUILD_ID || "1473075468088377346";
const ADM_TOKEN = process.env.DISCORD_TOKEN;
const outDir = path.join(process.cwd(), "assets", "server-emojis");

const BOTS = [
  {
    name: "NexKord-ADM",
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
  },
  {
    name: "Zyra",
    token: process.env.ZYRA_TOKEN,
    clientId: process.env.ZYRA_CLIENT_ID,
  },
  {
    name: "Shantha",
    token: process.env.SHANTHA_TOKEN,
    clientId: process.env.SHANTHA_CLIENT_ID,
  },
  {
    name: "NexKord Music I",
    token: process.env.MUSIC1_TOKEN,
    clientId: clientIdFromToken(process.env.MUSIC1_TOKEN),
  },
  {
    name: "NexKord Music II",
    token: process.env.MUSIC2_TOKEN,
    clientId: clientIdFromToken(process.env.MUSIC2_TOKEN),
  },
  {
    name: "NexKord Music III",
    token: process.env.MUSIC3_TOKEN,
    clientId: clientIdFromToken(process.env.MUSIC3_TOKEN),
  },
].filter((b) => b.token);

function clientIdFromToken(token) {
  if (!token) return "";
  return Buffer.from(token.split(".")[0], "base64").toString();
}

async function downloadGuildEmojis() {
  fs.mkdirSync(outDir, { recursive: true });
  const rest = new REST({ version: "10" }).setToken(ADM_TOKEN);
  const guild = await rest.get(Routes.guild(GUILD_ID));
  const emojis = await rest.get(Routes.guildEmojis(GUILD_ID));

  console.log(`[DOWNLOAD] ${emojis.length} emojis from ${guild.name}\n`);

  const downloaded = [];
  for (const emoji of emojis) {
    const ext = emoji.animated ? "gif" : "png";
    const url = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}?size=128&quality=lossless`;
    const filePath = path.join(outDir, `${emoji.name}.${ext}`);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  [SKIP] ${emoji.name}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buf);
      downloaded.push({
        name: emoji.name,
        filePath,
        ext,
        animated: emoji.animated || false,
      });
    } catch (err) {
      console.warn(`  [SKIP] ${emoji.name}: ${err.message}`);
    }
  }

  console.log(
    `[DOWNLOAD] Saved ${downloaded.length} emoji files to ${outDir}\n`,
  );
  return downloaded;
}

async function uploadToBot(bot, emojis) {
  const rest = new REST({ version: "10" }).setToken(bot.token);

  let existing;
  try {
    existing = await rest.get(Routes.applicationEmojis(bot.clientId));
  } catch (err) {
    console.log(`  [ERROR] Could not fetch existing emojis: ${err.message}`);
    return { uploaded: 0, skipped: 0, failed: 0 };
  }
  const existingNames = new Set(existing.items.map((e) => e.name));

  let uploaded = 0,
    skipped = 0,
    failed = 0;

  for (const emoji of emojis) {
    if (existingNames.has(emoji.name)) {
      skipped++;
      continue;
    }

    const mime = emoji.animated ? "image/gif" : "image/png";
    const data = fs.readFileSync(emoji.filePath);
    const dataUri = `data:${mime};base64,${data.toString("base64")}`;

    try {
      await rest.post(Routes.applicationEmojis(bot.clientId), {
        body: { name: emoji.name, image: dataUri },
      });
      uploaded++;
    } catch (err) {
      const msg = err.rawError?.message || err.message;
      if (msg.includes("Maximum number")) {
        console.log(
          `  [LIMIT] ${bot.name} hit emoji cap at ${uploaded + skipped} emojis.`,
        );
        break;
      }
      console.warn(`  [FAIL] ${emoji.name}: ${msg}`);
      failed++;
    }
  }

  return { uploaded, skipped, failed };
}

async function main() {
  const emojis = await downloadGuildEmojis();

  for (const bot of BOTS) {
    console.log(`[UPLOAD] ${bot.name} (${bot.clientId})`);
    const { uploaded, skipped, failed } = await uploadToBot(bot, emojis);
    console.log(
      `  ✓ ${uploaded} uploaded, ${skipped} already existed, ${failed} failed\n`,
    );
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
