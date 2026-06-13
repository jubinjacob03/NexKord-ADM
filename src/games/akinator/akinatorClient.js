import path from "path";
import { fileURLToPath } from "url";
import { getBrowser } from "./browser.js";
import { auditLog } from "../../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEBUG_DIR = path.join(__dirname, "..", "..", "..", "logs");

const BASE = "https://en.akinator.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Canonical answer keys mapped to their on-page anchor IDs.
 * `probably_not` intentionally targets `a_probaly_not` to match a misspelling
 * present in Akinator's own markup.
 * @type {Record<string, string>}
 */
const ANSWER_IDS = {
  yes: "a_yes",
  no: "a_no",
  idk: "a_dont_know",
  probably: "a_probably",
  probably_not: "a_probaly_not",
};

/**
 * Supported themes mapped to their visible label on the theme-selection screen.
 * @type {Record<string, string>}
 */
const THEME_LABELS = {
  characters: "Characters",
  animals: "Animals",
  objects: "Objects",
};

/**
 * Resolves after the given delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives a single Akinator game on en.akinator.com through one browser page.
 * Holds no Discord state; one instance is created per game.
 */
export class AkinatorClient {
  constructor() {
    /** @type {import('puppeteer-core').Page | null} */
    this.page = null;
  }

  /**
   * Returns this game's page, creating it on the shared dedicated browser on
   * first use and reusing it thereafter.
   * @returns {Promise<import('puppeteer-core').Page>}
   */
  async _getPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    const browser = await getBrowser();
    this.page = await browser.newPage();
    await this.page.setUserAgent(UA);
    this.page.setDefaultNavigationTimeout(60000);
    this.page.setDefaultTimeout(60000);
    return this.page;
  }

  /**
   * Dismisses a cookie-consent dialog across the main document and every frame.
   * With the persistent profile this only fires on the first launch.
   * @returns {Promise<void>}
   */
  async _dismissConsent() {
    const re =
      "accept|agree|consent|got it|i understand|continue|j'accepte|tout accepter";
    for (const frame of this.page.frames()) {
      try {
        const handle = await frame.evaluateHandle((src) => {
          const r = new RegExp(src, "i");
          const els = [
            ...document.querySelectorAll('button,a,[role="button"],span,div'),
          ];
          return (
            els.find(
              (e) =>
                r.test((e.innerText || "").trim()) &&
                (e.innerText || "").trim().length < 40,
            ) || null
          );
        }, re);
        const el = handle.asElement();
        if (el) {
          await el.click().catch(() => {});
          await sleep(800);
        }
      } catch {
        continue;
      }
    }
  }

  /**
   * Reads the current step counter.
   * @returns {Promise<string|null>}
   */
  async _stepNum() {
    return this.page.evaluate(() => {
      const s = document.querySelector("#step-info");
      return s ? (s.innerText || "").trim() : null;
    });
  }

  /**
   * Reads the current screen, classifying it as a question, a guess proposal,
   * or a game-over (defeat) state. The proposal is checked first because it
   * overlays the question bubble.
   * @returns {Promise<{type:string, [key:string]: any}>}
   */
  async _readState() {
    return this.page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.visibility !== "hidden" &&
          s.display !== "none"
        );
      };

      const nameEl = document.querySelector("#name_proposition");
      if (isVisible(nameEl) && (nameEl.innerText || "").trim().length > 0) {
        const descEl = document.querySelector("#description_proposition");
        const stepEl = document.querySelector("#step-info");
        return {
          type: "guess",
          name: (nameEl.innerText || "").trim(),
          description: descEl ? (descEl.innerText || "").trim() : "",
          step: stepEl ? (stepEl.innerText || "").trim() : null,
        };
      }

      const bodyTxt = (document.body.innerText || "").replace(/\s+/g, " ");
      if (
        /you (have )?(beaten|defeated|won)|bravo|well played|i (give up|surrender)|you win/i.test(
          bodyTxt,
        ) &&
        !document.querySelector("#question-label")
      ) {
        return { type: "defeat" };
      }

      const qEl = document.querySelector("#question-label");
      const stepEl = document.querySelector("#step-info");
      const progEl = document.querySelector("#progressBar");
      let progress = null;
      if (progEl) {
        const w = progEl.querySelector("[style*='width']");
        progress = w ? w.style.width : null;
      }
      return {
        type: "question",
        question: qEl
          ? (qEl.textContent || "").replace(/\s+/g, " ").trim()
          : null,
        step: stepEl ? (stepEl.innerText || "").trim() : null,
        progress,
      };
    });
  }

  /**
   * Waits until the game moves past the previous step: the step counter changes,
   * a guess appears, or a defeat screen shows. Returns early on timeout.
   * @param {string|null} prevStep
   * @returns {Promise<void>}
   */
  async _waitForAdvance(prevStep) {
    try {
      await this.page.waitForFunction(
        (prev) => {
          const step = document.querySelector("#step-info")?.innerText?.trim();
          const name = document.querySelector("#name_proposition");
          const guessing =
            name &&
            name.offsetParent !== null &&
            (name.innerText || "").trim().length > 0;
          return guessing || (!!step && step !== prev);
        },
        { timeout: 15000 },
        prevStep,
      );
    } catch {
      void 0;
    }
    await sleep(600);
  }

  /**
   * Waits until a question is fully rendered (non-empty `#question-label`) or a
   * guess proposal is visible. Used after navigation, where there is no prior
   * step to diff against. Returns early on timeout.
   * @param {number} [timeout=20000]
   * @returns {Promise<void>}
   */
  async _waitForRenderedState(timeout = 20000) {
    try {
      await this.page.waitForFunction(
        () => {
          const q = document.querySelector("#question-label");
          const hasQ = q && (q.textContent || "").trim().length > 0;
          const name = document.querySelector("#name_proposition");
          const guessing =
            name &&
            name.offsetParent !== null &&
            (name.innerText || "").trim().length > 0;
          return hasQ || guessing;
        },
        { timeout },
      );
    } catch {
      void 0;
    }
    await sleep(400);
  }

  /**
   * Waits until the page URL contains the given fragment. Returns early on timeout.
   * @param {string} fragment
   * @param {number} [timeout=15000]
   * @returns {Promise<void>}
   */
  async _waitUrl(fragment, timeout = 15000) {
    try {
      await this.page.waitForFunction(
        (frag) => location.href.includes(frag),
        { timeout },
        fragment,
      );
    } catch {
      void 0;
    }
  }

  /**
   * Waits for a selector to appear and be visible. Returns false on timeout
   * rather than throwing.
   * @param {string} selector
   * @param {number} [timeout=20000]
   * @returns {Promise<boolean>}
   */
  async _waitForSelector(selector, timeout = 20000) {
    try {
      await this.page.waitForSelector(selector, { timeout, visible: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detects a Cloudflare interstitial / bot challenge on the current page.
   * @returns {Promise<boolean>}
   */
  async _detectCloudflare() {
    return this.page.evaluate(() => {
      const t = `${document.title} ${document.body ? document.body.innerText : ""}`;
      return /just a moment|verify you are human|enable javascript and cookies|attention required|cf-chl|challenge-platform/i.test(
        t,
      );
    });
  }

  /**
   * Saves a screenshot to the mounted logs volume for diagnosis. Best-effort.
   * @param {string} tag Filename suffix.
   * @returns {Promise<void>}
   */
  async _debugShot(tag) {
    try {
      const file = path.join(DEBUG_DIR, `akinator_${tag}.png`);
      await this.page.screenshot({ path: file });
      auditLog(
        "warn",
        "AKINATOR",
        `Saved debug screenshot logs/akinator_${tag}.png (url=${this.page.url()})`,
      );
    } catch {
      void 0;
    }
  }

  /**
   * Clicks a theme tile by its visible label.
   * @param {string} label
   * @returns {Promise<boolean>} Whether a matching tile was found and clicked.
   */
  async _clickTheme(label) {
    try {
      return await this.page.evaluate((lab) => {
        const li = [...document.querySelectorAll("li.li-game, li")].find(
          (e) => (e.innerText || "").trim().toLowerCase() === lab.toLowerCase(),
        );
        if (li) {
          li.click();
          return true;
        }
        return false;
      }, label);
    } catch {
      return false;
    }
  }

  /**
   * Starts a fresh game in the given theme and returns the first question.
   * Navigates directly to the theme-selection screen (which begins a new game),
   * falling back to the home-page PLAY flow if the tile is not reached.
   * @param {"characters"|"animals"|"objects"} [theme="characters"]
   * @returns {Promise<{type:string, [key:string]: any}>} The initial state.
   * @throws {Error} If the theme tile cannot be selected.
   */
  async startGame(theme = "characters") {
    const label = THEME_LABELS[theme] || THEME_LABELS.characters;
    const page = await this._getPage();

    await page.goto(`${BASE}/theme-selection`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await this._dismissConsent();

    let ready = await this._waitForSelector("li.li-game", 25000);
    if (!ready) {
      if (await this._detectCloudflare()) {
        await this._debugShot("cloudflare");
        throw new Error(
          "Blocked by Cloudflare challenge (likely the server's datacenter IP).",
        );
      }
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
      await this._dismissConsent();
      await page.evaluate(() => {
        const play = [
          ...document.querySelectorAll("a,button,[role='button']"),
        ].find((e) => /^play$/i.test((e.innerText || "").trim()));
        if (play) play.click();
      });
      await this._waitUrl("theme-selection");
      ready = await this._waitForSelector("li.li-game", 20000);
    }

    if (!ready) {
      await this._debugShot("notiles");
      throw new Error("Akinator theme tiles never appeared.");
    }

    let entered = false;
    for (let attempt = 0; attempt < 6 && !entered; attempt++) {
      await this._clickTheme(label);
      entered = await this.page
        .waitForFunction(
          () =>
            location.href.includes("/game") ||
            !!document.querySelector("#question-label"),
          { timeout: 5000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!entered) await sleep(1200);
    }
    if (!entered) {
      await this._debugShot("noenter");
      throw new Error("Theme selected but the game did not start.");
    }

    await this._waitForRenderedState();
    const state = await this._readState();
    if (state.type === "question" && !state.question) {
      await this._debugShot("noquestion");
    }
    auditLog("info", "AKINATOR", `Game started (theme=${theme}).`);
    return state;
  }

  /**
   * Submits an answer and returns the resulting state.
   * @param {"yes"|"no"|"idk"|"probably"|"probably_not"} key
   * @returns {Promise<{type:string, [key:string]: any}>}
   * @throws {Error} If the answer key is not recognized.
   */
  async answer(key) {
    const id = ANSWER_IDS[key];
    if (!id) throw new Error(`Invalid answer key: ${key}`);
    const page = await this._getPage();
    const before = await this._stepNum();
    await page.evaluate((anchorId) => {
      const a = document.querySelector(`#${anchorId}`);
      if (a) a.click();
    }, id);
    await this._waitForAdvance(before);
    await this._waitForRenderedState();
    return this._readState();
  }

  /**
   * Goes back one question when permitted; the control is disabled on the first
   * question.
   * @returns {Promise<{type:string, [key:string]: any}>} The resulting state.
   */
  async back() {
    const page = await this._getPage();
    const did = await page.evaluate(() => {
      const a = document.querySelector("#a_cancel_answer");
      if (!a) return false;
      const disabled =
        a.className.includes("disabled") || a.style.pointerEvents === "none";
      if (disabled) return false;
      a.click();
      return true;
    });
    if (did) await sleep(2200);
    return this._readState();
  }

  /**
   * Responds to a guess. Accepting ends the game as a win; declining makes
   * Akinator continue, and the next state is returned.
   * @param {boolean} accept
   * @returns {Promise<{type:string, [key:string]: any}>}
   */
  async confirmGuess(accept) {
    const page = await this._getPage();
    await page.evaluate((acc) => {
      const a = document.querySelector(
        acc ? "#a_propose_yes" : "#a_propose_no",
      );
      if (a) a.click();
    }, accept);
    await sleep(2500);
    if (accept) return { type: "win" };
    await this._waitForRenderedState();
    return this._readState();
  }

  /**
   * Closes this game's page. The shared browser is left open for idle reuse.
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.close();
      } catch {
        void 0;
      }
    }
    this.page = null;
  }
}
