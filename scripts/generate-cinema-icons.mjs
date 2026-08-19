import { REST, Routes } from "discord.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import sharp from "sharp";

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const rest = new REST({ version: "10" }).setToken(TOKEN);

const RED = "#ff0033";
const SIZE = 128;

const ICONS = {
  c_film: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20"/><path d="M17 2v20"/><path d="M2 7h5"/><path d="M2 12h20"/><path d="M2 17h5"/><path d="M17 7h5"/><path d="M17 17h5"/></svg>`,

  c_clapperboard: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.2 6L3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,

  c_calendar: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/></svg>`,

  c_clock: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,

  c_screen: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>`,

  c_ticket: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>`,

  c_star: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
};

const outDir = path.join(process.cwd(), "assets", "cinema");

async function generateAndUpload() {
  fs.mkdirSync(outDir, { recursive: true });

  const existing = await rest.get(Routes.applicationEmojis(CLIENT_ID));
  const existingNames = new Set(existing.items.map((e) => e.name));

  for (const [name, svg] of Object.entries(ICONS)) {
    const filePath = path.join(outDir, `${name}.svg`);
    fs.writeFileSync(filePath, svg, "utf8");

    if (existingNames.has(name)) {
      console.log(`[SKIP] ${name} already exists as app emoji.`);
      continue;
    }

    const svgBuffer = Buffer.from(svg);
    const pngBuffer = await sharp(svgBuffer).resize(128, 128).png().toBuffer();
    const pngBase64 = pngBuffer.toString("base64");
    const dataUri = `data:image/png;base64,${pngBase64}`;

    fs.writeFileSync(path.join(outDir, `${name}.png`), pngBuffer);

    try {
      const result = await rest.post(Routes.applicationEmojis(CLIENT_ID), {
        body: { name, image: dataUri },
      });
      console.log(`[UPLOADED] ${name} -> id ${result.id}`);
    } catch (err) {
      console.error(`[FAILED] ${name}: ${err.message}`);
    }
  }

  console.log(`\nPNG files saved to ${outDir}`);
  console.log("Done. Restart the bot to pick up new emojis via initIcons().");
}

generateAndUpload();
