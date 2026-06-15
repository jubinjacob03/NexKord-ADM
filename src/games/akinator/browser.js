import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import path from "path";
import { fileURLToPath } from "url";
import { auditLog } from "../../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Persistent Chromium profile dedicated to Akinator. Kept separate from the
 * auto-renew profile (data/browser_profile) because Chromium exclusively locks
 * a user-data-dir — two browsers cannot share one. Persisting it keeps Akinator's
 * cookie-consent acceptance and cache across restarts.
 */
const PROFILE_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "akinator_profile",
);

const LAUNCH_ARGS = [
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
  "--window-size=1280,900",
  "--dns-prefetch-disable",
  "--renderer-process-limit=1",
  "--js-flags=--max-old-space-size=192",
  "--blink-settings=imagesEnabled=false",
  "--disable-software-rasterizer",
  "--disable-default-apps",
  "--disable-sync",
  "--no-default-browser-check",
  "--disable-features=site-per-process,Translate,BackForwardCache,MediaRouter,OptimizationHints",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  ...(process.env.AKINATOR_PROXY
    ? [`--proxy-server=${process.env.AKINATOR_PROXY}`]
    : []),
];

puppeteerExtra.use(StealthPlugin());

let browser = null;
/** @type {Promise<import('puppeteer-core').Browser> | null} */
let launching = null;

/**
 * Returns the single dedicated Akinator browser, launching it lazily on first
 * use. Concurrent callers share one in-flight launch. The same instance (and its
 * persistent profile) is always reused until closeBrowser() is called.
 *
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
export async function getBrowser() {
  if (isConnected(browser)) return browser;
  if (launching) return launching;

  launching = (async () => {
    const b = await puppeteerExtra.launch({
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
      userDataDir: PROFILE_DIR,
      headless: "new",
      timeout: 60000,
      protocolTimeout: 240000,
      args: LAUNCH_ARGS,
    });
    b.on("disconnected", () => {
      if (browser === b) browser = null;
    });
    browser = b;
    auditLog("info", "AKINATOR", "Dedicated stealth browser launched.");
    return b;
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

/**
 * Closes the dedicated browser if open. Called on idle to free memory; the next
 * game relaunches it, reusing the same persistent profile.
 *
 * @returns {Promise<void>}
 */
export async function closeBrowser() {
  if (browser) {
    const b = browser;
    browser = null;
    try {
      await b.close();
      auditLog("info", "AKINATOR", "Dedicated browser closed (idle).");
    } catch (e) {
      auditLog("warn", "AKINATOR", `Browser close failed: ${e.message}`);
    }
  }
}

/**
 * Reports whether a browser instance is alive, tolerating the API change across
 * puppeteer versions (`isConnected()` method vs. the newer `connected` getter).
 * @param {import('puppeteer-core').Browser|null} b
 * @returns {boolean}
 */
function isConnected(b) {
  if (!b) return false;
  if (typeof b.isConnected === "function") return b.isConnected();
  return b.connected !== false;
}

/**
 * @returns {boolean} Whether the dedicated browser is currently open.
 */
export function isBrowserOpen() {
  return isConnected(browser);
}
