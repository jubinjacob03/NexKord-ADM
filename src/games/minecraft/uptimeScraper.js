import puppeteerCore from 'puppeteer-core';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
dotenv.config();

puppeteerExtra.use(StealthPlugin());

let isScraping = false;

/**
 * Scrapes the remaining uptime from FreeGameHost.
 * Returns the time string (e.g., "01:30:45") or null on failure.
 */
export async function scrapeUptime() {
    if (isScraping) {
        console.log('[UptimeScraper] Scrape already in progress. Skipping...');
        return null;
    }

    const uuid = process.env.FREEGAMEHOST_SERVER_UUID;
    const sessionCookie = process.env.FGH_SESSION_COOKIE;
    const rememberCookieName = process.env.FGH_REMEMBER_COOKIE_NAME;
    const rememberCookieValue = process.env.FGH_REMEMBER_COOKIE_VALUE;

    if (!uuid || !sessionCookie) {
        console.error('[UptimeScraper] Missing credentials in .env!');
        return null;
    }

    isScraping = true;
    let browser = null;

    const scrapePromise = async () => {
        browser = await puppeteerExtra.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
            userDataDir: '/tmp/puppeteer_uptime_data',
            headless: 'new',
            timeout: 60000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--mute-audio',
                '--disable-extensions',
                '--disable-background-networking',
                '--window-size=1280,800'
            ]
        });

        const page = await browser.newPage();
        
        // Fix for "Requesting main frame too early!" race condition in stealth plugin on slow VPS
        await new Promise(resolve => setTimeout(resolve, 5000));

        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

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
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        if (page.url().includes('/auth/login')) {
            console.error('[UptimeScraper] Session expired! Redirected to login page. Please update FGH_SESSION_COOKIE.');
            return null;
        }

        await page.waitForFunction(() => {
            return document.body.innerText.match(/\b\d{2}:\d{2}:\d{2}\b/);
        });

        const timeRemaining = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            const timeMatch = bodyText.match(/\b\d{2}:\d{2}:\d{2}\b/);
            return timeMatch ? timeMatch[0] : null;
        });

        return timeRemaining;
    };

    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Hard timeout of 65000ms reached!')), 65000);
    });

    try {
        const result = await Promise.race([scrapePromise(), timeoutPromise]);
        if (browser) {
            await browser.close().catch(() => {});
        }
        isScraping = false;
        return result;
    } catch (error) {
        console.error(`[UptimeScraper] Error: ${error.message}`);
        if (browser) {
            try {
                if (browser.process() && browser.process().pid) {
                    process.kill(browser.process().pid, 'SIGKILL');
                }
            } catch (killError) {
                // Ignore kill errors
            }
            await browser.close().catch(() => {});
        }
        isScraping = false;
        return null;
    }
}
