import { REST, Routes } from "discord.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

function clientIdFromToken(token) {
  if (!token) return "";
  return Buffer.from(token.split(".")[0], "base64").toString();
}

const BOTS = [
  { name: "NexKord-ADM", token: process.env.DISCORD_TOKEN, clientId: process.env.CLIENT_ID },
  { name: "Zyra", token: process.env.ZYRA_TOKEN, clientId: process.env.ZYRA_CLIENT_ID },
  { name: "Shantha", token: process.env.SHANTHA_TOKEN, clientId: process.env.SHANTHA_CLIENT_ID },
  { name: "Music-I", token: process.env.MUSIC1_TOKEN, clientId: clientIdFromToken(process.env.MUSIC1_TOKEN) },
  { name: "Music-II", token: process.env.MUSIC2_TOKEN, clientId: clientIdFromToken(process.env.MUSIC2_TOKEN) },
  { name: "Music-III", token: process.env.MUSIC3_TOKEN, clientId: clientIdFromToken(process.env.MUSIC3_TOKEN) },
].filter((b) => b.token);

const emojiDirs = [
  path.join(process.cwd(), "assets", "server-emojis"),
  path.join(process.cwd(), "assets", "cinema"),
];

function loadLocalEmojis() {
  const emojis = new Map();
  for (const dir of emojiDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".png") && !file.endsWith(".gif")) continue;
      const name = file.replace(/\.(png|gif)$/, "");
      const ext = file.endsWith(".gif") ? "gif" : "png";
      emojis.set(name, {
        file: path.join(dir, file),
        mime: ext === "gif" ? "image/gif" : "image/png",
      });
    }
  }
  return emojis;
}

async function verifyAndFix() {
  const localEmojis = loadLocalEmojis();
  console.log(`\nLocal emoji files: ${localEmojis.size}\n`);

  for (const bot of BOTS) {
    const rest = new REST({ version: "10" }).setToken(bot.token);

    let remote;
    try {
      remote = await rest.get(Routes.applicationEmojis(bot.clientId));
    } catch (err) {
      console.log(`[${bot.name}] FAILED to fetch: ${err.message}`);
      continue;
    }

    const remoteNames = new Set(remote.items.map((e) => e.name));
    const missing = [];
    for (const [name] of localEmojis) {
      if (!remoteNames.has(name)) missing.push(name);
    }

    const extra = [];
    for (const e of remote.items) {
      if (!localEmojis.has(e.name)) extra.push(e.name);
    }

    console.log(
      `[${bot.name}] Remote: ${remote.items.length} | Missing: ${missing.length} | Extra: ${extra.length}`,
    );

    if (missing.length > 0) {
      console.log(`  Missing: ${missing.join(", ")}`);
      for (const name of missing) {
        const local = localEmojis.get(name);
        const data = fs.readFileSync(local.file);
        const dataUri = `data:${local.mime};base64,${data.toString("base64")}`;
        try {
          await rest.post(Routes.applicationEmojis(bot.clientId), {
            body: { name, image: dataUri },
          });
          console.log(`  [UPLOADED] ${name}`);
        } catch (err) {
          const msg = err.rawError?.message || err.message;
          if (msg.includes("Maximum number")) {
            console.log(`  [LIMIT] ${bot.name} hit emoji cap`);
            break;
          }
          console.log(`  [FAILED] ${name}: ${msg}`);
        }
      }
    }

    if (extra.length > 0) {
      console.log(`  Extra (on remote but not local): ${extra.join(", ")}`);
    }
  }

  console.log("\nDone.");
}

verifyAndFix();
