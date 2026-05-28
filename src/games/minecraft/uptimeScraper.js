import puppeteerCore from 'puppeteer-core';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
dotenv.config();

puppeteerExtra.use(StealthPlugin());

/**
 * Scrapes the remaining uptime from FreeGameHost.
 * Returns the time string (e.g., "01:30:45") or null on failure.
 */
export async function scrapeUptime() {
    const uuid = process.env.FREEGAMEHOST_SERVER_UUID;
    const sessionCookie = process.env.FGH_SESSION_COOKIE;
    const rememberCookieName = process.env.FGH_REMEMBER_COOKIE_NAME;
    const rememberCookieValue = process.env.FGH_REMEMBER_COOKIE_VALUE;

    if (!uuid || !sessionCookie) {
        console.error('[UptimeScraper] Missing credentials in .env!');
        return null;
    }

    let browser = null;
    try {
        browser = await puppeteerExtra.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
            headless: 'new',
            timeout: 60000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        
        // Increase the default navigation timeout globally
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);

        // Block heavy resources to save RAM and bandwidth
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const cookies = [{
            name: 'pterodactyl_session',
            value: sessionCookie,
            domain: 'panel.freegamehost.xyz',
            path: '/',
            httpOnly: true,
            secure: true
        }];

        if (rememberCookieName && rememberCookieValue) {
            cookies.push({
                name: rememberCookieName,
                value: rememberCookieValue,
                domain: 'panel.freegamehost.xyz',
                path: '/',
                httpOnly: true,
                secure: true
            });
        }

        await page.setCookie(...cookies);
        
        const url = `https://panel.freegamehost.xyz/server/${uuid}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for the time string to appear
        await page.waitForFunction(() => {
            return document.body.innerText.match(/\b\d{2}:\d{2}:\d{2}\b/);
        });

        const timeRemaining = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            const timeMatch = bodyText.match(/\b\d{2}:\d{2}:\d{2}\b/);
            return timeMatch ? timeMatch[0] : null;
        });

        await browser.close();
        return timeRemaining;

    } catch (error) {
        console.error(`[UptimeScraper] Error: ${error.message}`);
        if (browser) {
            await browser.close().catch(() => {});
        }
        return null;
    }
}
