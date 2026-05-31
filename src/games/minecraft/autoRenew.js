import puppeteerCore from "puppeteer-core";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { auditLog } from "../../utils/logger.js";
import { icon } from "../../utils/icons.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isRenewing = false;

/**
 * Automates the renewal process for the FreeGameHost server using Puppeteer.
 * Handles authentication, Turnstile bypass, and renewal clicking.
 *
 * @param {import('discord.js').Client} client - The Discord client for sending notifications.
 */
export async function executeAutoRenew(client) {
  if (isRenewing) {
    console.log(
      "[Auto-Renew] Renewal already in progress. Skipping duplicate run.",
    );
    return;
  }

  const uuid = process.env.FREEGAMEHOST_SERVER_UUID;
  const sessionCookie = process.env.FGH_SESSION_COOKIE;

  if (!uuid || !sessionCookie) {
    auditLog(
      "error",
      "AUTORENEW",
      "Missing FGH credentials (UUID or Session Cookie). Auto-renew aborted.",
    );
    return;
  }

  isRenewing = true;
  auditLog("info", "AUTORENEW", "Starting headless auto-renewal sequence...");

  const channel = client.channels.cache.get(channelId);

  let browser = null;
  try {
    const userDataDir = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "data",
      "browser_profile",
    );

    puppeteerExtra.use(StealthPlugin());

    browser = await puppeteerExtra.launch({
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
      userDataDir: userDataDir,
      headless: "new",
      timeout: 60000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--mute-audio",
        "--disable-extensions",
        "--disable-background-networking",
        "--window-size=1280,800",
      ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    await page.setCookie({
      name: "pterodactyl_session",
      value: sessionCookie,
      domain: "panel.freegamehost.xyz",
      path: "/",
      httpOnly: true,
      secure: true,
    });

    const serverUrl = `https://panel.freegamehost.xyz/server/${uuid}`;
    await page.goto(serverUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    if (page.url().includes("/auth/login")) {
      auditLog(
        "error",
        "AUTORENEW",
        "Session expired! The session cookie is no longer valid. Cannot auto-renew.",
      );
      if (channel) {
        await channel.send({
          content: `${icon("WARNING")} **Autonomous Renewal Failed**\nThe session cookie has expired. Please grab a new \`pterodactyl_session\` cookie from your browser and update the \`.env\` file.`,
        });
      }
      return;
    } else {
      auditLog(
        "info",
        "AUTORENEW",
        "Session is active. Proceeding with renewal...",
      );
    }

    auditLog("info", "AUTORENEW", "Scanning for Renew button...");

    await new Promise((r) => setTimeout(r, 3000));

    const renewResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/client/freeservers/") &&
        response.url().includes("/renew") &&
        response.request().method() === "POST",
      { timeout: 45000 },
    );

    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const renewBtn = buttons.find(
        (b) =>
          (b.textContent.toLowerCase().includes("8 hours") ||
            b.textContent.toLowerCase().includes("renew")) &&
          !b.disabled,
      );

      if (renewBtn) {
        renewBtn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      auditLog(
        "warn",
        "AUTORENEW",
        "Renew button not found or is currently disabled (cooldown active).",
      );
      return;
    }

    auditLog(
      "info",
      "AUTORENEW",
      "Renew button clicked. Waiting for Cloudflare Turnstile bypass and API response...",
    );

    const response = await renewResponsePromise;
    const status = response.status();

    if (status === 200 || status === 204) {
      auditLog("info", "AUTORENEW", "Server successfully renewed (+8 hours).");
      if (channel) {
        await channel.send({
          content: `${icon("SUCCESS")} **Autonomous Renewal Successful**\nThe Minecraft server uptime has been extended by 8 hours.`,
        });
      }
    } else {
      const text = await response.text();
      throw new Error(`API returned HTTP ${status}: ${text}`);
    }
  } catch (error) {
    auditLog("error", "AUTORENEW", `Renewal failed: ${error.message}`);
    if (channel) {
      await channel.send({
        content: `${icon("WARNING")} **Autonomous Renewal Failed**\nAn error occurred while attempting to renew the server: \`${error.message}\``,
      });
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    isRenewing = false;
  }
}

/**
 * Initializes the auto-renewal background daemon.
 * Runs the renewal check every 6 hours.
 *
 * @param {import('discord.js').Client} client
 */
export function startAutoRenewDaemon(client) {
  const RENEWAL_INTERVAL = 6 * 60 * 60 * 1000;

  setTimeout(() => executeAutoRenew(client), 30000);

  setInterval(() => executeAutoRenew(client), RENEWAL_INTERVAL);

  auditLog(
    "info",
    "AUTORENEW",
    "Auto-renewal daemon started. Next check scheduled in 6 hours.",
  );
}
