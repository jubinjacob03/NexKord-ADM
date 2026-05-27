import { scrapeUptime } from './uptimeScraper.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const CACHE_PATH = path.join(process.cwd(), 'data', 'uptimeCache.json');

// Thresholds in minutes
const THRESHOLDS = [
    { name: '2hours', mins: 120, color: '#f1c40f', title: 'ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ᴛᴡᴏ ʜᴏᴜʀꜱ ʟᴇꜰᴛ' },
    { name: '1hour', mins: 60, color: '#e67e22', title: 'ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ᴏɴᴇ ʜᴏᴜʀ ʟᴇꜰᴛ' },
    { name: '30mins', mins: 30, color: '#e74c3c', title: 'ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ᴛʜɪʀᴛʏ ᴍɪɴꜱ ʟᴇꜰᴛ' },
    { name: '15mins', mins: 15, color: '#c0392b', title: 'ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ꜰɪꜰᴛᴇᴇɴ ᴍɪɴꜱ ʟᴇꜰᴛ' },
    { name: '10mins', mins: 10, color: '#992d22', title: 'ꜱᴇʀᴠᴇʀ ʀᴇɴᴇᴡᴀʟ: ᴛᴇɴ ᴍɪɴꜱ ʟᴇꜰᴛ' },
    { name: '5mins', mins: 5, color: '#000000', title: 'ᴄʀɪᴛɪᴄᴀʟ: ꜰɪᴠᴇ ᴍɪɴꜱ ʟᴇꜰᴛ!' },
    { name: 'expired', mins: 0, color: '#ffffff', title: 'ꜱᴇʀᴠᴇʀ ᴇxᴘɪʀᴇᴅ / ʜɪʙᴇʀɴᴀᴛᴇᴅ' }
];

function ensureCacheDir() {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function readCache() {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('[UptimeMonitor] Failed to read cache:', e.message);
    }
    return { lastChecked: 0, scrapedMins: 0, syncs: {}, alerts: {} };
}

function writeCache(data) {
    try {
        ensureCacheDir();
        fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[UptimeMonitor] Failed to write cache:', e.message);
    }
}

function parseTimeToMinutes(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':').map(Number);
    if (parts.length !== 3) return null;
    return (parts[0] * 60) + parts[1] + (parts[2] / 60);
}

function formatMinutesToStr(mins) {
    if (mins <= 0) return '00:00:00';
    const h = Math.floor(mins / 60);
    const m = Math.floor(mins % 60);
    const s = Math.floor((mins * 60) % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

async function sendAlert(client, threshold, estimatedMins) {
    const roleId = process.env.FGH_MOD_ROLE_ID;
    const serverUrl = process.env.FGH_SERVER_URL;

    if (!roleId) {
        console.error('[UptimeMonitor] FGH_MOD_ROLE_ID not found in .env');
        return;
    }

    const exactTimeStr = formatMinutesToStr(estimatedMins);

    const embed = new EmbedBuilder()
        .setDescription(`# ${threshold.title}\n\n### ⏳ Estimated Uptime: \`${exactTimeStr}\`\n> Failure to renew will result in the server shutting down and requiring a manual start.\n\n### Action Required\n\nClick the **Renew Server** button below and click **+ 8 HOURS**.`)
        .setColor(threshold.color)
        .setImage('https://raw.githubusercontent.com/jubinjacob03/jubinjacob03/main/Public-CDN/mc-banner-slim.jpeg')
        .setFooter({ text: 'Automated Renewal System • NexKord' })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Renew Server Now')
            .setURL(serverUrl || 'https://panel.freegamehost.xyz')
            .setStyle(ButtonStyle.Link)
    );

    let dmsSent = 0;
    client.guilds.cache.forEach(guild => {
        const role = guild.roles.cache.get(roleId);
        if (role) {
            role.members.forEach(member => {
                if (!member.user.bot) {
                    member.send({ embeds: [embed], components: [row] }).catch(() => {});
                    dmsSent++;
                }
            });
        }
    });

    console.log(`[UptimeMonitor] Sent ${threshold.name} alert to ${dmsSent} moderators.`);
}

async function syncWithPuppeteer(cache) {
    console.log('[UptimeMonitor] 🚀 Launching Puppeteer to sync true server time...');
    const timeStr = await scrapeUptime();
    
    if (!timeStr) {
        console.log('[UptimeMonitor] ❌ Scrape failed. Retrying next tick.');
        return cache;
    }

    const newMins = parseTimeToMinutes(timeStr);
    console.log(`[UptimeMonitor] ✅ Scrape success: ${timeStr} (~${Math.floor(newMins)} mins)`);

    // Check if the user manually renewed the server (time jumped back up significantly)
    // E.g., if we expected 120 mins but we see 500 mins, they renewed it.
    if (newMins > (cache.scrapedMins || 0) + 60) {
        console.log('[UptimeMonitor] 🔄 Time replenished (Manual Renewal detected)! Resetting states.');
        cache.syncs = {};
        cache.alerts = {};
    }

    cache.scrapedMins = newMins;
    cache.lastChecked = Date.now();
    return cache;
}

async function checkTick(client) {
    let cache = readCache();

    // 1. Calculate Estimated Time
    const minutesSinceLastCheck = (Date.now() - cache.lastChecked) / 60000;
    let estimatedMins = cache.scrapedMins - minutesSinceLastCheck;

    // Force an initial sync if the cache is empty or super old (e.g. bot was offline for 24h)
    if (!cache.lastChecked || estimatedMins < -100 || estimatedMins > 1000) {
        cache = await syncWithPuppeteer(cache);
        writeCache(cache);
        return;
    }

    // Sort thresholds from lowest (0) to highest (120)
    const sortedThresholds = [...THRESHOLDS].sort((a, b) => a.mins - b.mins);

    // 2. Determine if we need to Sync (launch Puppeteer 5 mins BEFORE a threshold)
    for (const t of sortedThresholds) {
        const syncLimit = t.mins + 5; 
        if (estimatedMins <= syncLimit && !cache.syncs[t.name]) {
            // We are within 5 mins of this threshold, and haven't synced for it yet.
            console.log(`[UptimeMonitor] Estimated time (~${Math.floor(estimatedMins)}m) is approaching the ${t.name} threshold.`);
            
            cache = await syncWithPuppeteer(cache);
            
            // Mark this threshold and all HIGHER thresholds as synced
            for (const upper of THRESHOLDS) {
                if (upper.mins >= t.mins) {
                    cache.syncs[upper.name] = true;
                }
            }
            writeCache(cache);
            
            // Recalculate estimated mins with the fresh data
            estimatedMins = cache.scrapedMins;
            break; 
        }
    }

    // 3. Determine if we need to Alert (if estimated time crosses the exact threshold)
    for (const t of sortedThresholds) {
        if (estimatedMins <= t.mins) {
            if (!cache.alerts[t.name]) {
                await sendAlert(client, t, estimatedMins);
                
                // Mark this and all HIGHER thresholds as alerted
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

export function initUptimeMonitor(client) {
    console.log('[UptimeMonitor] Initialized Time-Decay Cache. Math ticks every 1 minute.');
    ensureCacheDir();
    
    // Check after 5 seconds to bootstrap if needed
    setTimeout(() => checkTick(client), 5000);

    // Tick every 60 seconds
    setInterval(() => checkTick(client), 60000);
}
