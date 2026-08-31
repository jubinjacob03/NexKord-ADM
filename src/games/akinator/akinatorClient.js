import { getClient } from "./tlsClient.js";
import { auditLog } from "../../utils/logger.js";

const BASE = "https://en.akinator.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Chrome 126 JA3 fingerprint — what gets the requests past Cloudflare. */
const JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";
/** Akinator subject id for the Characters theme. */
const SID = "1";
function readProxy() {
  return String(process.env.AKINATOR_PROXY || "").trim();
}

function readRequestTimeoutMs() {
  const raw = String(process.env.AKINATOR_REQUEST_TIMEOUT_MS || "15000");
  if (!/^\d+$/.test(raw)) return 15000;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 300000)
    : 15000;
}

/**
 * Answer keys mapped to Akinator's numeric answer ids.
 * @type {Record<string, number>}
 */
const ANSWER_IDS = { yes: 0, no: 1, idk: 2, probably: 3, probably_not: 4 };

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
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16)),
    )
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
  const m = String(text).match(re);
  return m ? m[1] : null;
}

/**
 * Drives a single Characters game on en.akinator.com over Akinator's form API
 * using a TLS-impersonating client (CycleTLS), so no browser is needed. Holds
 * no Discord state; one instance per game.
 */
export class AkinatorClient {
  constructor() {
    this.session = null;
    this.signature = null;
    this.childMode = false;
    this.step = 0;
    this.progression = 0;
    this.stepLastProposition = "";
    this.completion = null;
    this.question = "";
    this.disposed = false;
    /** Per-game cookie jar (cf clearance + load-balancer affinity). */
    this.cookies = {};
  }

  _assertUsable() {
    if (this.disposed) throw new Error("Akinator game is no longer active.");
  }

  /**
   * Records cookies from a response's set-cookie header(s) into the jar.
   * @param {Record<string, any>} headers
   * @returns {void}
   */
  _storeCookies(headers) {
    const setCookie = headers?.["set-cookie"] || headers?.["Set-Cookie"];
    if (!setCookie) return;
    for (const cookie of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const pair = String(cookie).split(";")[0];
      const separator = pair.indexOf("=");
      if (separator > 0) {
        this.cookies[pair.slice(0, separator).trim()] = pair
          .slice(separator + 1)
          .trim();
      }
    }
  }

  _commit(response, fields) {
    this._assertUsable();
    this._storeCookies(response.headers);
    Object.assign(this, fields);
  }

  /**
   * Serialises the cookie jar into a Cookie header value.
   * @returns {string}
   */
  _cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  /**
   * Performs one form-encoded POST to an Akinator endpoint with the Chrome JA3
   * fingerprint, WARP egress (when configured) and the running cookie jar.
   * @param {string} apiPath Endpoint path beginning with "/".
   * @param {string} body Form-encoded body.
   * @returns {Promise<{status:number, body:any, headers:Record<string,any>}>}
   */
  async _api(apiPath, body) {
    this._assertUsable();
    const client = await getClient();
    this._assertUsable();
    const cookie = this._cookieHeader();
    const proxy = readProxy();
    const timeoutMs = readRequestTimeoutMs();
    const response = await client(
      `${BASE}${apiPath}`,
      {
        body,
        ja3: JA3,
        timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
        ...(proxy ? { proxy } : {}),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": UA,
          "x-requested-with": "XMLHttpRequest",
          accept: "application/json, text/javascript, */*; q=0.01",
          origin: BASE,
          referer: `${BASE}/game`,
          ...(cookie ? { cookie } : {}),
        },
      },
      "post",
    );
    this._assertUsable();
    if (!response || !Number.isInteger(response.status)) {
      throw new Error("Akinator returned an invalid HTTP response.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Akinator request failed with HTTP ${response.status}.`);
    }
    if (
      !response.headers ||
      typeof response.headers !== "object" ||
      Array.isArray(response.headers)
    ) {
      throw new Error("Akinator returned invalid response headers.");
    }
    if (response.body === undefined || response.body === null) {
      throw new Error("Akinator returned an empty response.");
    }
    return response;
  }

  /**
   * Interprets a JSON response from /answer, /cancel_answer or /exclude and
   * advances game state. CycleTLS auto-parses JSON bodies to objects. A guess is
   * signalled by `id_proposition`; `KO - TIMEOUT` marks an expired session;
   * `SOUNDLIKE` marks a defeat.
   * @param {{status:number, body:any}} res
   * @returns {{type:string, [key:string]: any}}
   * @throws {Error} On a non-JSON body or an expired session.
   */
  _consume(response) {
    const data =
      response.body &&
      typeof response.body === "object" &&
      !Array.isArray(response.body)
        ? response.body
        : safeJson(response.body);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(
        `Akinator API returned non-JSON (status ${response.status}).`,
      );
    }

    let completion = this.completion;
    if (data.completion !== undefined && data.completion !== null) {
      if (typeof data.completion !== "string") {
        throw new Error("Akinator returned an invalid completion state.");
      }
      completion = data.completion;
    }
    if (completion === "KO - TIMEOUT") {
      throw new Error("Akinator session timed out.");
    }

    if (Object.hasOwn(data, "id_proposition")) {
      const name = decodeEntities(data.name_proposition);
      if (!name) throw new Error("Akinator returned an invalid proposition.");
      if (
        data.description_proposition !== undefined &&
        data.description_proposition !== null &&
        typeof data.description_proposition !== "string"
      ) {
        throw new Error(
          "Akinator returned an invalid proposition description.",
        );
      }
      const description = decodeEntities(data.description_proposition || "");
      this._commit(response, {
        completion,
        stepLastProposition: String(this.step),
      });
      return {
        type: "guess",
        name,
        description,
        step: String(this.step),
        progression: this.progression,
      };
    }

    if (completion === "SOUNDLIKE") {
      this._commit(response, { completion });
      return { type: "defeat" };
    }

    const step = Number(data.step);
    const progression = Number(data.progression);
    const question =
      typeof data.question === "string" ? decodeEntities(data.question) : "";
    if (!Number.isSafeInteger(step) || step < 0) {
      throw new Error("Akinator returned an invalid question step.");
    }
    if (!Number.isFinite(progression) || progression < 0 || progression > 100) {
      throw new Error("Akinator returned invalid question progression.");
    }
    if (!question) throw new Error("Akinator returned an empty question.");

    this._commit(response, { completion, step, progression, question });
    return {
      type: "question",
      question,
      step: String(step),
      progression,
    };
  }

  /**
   * Starts a fresh Characters game and returns the first question, parsing the
   * session, signature and opening question from the /game response.
   * @returns {Promise<{type:string, [key:string]: any}>}
   * @throws {Error} If Cloudflare blocks or the session cannot be parsed.
   */
  async startGame() {
    this._assertUsable();
    const response = await this._api(
      "/game",
      `sid=${SID}&cm=${this.childMode}`,
    );
    if (typeof response.body !== "string") {
      throw new Error("Akinator returned an invalid game page.");
    }
    const text = response.body;
    const gameSession =
      pick(text, /#session'\)\.val\('(.+?)'\)/) ||
      pick(text, /session: '(.+?)'/);
    const signature =
      pick(text, /#signature'\)\.val\('(.+?)'\)/) ||
      pick(text, /signature: '(.+?)'/);
    const rawQuestion = pick(
      text,
      /<p class="question-text" id="question-label">(.+?)<\/p>/,
    );
    const question = decodeEntities(rawQuestion);

    if (!gameSession || !signature || !question) {
      if (/just a moment|attention required|cf-chl|error code/i.test(text)) {
        throw new Error(`Blocked by Cloudflare (status ${response.status}).`);
      }
      throw new Error(
        "Could not start Akinator session (unexpected response).",
      );
    }

    this._commit(response, {
      session: gameSession,
      signature,
      step: 0,
      progression: 0,
      stepLastProposition: "",
      completion: "OK",
      question,
    });

    auditLog("info", "AKINATOR", "Game started (theme=characters).");
    return {
      type: "question",
      question,
      step: "0",
      progression: 0,
    };
  }

  /**
   * Submits an answer and returns the resulting state (next question or a guess).
   * @param {"yes"|"no"|"idk"|"probably"|"probably_not"} key
   * @returns {Promise<{type:string, [key:string]: any}>}
   * @throws {Error} If the answer key is not recognized.
   */
  async answer(key) {
    this._assertUsable();
    const answerId = ANSWER_IDS[key];
    if (answerId === undefined) throw new Error(`Invalid answer key: ${key}`);

    const fromStep = this.step;
    const res = await this._api(
      "/answer",
      new URLSearchParams({
        step: String(this.step),
        progression: String(this.progression),
        sid: SID,
        cm: String(this.childMode),
        answer: String(answerId),
        step_last_proposition: this.stepLastProposition,
        session: this.session,
        signature: this.signature,
      }).toString(),
    );
    const state = this._consume(res);
    auditLog(
      "info",
      "AKINATOR",
      `answer '${key}' @step ${fromStep} -> ${state.type} (step ${this.step}, ${Math.round(this.progression)}%)`,
    );
    return state;
  }

  /**
   * Goes back one question, returning the current question unchanged when
   * already at the first step (Akinator forbids going back further).
   * @returns {Promise<{type:string, [key:string]: any}>}
   */
  async back() {
    this._assertUsable();
    if (this.step <= 0) {
      return {
        type: "question",
        question: this.question,
        step: String(this.step),
        progression: this.progression,
      };
    }
    const res = await this._api(
      "/cancel_answer",
      new URLSearchParams({
        step: String(this.step),
        progression: String(this.progression),
        sid: SID,
        cm: String(this.childMode),
        session: this.session,
        signature: this.signature,
      }).toString(),
    );
    const state = this._consume(res);
    auditLog("info", "AKINATOR", `back -> ${state.type} (step ${this.step})`);
    return state;
  }

  /**
   * Responds to a guess. Accepting ends the game as a win without a server
   * round-trip; declining excludes the proposition (advancing the step with
   * `forward_answer` set, as the site requires) and resumes questioning.
   * @param {boolean} accept
   * @returns {Promise<{type:string, [key:string]: any}>}
   */
  async confirmGuess(accept) {
    this._assertUsable();
    if (accept) {
      auditLog("info", "AKINATOR", "guess accepted -> win");
      return { type: "win" };
    }
    const res = await this._api(
      "/exclude",
      new URLSearchParams({
        step: String(this.step + 1),
        progression: String(this.progression),
        sid: SID,
        cm: String(this.childMode),
        session: this.session,
        signature: this.signature,
        forward_answer: "1",
      }).toString(),
    );
    const state = this._consume(res);
    auditLog(
      "info",
      "AKINATOR",
      `guess declined -> ${state.type} (step ${this.step})`,
    );
    return state;
  }

  /**
   * Releases per-game state. The shared TLS client is left running for idle
   * reuse and closed elsewhere.
   * @returns {Promise<void>}
   */
  async dispose() {
    this.disposed = true;
    this.cookies = {};
    this.session = null;
    this.signature = null;
    this.question = "";
    this.completion = null;
  }
}

/**
 * Parses JSON, returning null on failure.
 * @param {string} s
 * @returns {any}
 */
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
