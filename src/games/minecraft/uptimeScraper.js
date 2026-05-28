import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

let isScraping = false;

/**
 * Scrapes the remaining uptime from FreeGameHost API.
 * Returns the time string (e.g., "01:30:45") or null on failure.
 */
export async function scrapeUptime() {
    if (isScraping) {
        console.log('[UptimeScraper] Scrape already in progress. Skipping...');
        return null;
    }

    const uuid = process.env.FREEGAMEHOST_SERVER_UUID;
    const apiKey = process.env.PTERODACTYL_API_KEY;

    if (!uuid || !apiKey) {
        console.error('[UptimeScraper] Missing PTERODACTYL_API_KEY or FREEGAMEHOST_SERVER_UUID in .env!');
        return null;
    }

    isScraping = true;
    try {
        // 1. We need the full UUID, but .env usually has the short identifier. 
        // Let's dynamically fetch the full UUID from the Pterodactyl API first.
        const serverRes = await axios.get(`https://panel.freegamehost.xyz/api/client/servers/${uuid}`, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json'
            },
            timeout: 10000
        });
        
        const fullUuid = serverRes.data.attributes.uuid;

        // 2. Fetch the FreeGameHost internal timer API directly
        const infoRes = await axios.get(`https://panel.freegamehost.xyz/api/client/freeservers/${fullUuid}/info`, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json'
            },
            timeout: 10000
        });

        const expireTimestamp = infoRes.data.data.expire;
        if (!expireTimestamp) {
            console.error('[UptimeScraper] Could not find expire timestamp in API response.');
            isScraping = false;
            return null;
        }

        // 3. Calculate remaining time
        const msRemaining = Math.max(0, expireTimestamp - Date.now());
        const hours = Math.floor(msRemaining / (1000 * 60 * 60));
        const minutes = Math.floor((msRemaining % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((msRemaining % (1000 * 60)) / 1000);

        const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        
        isScraping = false;
        return timeStr;

    } catch (error) {
        if (error.response?.status === 401 || error.response?.status === 403) {
            console.error('[UptimeScraper] API Key rejected (401/403)! Please check your PTERODACTYL_API_KEY.');
        } else {
            console.error(`[UptimeScraper] API Error: ${error.message}`);
        }
        isScraping = false;
        return null;
    }
}
