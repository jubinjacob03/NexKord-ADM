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

/** Navigation timeout (ms). */
const NAV_TIMEOUT = 60000;
/** Max time (ms) to wait for a Cloudflare interstitial to clear after a load. */
const CF_TIMEOUT = 30000;
/** Akinator subject id for the Characters theme. */
const SID = "1";
/** Resource types aborted to keep the single page load light. */
const BLOCKED_RESOURCES = new Set(["image", "media", "font"]);

/**
 * Answer keys mapped to Akinator's numeric answer ids.
 * @type {Record<string, number>}
 */
const ANSWER_IDS = {
  yes: 0,
  no: 1,
  idk: 2,
  probably: 3,
  probably_not: 4,
};

/**
 * Decodes HTML entities found in Akinator question and proposition text.
 * `&amp;` is resolved last to avoid double-decoding.
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  if (!value) return value;
  return String(value)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Returns the first capture group of `re` in `text`, or null.
 * @param {string} text
 * @param {RegExp} re
 * @returns {string|null}
 */
function pick(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

/**
 * Drives a single Characters game on en.akinator.com.
 *
 * The stealth browser clears Cloudflare and holds a same-origin, clearance-cookie
 * context; the game is then driven over Akinator's form API via in-page `fetch`,
 * making every turn a single JSON round-trip with no SPA navigation or DOM
 * scraping. Holds no Discord state; one instance per game.
 */
export class AkinatorClient {
  constructor() {
    /** @type {import('puppeteer-core').Page | null} */
    this.page = null;
    this.session = null;
    this.signature = null;
    this.childMode = false;
    this.step = 0;
    this.progression = 0;
    this.stepLastProposition = "";
    this.completion = null;
    this.question = "";
  }

  /**
   * Returns this game's page, creating it on the shared browser on first use
   * with proxy auth, heavy-resource blocking, and the spoofed user agent.
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

    this.page = page;
    return page;
  }

  /**
   * Reports whether a Cloudflare challenge is present on the current page.
   * @returns {Promise<boolean>}
   */
  async _detectCloudflare() {
    try {
      return await this.page.evaluate(() =>
        /just a moment|verify you are human|enable javascript and cookies|attention required|cf-chl|challenge-platform/i.test(
          `${document.title} ${document.body ? document.body.innerText : ""}`,
        ),
      );
    } catch {
      return false;
    }
  }

  /**
   * Loads the game page to obtain a Cloudflare clearance cookie and a same-origin
   * context for the API fetches, then waits for any interstitial to clear.
   * @returns {Promise<void>}
   * @throws {Error} If Cloudflare does not clear within {@link CF_TIMEOUT}.
   */
  async _ensureCleared() {
    const page = await this._getPage();
    if (!page.url().startsWith(BASE)) {
      await page.goto(`${BASE}/game`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
    }
    const deadline = Date.now() + CF_TIMEOUT;
    while (Date.now() < deadline) {
      if (!(await this._detectCloudflare())) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    await this._debugShot("cloudflare");
    throw new Error("Blocked by Cloudflare challenge (egress IP flagged).");
  }

  /**
   * Posts form-encoded parameters to an Akinator endpoint from inside the
   * cleared page so the clearance cookie and browser TLS fingerprint apply.
   * @param {string} apiPath Endpoint path beginning with "/".
   * @param {Record<string, string|number>} params Form fields.
   * @returns {Promise<{status:number, text:string, json:any}>} `json` is null for non-JSON bodies.
   */
  async _api(apiPath, params) {
    const body = new URLSearchParams(params).toString();
    return this.page.evaluate(
      async (url, payload) => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-requested-with": "XMLHttpRequest",
          },
          body: payload,
          credentials: "include",
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        return { status: res.status, text, json };
      },
      `${BASE}${apiPath}`,
      body,
    );
  }

  /**
   * Interprets a JSON response from /answer, /cancel_answer or /exclude and
   * advances game state. A guess is signalled by `id_proposition`; `KO - TIMEOUT`
   * marks an expired session; `SOUNDLIKE` marks a defeat.
   * @param {{status:number, text:string, json:any}} res
   * @returns {{type:string, [key:string]: any}}
   * @throws {Error} On a non-JSON body or an expired session.
   */
  _consume(res) {
    const data = res.json;
    if (!data) {
      throw new Error(`Akinator API returned non-JSON (status ${res.status}).`);
    }

    this.completion = data.completion ?? this.completion;

    if (this.completion === "KO - TIMEOUT") {
      throw new Error("Akinator session timed out.");
    }

    if (data.id_proposition) {
      this.stepLastProposition = String(this.step);
      return {
        type: "guess",
        name: decodeEntities(data.name_proposition),
        description: decodeEntities(data.description_proposition),
        step: String(this.step),
      };
    }

    if (this.completion === "SOUNDLIKE") {
      return { type: "defeat" };
    }

    this.step = parseInt(data.step, 10);
    this.progression = parseFloat(data.progression);
    this.question = decodeEntities(data.question);
    return { type: "question", question: this.question, step: String(this.step) };
  }

  /**
   * Starts a fresh Characters game and returns the first question, parsing the
   * session, signature and opening question from the /game response.
   * @param {"characters"} [_theme="characters"] Accepted for call-site compatibility; ignored.
   * @returns {Promise<{type:string, [key:string]: any}>}
   * @throws {Error} If Cloudflare blocks or the session cannot be parsed.
   */
  async startGame(_theme = "characters") {
    await this._ensureCleared();

    const res = await this._api("/game", { sid: SID, cm: this.childMode });
    const text = res.text || "";

    this.session =
      pick(text, /#session'\)\.val\('(.+?)'\)/) || pick(text, /session: '(.+?)'/);
    this.signature =
      pick(text, /#signature'\)\.val\('(.+?)'\)/) || pick(text, /signature: '(.+?)'/);
    const question = pick(
      text,
      /<p class="question-text" id="question-label">(.+?)<\/p>/,
    );

    if (!this.session || !this.signature || !question) {
      await this._debugShot("nostart");
      if (/just a moment|attention required|cf-chl/i.test(text)) {
        throw new Error("Blocked by Cloudflare challenge (egress IP flagged).");
      }
      throw new Error("Could not start Akinator session (unexpected response).");
    }

    this.step = 0;
    this.progression = 0;
    this.stepLastProposition = "";
    this.completion = "OK";
    this.question = decodeEntities(question);

    auditLog("info", "AKINATOR", "Game started (theme=characters).");
    return { type: "question", question: this.question, step: "0" };
  }

  /**
   * Submits an answer and returns the resulting state (next question or a guess).
   * @param {"yes"|"no"|"idk"|"probably"|"probably_not"} key
   * @returns {Promise<{type:string, [key:string]: any}>}
   * @throws {Error} If the answer key is not recognized.
   */
  async answer(key) {
    const answerId = ANSWER_IDS[key];
    if (answerId === undefined) throw new Error(`Invalid answer key: ${key}`);

    const res = await this._api("/answer", {
      step: this.step,
      progression: this.progression,
      sid: SID,
      cm: this.childMode,
      answer: answerId,
      step_last_proposition: this.stepLastProposition,
      session: this.session,
      signature: this.signature,
    });
    return this._consume(res);
  }

  /**
   * Goes back one question, returning the current question unchanged when
   * already at the first step (Akinator forbids going back further).
   * @returns {Promise<{type:string, [key:string]: any}>}
   */
  async back() {
    if (this.step <= 0) {
      return { type: "question", question: this.question, step: String(this.step) };
    }
    const res = await this._api("/cancel_answer", {
      step: this.step,
      progression: this.progression,
      sid: SID,
      cm: this.childMode,
      session: this.session,
      signature: this.signature,
    });
    return this._consume(res);
  }

  /**
   * Responds to a guess. Accepting ends the game as a win without a server
   * round-trip; declining excludes the proposition (advancing the step with
   * `forward_answer` set, as the site requires) and resumes questioning.
   * @param {boolean} accept
   * @returns {Promise<{type:string, [key:string]: any}>}
   */
  async confirmGuess(accept) {
    if (accept) {
      return { type: "win" };
    }
    const res = await this._api("/exclude", {
      step: this.step + 1,
      progression: this.progression,
      sid: SID,
      cm: this.childMode,
      session: this.session,
      signature: this.signature,
      forward_answer: 1,
    });
    return this._consume(res);
  }

  /**
   * Saves a diagnostic screenshot to the logs volume. Best-effort.
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
