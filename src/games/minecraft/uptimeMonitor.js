import { scrapeUptime } from "./uptimeScraper.js";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { icon } from "../../utils/icons.js";
dotenv.config();

const CACHE_PATH = path.join(process.cwd(), "data", "uptimeCache.json");

const THRESHOLDS = [
  {
    name: "2hours",
    mins: 120,
    color: "#f1c40f",
    title: "ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ᴛᴡᴏ ʜᴏᴜʀꜱ ʟᴇꜰᴛ",
  },
  {
    name: "1hour",
    mins: 60,
    color: "#e67e22",
    title: "ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ᴏɴᴇ ʜᴏᴜʀ ʟᴇꜰᴛ",
  },
  {
    name: "30mins",
    mins: 30,
    color: "#e74c3c",
    title: "ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ᴛʜɪʀᴛʏ ᴍɪɴꜱ ʟᴇꜰᴛ",
  },
  {
    name: "15mins",
    mins: 15,
    color: "#c0392b",
    title: "ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ꜰɪꜰᴛᴇᴇɴ ᴍɪɴꜱ ʟᴇꜰᴛ",
  },
  {
    name: "10mins",
    mins: 10,
    color: "#992d22",
    title: "ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ᴛᴇɴ ᴍɪɴꜱ ʟᴇꜰᴛ",
  },
  {
    name: "5mins",
    mins: 5,
    color: "#000000",
    title: "ᴄʀɪᴛɪᴄᴀʟ: ꜰɪᴠᴇ ᴍɪɴꜱ ʟᴇꜰᴛ!",
  },
  {
    name: "expired",
    mins: 0,
    color: "#ffffff",
    title: "ꜱᴇʀᴠᴇʀ ᴇxᴘɪʀᴇᴅ / ʜɪʙᴇʀɴᴀᴛᴇᴅ",
  },
];

/**
 * Ensures the cache directory exists, creating it recursively if needed.
 * @returns {void}
 */
function ensureCacheDir() {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Reads the persisted uptime cache, returning defaults when missing or unreadable.
 * @returns {{lastChecked:number, scrapedMins:number, syncs:object, alerts:object}}
 */
function readCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    }
  } catch (e) {
    console.error("[UptimeMonitor] Failed to read cache:", e.message);
  }
  return { lastChecked: 0, scrapedMins: 0, syncs: {}, alerts: {} };
}

/**
 * Persists the uptime cache to disk.
 * @param {object} data Cache object to serialise.
 * @returns {void}
 */
function writeCache(data) {
  try {
    ensureCacheDir();
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("[UptimeMonitor] Failed to write cache:", e.message);
  }
}

/**
 * Parses an "HH:MM:SS" string into a total number of minutes.
 * @param {string} timeStr
 * @returns {number|null} Total minutes, or null if the input is malformed.
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(":").map(Number);
  if (parts.length !== 3) return null;
  return parts[0] * 60 + parts[1] + parts[2] / 60;
}

/**
 * Formats a minute count back into an "HH:MM:SS" string (clamped at zero).
 * @param {number} mins
 * @returns {string}
 */
function formatMinutesToStr(mins) {
  if (mins <= 0) return "00:00:00";
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  const s = Math.floor((mins * 60) % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * DMs every moderator (resolved by role) a renewal-reminder card for the given
 * threshold, with a link button to the server panel.
 * @param {import('discord.js').Client} client
 * @param {{name:string, mins:number, color:string, title:string}} threshold
 * @param {number} estimatedMins Estimated minutes of uptime remaining.
 * @returns {Promise<void>}
 */
async function sendAlert(client, threshold, estimatedMins) {
  const roleId = process.env.FGH_MOD_ROLE_ID;
  const serverUrl = process.env.FGH_SERVER_URL;

  if (!roleId) {
    console.error("[UptimeMonitor] FGH_MOD_ROLE_ID not found in .env");
    return;
  }

  const exactTimeStr = formatMinutesToStr(estimatedMins);

  const embed = new EmbedBuilder()
    .setDescription(
      `# ${threshold.title}\n\n### ${icon("PENDING")} Estimated Uptime: \`${exactTimeStr}\`\n> Failure to renew will result in the server shutting down and requiring a manual start.\n\n### Action Required\n\nClick the **Renew Server** button below and click **+ 8 HOURS**.`,
    )
    .setColor(threshold.color)
    .setImage(
      "https://raw.githubusercontent.com/jubinjacob03/jubinjacob03/main/Public-CDN/mc-banner-slim.jpeg",
    )
    .setFooter({ text: "Automated Renewal System • NexKord" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Renew Server Now")
      .setURL(serverUrl || "https://panel.freegamehost.xyz")
      .setStyle(ButtonStyle.Link),
  );

  let dmsSent = 0;
  client.guilds.cache.forEach((guild) => {
    const role = guild.roles.cache.get(roleId);
    if (role) {
      role.members.forEach((member) => {
        if (!member.user.bot) {
          member.send({ embeds: [embed], components: [row] }).catch(() => {});
          dmsSent++;
        }
      });
    }
  });

  console.log(
    `[UptimeMonitor] Sent ${threshold.name} alert to ${dmsSent} moderators.`,
  );
}

/**
 * Fetches the true remaining uptime from the FreeGameHost API and updates the
 * cache, resetting per-threshold sync/alert state when a manual renewal is
 * detected (a jump of more than an hour).
 * @param {object} cache
 * @returns {Promise<{cache:object, success:boolean}>}
 */
async function syncServerTime(cache) {
  console.log("[UptimeMonitor] 🔄 Syncing true server time via FreeGameHost API...");
  const timeStr = await scrapeUptime();

  if (!timeStr) {
    console.log("[UptimeMonitor] ❌ Scrape failed. Retrying next tick.");
    return { cache, success: false };
  }

  const newMins = parseTimeToMinutes(timeStr);
  console.log(
    `[UptimeMonitor] ✅ Scrape success: ${timeStr} (~${Math.floor(newMins)} mins)`,
  );

  if (newMins > (cache.scrapedMins || 0) + 60) {
    console.log(
      "[UptimeMonitor] 🔄 Time replenished (Manual Renewal detected)! Resetting states.",
    );
    cache.syncs = {};
    cache.alerts = {};
  }

  cache.scrapedMins = newMins;
  cache.lastChecked = Date.now();
  return { cache, success: true };
}

/**
 * One monitor tick: estimates remaining uptime from the time-decaying cache,
 * re-syncs with the API when stale or nearing a threshold, and fires each
 * moderator alert once as the deadline approaches.
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function checkTick(client) {
  let cache = readCache();

  const minutesSinceLastCheck = (Date.now() - cache.lastChecked) / 60000;
  let estimatedMins = cache.scrapedMins - minutesSinceLastCheck;

  if (!cache.lastChecked || estimatedMins < -100 || minutesSinceLastCheck > 60) {
    const result = await syncServerTime(cache);
    cache = result.cache;
    writeCache(cache);
    return;
  }

  const sortedThresholds = [...THRESHOLDS].sort((a, b) => a.mins - b.mins);

  for (const t of sortedThresholds) {
    const syncLimit = t.mins + 5;
    if (estimatedMins <= syncLimit && !cache.syncs[t.name]) {
      console.log(
        `[UptimeMonitor] Estimated time (~${Math.floor(estimatedMins)}m) is approaching the ${t.name} threshold.`,
      );

      const result = await syncServerTime(cache);
      cache = result.cache;

      if (result.success) {
        for (const upper of THRESHOLDS) {
          if (upper.mins >= t.mins) {
            cache.syncs[upper.name] = true;
          }
        }
        estimatedMins = cache.scrapedMins;
      } else {
        console.log(`[UptimeMonitor] Sync failed for ${t.name} threshold. Will retry next tick.`);
      }
      
      writeCache(cache);
      break;
    }
  }

  for (const t of sortedThresholds) {
    if (estimatedMins <= t.mins) {
      if (!cache.alerts[t.name]) {
        const verify = await syncServerTime(cache);
        if (verify.success) {
          cache = verify.cache;
          estimatedMins = cache.scrapedMins;
          writeCache(cache);
          if (estimatedMins > t.mins) continue;
        }
        await sendAlert(client, t, estimatedMins);

        for (const upper of THRESHOLDS) {
          if (upper.mins >= t.mins) {
            cache.alerts[upper.name] = true;
          }
        }
        writeCache(cache);
        break;
      }
    }
  }
}

/**
 * Initializes the uptime monitoring system, checking remaining server time
 * and sending alerts when approaching thresholds.
 * @param {import('discord.js').Client} client
 */
export function initUptimeMonitor(client) {
  console.log(
    "[UptimeMonitor] Initialized Time-Decay Cache. Math ticks every 1 minute.",
  );
  ensureCacheDir();

  setTimeout(() => checkTick(client), 5000);
  setInterval(() => checkTick(client), 60000);
}
