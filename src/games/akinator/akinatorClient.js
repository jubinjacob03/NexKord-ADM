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

/** Navigation timeout (ms); generous because the egress proxy adds latency. */
const NAV_TIMEOUT = 60000;
/** Per-state timeout (ms) for a question/guess to render after an action. */
const STATE_TIMEOUT = 25000;
/** Resources never needed for gameplay — blocked to minimise proxy round-trips. */
const BLOCKED_RESOURCES = new Set(["image", "media", "font"]);

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
 * Drives a single Akinator game on en.akinator.com through one browser page.
 * Holds no Discord state; one instance is created per game.
 *
 * Latency model: every action (click an answer, go back, decline a guess) is
 * followed by a single render-precise wait that resolves the instant the next
 * question text changes or a guess appears — no fixed delays — then one DOM read.
 */
export class AkinatorClient {
  constructor() {
    /** @type {import('puppeteer-core').Page | null} */
    this.page = null;
  }

  /**
   * Returns this game's page, creating it on the shared dedicated browser on
   * first use and reusing it thereafter. Blocks heavy resources and wires proxy
   * auth so navigations are as light as possible.
   * @returns {Promise<import('puppeteer-core').Page>}
   */
  async _getPage() {
    if (this.page && !this.page.isClosed()) return this.page;

    const browser = await getBrowser();
    const page = await browser.newPage();

    if (process.env.AKINATOR_PROXY_USER && process.env.AKINATOR_PROXY_PASS) {
      await page.authenticate({
        username: process.env.AKINATOR_PROXY_USER,
        password: process.env.AKINATOR_PROXY_PASS,
      });
    }

    await page.setUserAgent(UA);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const blocked = BLOCKED_RESOURCES.has(req.resourceType());
      (blocked ? req.abort() : req.continue()).catch(() => {});
    });
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    page.setDefaultTimeout(STATE_TIMEOUT);

    this.page = page;
    return page;
  }

  /**
   * Reads the current screen, classifying it as a question, a guess proposal,
   * or a game-over (defeat) state. The proposal is checked first because it
   * overlays the question bubble.
   * @returns {Promise<{type:string, [key:string]: any}>}
   */
  async _readState() {
    return this.page.evaluate(() => {
      const visible = (el) => {
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
      const text = (el) => (el ? (el.innerText || "").trim() : "");

      const nameEl = document.querySelector("#name_proposition");
      if (visible(nameEl) && text(nameEl)) {
        return {
          type: "guess",
          name: text(nameEl),
          description: text(document.querySelector("#description_proposition")),
          step: text(document.querySelector("#step-info")) || null,
        };
      }

      const qEl = document.querySelector("#question-label");
      if (!qEl) {
        const body = (document.body.innerText || "").replace(/\s+/g, " ");
        if (
          /you (have )?(beaten|defeated|won)|bravo|well played|i (give up|surrender)|you win/i.test(
            body,
          )
        ) {
          return { type: "defeat" };
        }
      }

      return {
        type: "question",
        question: qEl ? (qEl.textContent || "").replace(/\s+/g, " ").trim() : null,
        step: text(document.querySelector("#step-info")) || null,
      };
    });
  }

  /**
   * Resolves the instant the next state is on screen: the question text differs
   * from `prevQuestion`, a guess proposal becomes visible, or a defeat screen
   * appears. Render-precise (animation-frame polling), so no fixed settle delay
   * is needed. Returns early on timeout; the caller's read reflects whatever is
   * present.
   * @param {string} prevQuestion The question text shown before the action.
   * @returns {Promise<void>}
   */
  async _awaitNextState(prevQuestion) {
    try {
      await this.page.waitForFunction(
        (prev) => {
          const name = document.querySelector("#name_proposition");
          if (name && name.offsetParent !== null && (name.innerText || "").trim()) {
            return true;
          }
          const q = document.querySelector("#question-label");
          if (!q) {
            const body = document.body.innerText || "";
            return /you (have )?(beaten|defeated|won)|bravo|well played|give up|you win/i.test(
              body,
            );
          }
          const qt = (q.textContent || "").trim();
          return qt.length > 0 && qt !== prev;
        },
        { timeout: STATE_TIMEOUT, polling: "raf" },
        prevQuestion ?? "",
      );
    } catch {}
  }

  /**
   * Waits until an element is gone or hidden. Used to confirm a click registered.
   * @param {string} selector
   * @param {number} timeout
   * @returns {Promise<void>}
   */
  async _awaitGone(selector, timeout) {
    try {
      await this.page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return !el || el.offsetParent === null || !(el.innerText || "").trim();
        },
        { timeout, polling: "raf" },
        selector,
      );
    } catch {}
  }

  /**
   * Waits for a selector to become visible. Returns false on timeout.
   * @param {string} selector
   * @param {number} timeout
   * @returns {Promise<boolean>}
   */
  async _awaitSelector(selector, timeout) {
    try {
      await this.page.waitForSelector(selector, { timeout, visible: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Dismisses a cookie-consent dialog if one is present, across the main
   * document and any CMP iframe. With the persistent profile this is a fast
   * no-op after the first launch.
   * @returns {Promise<void>}
   */
  async _dismissConsent() {
    for (const frame of this.page.frames()) {
      try {
        const clicked = await frame.evaluate(() => {
          const re =
            /^(accept|agree|i agree|consent|got it|i understand|continue|accept all|tout accepter|j'accepte)$/i;
          const el = [
            ...document.querySelectorAll('button,a,[role="button"],span'),
          ].find((e) => re.test((e.innerText || "").trim()));
          if (el) {
            el.click();
            return true;
          }
          return false;
        });
        if (clicked) return;
      } catch {}
    }
  }

  /**
   * Detects a Cloudflare interstitial / bot challenge on the current page.
   * @returns {Promise<boolean>}
   */
  async _detectCloudflare() {
    return this.page.evaluate(() =>
      /just a moment|verify you are human|enable javascript and cookies|attention required|cf-chl|challenge-platform/i.test(
        `${document.title} ${document.body ? document.body.innerText : ""}`,
      ),
    );
  }

  /**
   * Saves a screenshot to the mounted logs volume for diagnosis. Best-effort.
   * @param {string} tag Filename suffix.
   * @returns {Promise<void>}
   */
  async _debugShot(tag) {
    try {
      await this.page.screenshot({ path: path.join(DEBUG_DIR, `akinator_${tag}.png`) });
      auditLog(
        "warn",
        "AKINATOR",
        `Saved debug screenshot logs/akinator_${tag}.png (url=${this.page.url()})`,
      );
    } catch {}
  }

  /**
   * Clicks the homepage PLAY control if present; a no-op once past the homepage.
   * Matches the element whose own text node is "PLAY" (the inner span) rather
   * than an ancestor whose innerText merely contains it.
   * @returns {Promise<void>}
   */
  async _clickPlay() {
    try {
      await this.page.evaluate(() => {
        for (const e of document.querySelectorAll(
          "a,button,[role='button'],span,p,div",
        )) {
          const own = [...e.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.nodeValue)
            .join("")
            .trim();
          if (/^play$/i.test(own)) {
            e.click();
            return;
          }
        }
      });
    } catch {}
  }

  /**
   * Clicks a theme tile by its visible label.
   * @param {string} label
   * @returns {Promise<void>}
   */
  async _clickTheme(label) {
    try {
      await this.page.evaluate((lab) => {
        const li = [...document.querySelectorAll("li.li-game, li")].find(
          (e) => (e.innerText || "").trim().toLowerCase() === lab.toLowerCase(),
        );
        if (li) li.click();
      }, label);
    } catch {}
  }

  /**
   * Starts a fresh game in the given theme and returns the first question.
   * Loads the homepage first to establish a session (deep-linking to
   * /theme-selection redirects home on a fresh profile), then retries the PLAY
   * and theme clicks because the SPA binds its handlers a beat after the DOM is
   * ready, so a single click can be a no-op.
   * @param {"characters"|"animals"|"objects"} [theme="characters"]
   * @returns {Promise<{type:string, [key:string]: any}>} The initial state.
   * @throws {Error} If the theme tiles never appear or the game fails to start.
   */
  async startGame(theme = "characters") {
    const label = THEME_LABELS[theme] || THEME_LABELS.characters;
    const page = await this._getPage();

    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await this._dismissConsent();

    let ready = false;
    for (let attempt = 0; attempt < 8 && !ready; attempt++) {
      await this._clickPlay();
      ready = await this._awaitSelector("li.li-game", 6000);
    }
    if (!ready) {
      if (await this._detectCloudflare()) {
        await this._debugShot("cloudflare");
        throw new Error("Blocked by Cloudflare challenge (egress IP flagged).");
      }
      await this._debugShot("notiles");
      throw new Error("Akinator theme tiles never appeared.");
    }

    let entered = false;
    for (let attempt = 0; attempt < 6 && !entered; attempt++) {
      await this._clickTheme(label);
      entered = await page
        .waitForFunction(
          () =>
            location.href.includes("/game") ||
            !!document.querySelector("#question-label"),
          { timeout: 5000, polling: "raf" },
        )
        .then(() => true)
        .catch(() => false);
    }
    if (!entered) {
      await this._debugShot("noenter");
      throw new Error("Theme selected but the game did not start.");
    }

    await this._awaitNextState("");
    const state = await this._readState();
    if (state.type === "question" && !state.question) {
      await this._debugShot("noquestion");
    }
    auditLog("info", "AKINATOR", `Game started (theme=${theme}).`);
    return state;
  }

  /**
   * Submits an answer and returns the resulting state. Captures the current
   * question and clicks in a single round-trip, then waits render-precisely.
   * @param {"yes"|"no"|"idk"|"probably"|"probably_not"} key
   * @returns {Promise<{type:string, [key:string]: any}>}
   * @throws {Error} If the answer key is not recognized.
   */
  async answer(key) {
    const id = ANSWER_IDS[key];
    if (!id) throw new Error(`Invalid answer key: ${key}`);
    const page = await this._getPage();
    const prevQuestion = await page.evaluate((anchorId) => {
      const q = document.querySelector("#question-label");
      const prev = q ? (q.textContent || "").trim() : "";
      document.querySelector(`#${anchorId}`)?.click();
      return prev;
    }, id);
    await this._awaitNextState(prevQuestion);
    return this._readState();
  }

  /**
   * Goes back one question when permitted; the control is disabled on the first
   * question.
   * @returns {Promise<{type:string, [key:string]: any}>} The resulting state.
   */
  async back() {
    const page = await this._getPage();
    const { did, prevQuestion } = await page.evaluate(() => {
      const a = document.querySelector("#a_cancel_answer");
      const disabled =
        !a || a.className.includes("disabled") || a.style.pointerEvents === "none";
      if (disabled) return { did: false, prevQuestion: "" };
      const q = document.querySelector("#question-label");
      const prev = q ? (q.textContent || "").trim() : "";
      a.click();
      return { did: true, prevQuestion: prev };
    });
    if (did) await this._awaitNextState(prevQuestion);
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
    const prevQuestion = await page.evaluate((acc) => {
      const q = document.querySelector("#question-label");
      const prev = q ? (q.textContent || "").trim() : "";
      document.querySelector(acc ? "#a_propose_yes" : "#a_propose_no")?.click();
      return prev;
    }, accept);
    if (accept) {
      await this._awaitGone("#name_proposition", 4000);
      return { type: "win" };
    }
    await this._awaitNextState(prevQuestion);
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
      } catch {}
    }
    this.page = null;
  }
}
