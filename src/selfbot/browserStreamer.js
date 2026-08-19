import puppeteer from "puppeteer";
import { config } from "./config.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "stylesheet"]);

const FATAL_NAVIGATION_ERRORS = [
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_SSL_PROTOCOL_ERROR",
];

const PLAY_SELECTORS = [
  ".vjs-big-play-button",
  ".jw-display-icon-container",
  ".jw-icon-play",
  ".plyr__control--overlaid",
  '[aria-label="Play"]',
  '[title="Play"]',
  ".play",
  ".play-btn",
  "#play-btn",
  "video",
];

function scoreCandidate(url) {
  if (/\.m3u8(\?|$)/i.test(url))
    return /master|index|playlist/i.test(url) ? 5 : 4;
  if (/\.mpd(\?|$)/i.test(url)) return 3;
  if (/\.(mp4|mkv|webm)(\?|$)/i.test(url)) return 2;
  return 0;
}

export class StreamUrlExtractor {
  constructor() {
    this.browser = null;
    this.launching = null;
  }

  async ensureBrowser() {
    if (this.browser?.connected) return this.browser;
    if (this.launching) return this.launching;

    this.launching = puppeteer
      .launch({
        headless: true,
        ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}),
        args: [
          "--autoplay-policy=no-user-gesture-required",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          "--allow-running-insecure-content",
          "--mute-audio",
        ],
      })
      .then((browser) => {
        this.browser = browser;
        browser.on("disconnected", () => {
          this.browser = null;
        });
        return browser;
      })
      .finally(() => {
        this.launching = null;
      });

    return this.launching;
  }

  async extractStreamUrl(embedUrl, options = {}) {
    const timeout = options.timeout ?? 45000;
    const deadline = Date.now() + timeout;
    const origin = new URL(embedUrl).origin;

    console.log(
      `[URL EXTRACTOR] Extracting direct stream URL from: ${embedUrl}`,
    );

    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    const candidates = new Set();

    const closePopup = async (target) => {
      if (target.type() !== "page") return;
      const opened = await target.page().catch(() => null);
      if (opened && opened !== page) await opened.close().catch(() => {});
    };
    browser.on("targetcreated", closePopup);

    try {
      await page.setUserAgent(USER_AGENT);
      await page.setRequestInterception(true);

      page.on("request", (request) => {
        const url = request.url();
        if (scoreCandidate(url) > 0) candidates.add(url);

        if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
          request.abort().catch(() => {});
          return;
        }
        request.continue().catch(() => {});
      });

      page.on("response", (response) => {
        const url = response.url();
        const contentType = (
          response.headers()["content-type"] || ""
        ).toLowerCase();
        if (
          contentType.includes("mpegurl") ||
          contentType.includes("dash+xml") ||
          contentType.includes("video/mp4") ||
          scoreCandidate(url) > 0
        ) {
          candidates.add(url);
        }
      });

      const navigationError = await page
        .goto(embedUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(5000, deadline - Date.now()),
        })
        .then(() => null)
        .catch((err) => err);

      if (navigationError) {
        const fatal = FATAL_NAVIGATION_ERRORS.some((code) =>
          navigationError.message.includes(code),
        );
        console.warn(
          `[URL EXTRACTOR] Navigation ${fatal ? "failed" : "warning"}: ${navigationError.message}`,
        );
        if (fatal) return null;
      }

      while (candidates.size === 0 && Date.now() < deadline) {
        await this.triggerPlayback(page);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      if (candidates.size === 0) {
        const domUrl = await this.readVideoElementSource(page);
        if (domUrl) candidates.add(domUrl);
      }

      let best = null;
      let bestScore = -1;
      for (const url of candidates) {
        const s = scoreCandidate(url);
        if (s > bestScore) {
          bestScore = s;
          best = url;
        }
      }

      if (!best) {
        console.warn(
          `[URL EXTRACTOR] No direct stream URL found for: ${embedUrl}`,
        );
        return null;
      }

      // The player already decoded metadata, so the real dimensions are right
      // there. Reading them here avoids a slow, flaky second ffprobe round trip
      // against a cold CDN.
      const dimensions = await this.readVideoDimensions(page);
      if (dimensions) {
        console.log(
          `[URL EXTRACTOR] Player reports ${dimensions.width}x${dimensions.height}`,
        );
      }

      console.log(
        `[URL EXTRACTOR] Selected stream (${candidates.size} candidates): ${best}`,
      );
      return {
        url: best,
        referer: `${origin}/`,
        origin,
        userAgent: USER_AGENT,
        ...dimensions,
      };
    } finally {
      browser.off("targetcreated", closePopup);
      await page.close().catch(() => {});
    }
  }

  async triggerPlayback(page) {
    await page
      .evaluate((selectors) => {
        const activate = (doc) => {
          for (const selector of selectors) {
            for (const el of doc.querySelectorAll(selector)) {
              try {
                el.click();
              } catch {
                /* element not clickable */
              }
            }
          }
          const video = doc.querySelector("video");
          if (video) {
            video.muted = true;
            video.play().catch(() => {});
          }
        };

        activate(document);

        for (const frame of document.querySelectorAll("iframe")) {
          try {
            const doc = frame.contentDocument || frame.contentWindow?.document;
            if (doc) activate(doc);
          } catch {
            /* cross-origin frame */
          }
        }
      }, PLAY_SELECTORS)
      .catch(() => {});
  }

  async readVideoDimensions(page, attempts = 6) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const dims = await page
        .evaluate(() => {
          for (const video of document.querySelectorAll("video")) {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              return { width: video.videoWidth, height: video.videoHeight };
            }
          }
          return null;
        })
        .catch(() => null);

      if (dims) return dims;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  async readVideoElementSource(page) {
    return page
      .evaluate(() => {
        const matches = (value) =>
          value && /\.(m3u8|mpd|mp4|mkv|webm)(\?|$)/i.test(value);
        for (const video of document.querySelectorAll("video")) {
          if (matches(video.src)) return video.src;
          for (const source of video.querySelectorAll("source")) {
            if (matches(source.src)) return source.src;
          }
        }
        return null;
      })
      .catch(() => null);
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
  }
}
