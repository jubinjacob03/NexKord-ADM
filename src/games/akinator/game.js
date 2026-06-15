import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ThumbnailBuilder,
  MessageFlags,
} from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AkinatorClient } from "./akinatorClient.js";
import { closeClient } from "./tlsClient.js";
import { auditLog } from "../../utils/logger.js";
import { icon, emojiObj } from "../../utils/icons.js";
import { akitude, questionAkitude } from "./akitudes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GENIE_EMOJI_NAME = "akinatorgenie";
const GENIE_ICON_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "assets",
  "akinator",
  "icon.png",
);

/** Inline persona icon — a circular genie head emoji, or the 🧞 fallback. */
let genieIcon = "🧞";

const ACCENT = 0x00ffff;
const WIN_COLOR = 0x2ecc71;
const DEFEAT_COLOR = 0xe74c3c;

/**
 * Lowercase letters mapped to their Unicode small-capital glyphs.
 * @type {Record<string, string>}
 */
const SMALL_CAPS = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ",
  j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ꞯ", r: "ʀ",
  s: "ꜱ", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
};

/**
 * Transforms a string to small caps, leaving markdown, digits, punctuation and
 * existing capitals untouched. Must only wrap plain text — never custom-emoji
 * tokens, whose names would be corrupted.
 * @param {string} text
 * @returns {string}
 */
function sc(text) {
  return String(text).replace(/[a-z]/g, (ch) => SMALL_CAPS[ch] || ch);
}

const GAME_IDLE_MS = 3 * 60 * 1000;
const CLIENT_IDLE_MS = 10 * 60 * 1000;
const BUSY_REPLY_COOLDOWN_MS = 15 * 1000;

const V2 = MessageFlags.IsComponentsV2;

/** @type {import('discord.js').Client | null} */
let discordClient = null;
let gameIdleTimer = null;
let clientIdleTimer = null;
let lastBusyReplyAt = 0;

/**
 * The single global game session. Exactly one game runs at a time; any other
 * member who chats while a game is active is asked to wait.
 */
const session = {
  active: false,
  /** @type {"question"|"guess"|null} */
  phase: null,
  playerId: null,
  playerTag: null,
  channelId: null,
  /** @type {AkinatorClient | null} */
  aki: null,
  busy: false,
  lastActivity: 0,
  /** @type {import('discord.js').Message | null} */
  lastMsg: null,
  /** @type {{kind: "question"|"guess", data: object} | null} Data to re-render {@link session.lastMsg} without controls. */
  lastCard: null,
};

/**
 * Maps free-text input to a canonical answer key.
 * @type {Record<string, string>}
 */
const ANSWER_WORDS = {
  yes: "yes", y: "yes", yeah: "yes", yep: "yes", yup: "yes", ya: "yes",
  no: "no", n: "no", nope: "no", nah: "no", nay: "no",
  "don't know": "idk", "dont know": "idk", "i don't know": "idk",
  "i dont know": "idk", idk: "idk", dk: "idk", dunno: "idk", "no idea": "idk",
  probably: "probably", prob: "probably", p: "probably", maybe: "probably",
  likely: "probably", "i think so": "probably",
  "probably not": "probably_not", "prob not": "probably_not",
  pn: "probably_not", unlikely: "probably_not", "i don't think so": "probably_not",
};

const STOP_WORDS = new Set(["stop", "quit", "cancel", "end", "exit"]);
const BACK_WORDS = new Set(["back", "b", "undo", "previous"]);

/**
 * Resolves free text to an answer key.
 * @param {string} text
 * @returns {string|null}
 */
function parseAnswer(text) {
  return ANSWER_WORDS[text] ?? null;
}

/**
 * Resolves free text to a yes/no decision for guess confirmation.
 * @param {string} text
 * @returns {boolean|null}
 */
function parseYesNo(text) {
  const k = ANSWER_WORDS[text];
  if (k === "yes") return true;
  if (k === "no") return false;
  return null;
}

/**
 * Answer keys mapped to their button label and icon-map emoji key. Buttons are
 * uniformly Secondary (grey); the icon carries the meaning. The map also drives
 * the answer-feedback annotation on retired cards.
 * @type {Record<string, {label: string, emoji: string}>}
 */
const ANSWER_META = {
  yes: { label: "Yes", emoji: "AKI_YES" },
  probably: { label: "Probably", emoji: "AKI_PROBABLY" },
  idk: { label: "Don't know", emoji: "AKI_IDK" },
  probably_not: { label: "Probably not", emoji: "AKI_PROBABLY_NOT" },
  no: { label: "No", emoji: "AKI_NO" },
};

const ANSWER_ORDER = ["yes", "probably", "idk", "probably_not", "no"];

/**
 * Renders a ten-segment unicode progress bar for a 0–100 confidence value.
 * @param {number} pct
 * @returns {string}
 */
function progressBar(pct) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const filled = Math.round(p / 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`;
}

/**
 * Builds a button with an explicit style and optional emoji. An uppercase
 * icon-map key resolves to a custom emoji; any other string is used as a raw
 * unicode emoji.
 * @param {string} id Custom ID.
 * @param {string} label Button label (small-capped).
 * @param {ButtonStyle} style
 * @param {string} [emoji] Icon-map key or raw emoji.
 * @returns {ButtonBuilder}
 */
function button(id, label, style, emoji = null) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(sc(label)).setStyle(style);
  if (emoji) {
    b.setEmoji(/^[A-Z0-9_]+$/.test(emoji) ? emojiObj(emoji) : emoji);
  }
  return b;
}

/**
 * Builds the answer rows: the five responses as a coloured yes-to-no gradient,
 * plus the back and stop controls.
 * @returns {ActionRowBuilder<ButtonBuilder>[]}
 */
function answerRows() {
  const answers = new ActionRowBuilder().addComponents(
    ...ANSWER_ORDER.map((key) => {
      const m = ANSWER_META[key];
      return button(`aki_ans_${key}`, m.label, ButtonStyle.Secondary, m.emoji);
    }),
  );
  const controls = new ActionRowBuilder().addComponents(
    button("aki_back", "Back", ButtonStyle.Secondary, "AKI_BACK"),
    button("aki_stop", "Stop", ButtonStyle.Secondary, "AKI_STOP"),
  );
  return [answers, controls];
}

/**
 * Builds the guess-confirmation button row.
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
function guessRow() {
  return new ActionRowBuilder().addComponents(
    button("aki_guess_yes", "That's the one", ButtonStyle.Secondary, "AKI_CORRECT"),
    button("aki_guess_no", "Keep guessing", ButtonStyle.Secondary, "AKI_RETRY"),
  );
}

/**
 * Appends the house-style footer to a container: a thin divider followed by a
 * muted brand-and-timestamp line, optionally prefixed with a contextual hint.
 * @param {ContainerBuilder} container
 * @param {string|null} [hint=null] Optional small-caps hint shown before the brand.
 * @returns {ContainerBuilder}
 */
function brandFooter(container, hint = null) {
  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );
  const ts = Math.floor(Date.now() / 1000);
  const prefix = hint ? `${sc(hint)} · ` : "";
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# ${prefix}NexKord · <t:${ts}:f>`),
  );
  return container;
}

/**
 * Renders a Components V2 container: a header section with the genie pose as a
 * thumbnail accessory, optional button rows, and the house footer. When
 * `withControls` is false the buttons (and the contextual hint) are omitted,
 * yielding the button-less card used to retire a superseded message.
 * @param {object} opts
 * @param {string} opts.header Markdown shown beside the thumbnail.
 * @param {{url:string}} opts.pose Akitude thumbnail reference.
 * @param {number} opts.accent Accent bar colour.
 * @param {ActionRowBuilder<ButtonBuilder>[]} [opts.rows=[]]
 * @param {string|null} [opts.hint=null] Contextual footer hint (interactive cards only).
 * @param {boolean} withControls
 * @returns {ContainerBuilder}
 */
function renderContainer({ header, pose, accent, rows = [], hint = null }, withControls) {
  const container = new ContainerBuilder().setAccentColor(accent);
  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(pose.url)),
  );
  if (withControls && rows.length) {
    addGap(container, true);
    for (const row of rows) container.addActionRowComponents(row);
  }
  brandFooter(container, withControls ? hint : null);
  return container;
}

/**
 * Builds a plain (non-interactive) card payload with its pose attachment, used
 * for status cards such as summoning, win, defeat and stop.
 * @param {object} opts See {@link renderContainer}.
 * @returns {{components: ContainerBuilder[], files: import('discord.js').AttachmentBuilder[]}}
 */
function buildMessage(opts) {
  return {
    components: [renderContainer(opts, true)],
    files: [opts.pose.attachment],
  };
}

/**
 * Composes the status-card header markdown: a muted persona line, the title
 * (optionally icon-prefixed), and an optional subtext body. Icons are kept
 * outside {@link sc} so emoji tokens are never corrupted. No bold is used;
 * hierarchy comes from normal text vs. `-#` subtext.
 * @param {string} title Title text.
 * @param {string} [body=""] Optional body text (subtext).
 * @param {string|null} [titleIcon=null] Optional icon-map key prefixed to the title.
 * @returns {string}
 */
function header(title, body = "", titleIcon = null) {
  const persona = `-# ${genieIcon} ${sc("Akinator")}`;
  const titleLine = `${titleIcon ? `${icon(titleIcon)} ` : ""}${sc(title)}`;
  return body ? `${persona}\n\n${titleLine}\n-# ${sc(body)}` : `${persona}\n\n${titleLine}`;
}

/**
 * Adds a Components V2 separator to a container: a divider line or a plain gap.
 * @param {ContainerBuilder} container
 * @param {boolean} divider Whether a visible line is drawn.
 * @param {SeparatorSpacingSize} [spacing=SeparatorSpacingSize.Small]
 * @returns {void}
 */
function addGap(container, divider, spacing = SeparatorSpacingSize.Small) {
  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(divider).setSpacing(spacing),
  );
}

/**
 * Renders a question card. Persona, question and confidence bar are grouped in
 * one section beside the genie thumbnail (avoiding the uneven gap a separate
 * full-width line leaves under the tall portrait), followed by a single divider
 * and the controls when interactive. All separators use the same style for a
 * consistent rhythm.
 * @param {{step: string|number, question: string, progression: number}} data
 * @param {{interactive: boolean}} opts
 * @returns {{components: ContainerBuilder[], files: import('discord.js').AttachmentBuilder[]}}
 */
function renderQuestion(data, { interactive }) {
  const pose = akitude(questionAkitude(data.step));
  const text = [
    `-# ${genieIcon} ${sc("Akinator")} · ${sc("Question")} ${data.step ?? "?"}`,
    `${sc(data.question || "…")}`,
    `-# ${progressBar(data.progression)}  ${Math.round(Number(data.progression) || 0)}% ${sc("sure")}`,
  ].join("\n");

  const container = new ContainerBuilder().setAccentColor(ACCENT);
  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(pose.url)),
  );
  if (interactive) {
    addGap(container, true);
    for (const row of answerRows()) container.addActionRowComponents(row);
  }
  brandFooter(container, interactive ? "Tap a button or type your answer" : null);
  return { components: [container], files: [pose.attachment] };
}

/**
 * Renders a guess card. The reveal (intro, name, description, confidence) is
 * grouped in one section beside the confident genie, followed by a single
 * divider and the controls when interactive.
 * @param {{name: string, description?: string, progression?: number}} data
 * @param {{interactive: boolean}} opts
 * @returns {{components: ContainerBuilder[], files: import('discord.js').AttachmentBuilder[]}}
 */
function renderGuess(data, { interactive }) {
  const pose = akitude("confident");
  const lines = [
    `-# ${genieIcon} ${sc("Akinator")}`,
    `-# ${sc("I think I've got it! · Is your character…")}`,
    "",
    `${icon("AKI_CORRECT")} ${sc(data.name)}`,
  ];
  if (data.description) lines.push(`-# ${sc(data.description)}`);
  if (typeof data.progression === "number") {
    lines.push(
      `-# ${progressBar(data.progression)}  ${Math.round(data.progression)}% ${sc("sure")}`,
    );
  }

  const container = new ContainerBuilder().setAccentColor(WIN_COLOR);
  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(pose.url)),
  );
  if (interactive) {
    addGap(container, true);
    container.addActionRowComponents(guessRow());
  }
  brandFooter(container, interactive ? "Was I right?" : null);
  return { components: [container], files: [pose.attachment] };
}

/**
 * Sends a V2 message with a small retry to ride out transient DNS/network
 * blips to discord.com. Returns the message, or null after all attempts fail.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {object} payload Message options.
 * @param {string} label Short action label for diagnostic logs.
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function sendWithRetry(channel, payload, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await channel.send(payload);
    } catch (err) {
      auditLog(
        "warn",
        "AKINATOR",
        `send '${label}' attempt ${attempt}/3 failed: ${err.message}`,
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, 800));
    }
  }
  return null;
}

/**
 * Builds the reply-reference fragment so a card threads onto a prior message,
 * without pinging its author. Returns an empty object when there is nothing to
 * reply to (e.g. the opening question).
 * @param {import('discord.js').Message|null} msg
 * @returns {object}
 */
function replyRef(msg) {
  return msg
    ? {
        reply: { messageReference: msg.id, failIfNotExists: false },
        allowedMentions: { repliedUser: false },
      }
    : {};
}

/**
 * Posts the player's choice as a compact message replying to the card they
 * acted on, giving the chat a visible back-and-forth instead of a one-sided
 * stream of bot cards. Returns the message so the next card can reply onto it.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {import('discord.js').Message|null} replyToMsg The card being answered.
 * @param {string} emojiKey Icon-map key for the choice.
 * @param {string} label Choice label.
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function postChoice(channel, replyToMsg, emojiKey, label) {
  const content = `${icon(emojiKey)} ${sc(label)}\n-# ${sc(session.playerTag || "Player")}`;
  return sendWithRetry(
    channel,
    { content, allowedMentions: { parse: [] }, ...replyRef(replyToMsg) },
    "choice",
  );
}

/**
 * Sends an interactive (buttoned) card, retiring the previously tracked one so
 * a player cannot act on a superseded question or guess. Stores the card data
 * so the message can later be re-rendered without controls, and optionally
 * threads the card as a reply to `replyTo`.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {{components: ContainerBuilder[], files: import('discord.js').AttachmentBuilder[]}} built
 * @param {{kind: "question"|"guess", data: object}} card
 * @param {import('discord.js').Message|null} [replyTo]
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function sendTracked(channel, built, card, replyTo = null) {
  retireLastMessage();
  const msg = await sendWithRetry(
    channel,
    { components: built.components, files: built.files, flags: V2, ...replyRef(replyTo) },
    card.kind,
  );
  if (msg) {
    session.lastMsg = msg;
    session.lastCard = card;
  }
  return msg;
}

/**
 * Sends a non-interactive V2 message (no buttons to track), optionally threaded
 * as a reply to `replyTo`.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {{components: ContainerBuilder[], files: import('discord.js').AttachmentBuilder[]}} built
 * @param {import('discord.js').Message|null} [replyTo]
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function sendPlain(channel, built, replyTo = null) {
  return sendWithRetry(
    channel,
    { components: built.components, files: built.files, flags: V2, ...replyRef(replyTo) },
    "plain",
  );
}

/**
 * Retires the currently tracked card: clears tracking synchronously, then fires
 * a controls-free edit without awaiting. Re-renders the card from its stored
 * data with the buttons removed, neutralising a superseded question or guess.
 * @returns {void}
 */
function retireLastMessage() {
  const msg = session.lastMsg;
  const card = session.lastCard;
  session.lastMsg = null;
  session.lastCard = null;
  if (!msg || !card) return;

  const built =
    card.kind === "question"
      ? renderQuestion(card.data, { interactive: false })
      : renderGuess(card.data, { interactive: false });
  msg.edit({ components: built.components, flags: V2 }).catch(() => {});
}

/**
 * Ensures the circular genie persona emoji exists on the application, creating
 * it from the bundled icon on first run. Falls back to 🧞 on any failure.
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function registerGenieIcon(client) {
  try {
    const emojis = await client.application.emojis.fetch();
    let emoji = emojis.find((e) => e.name === GENIE_EMOJI_NAME);
    if (!emoji) {
      emoji = await client.application.emojis.create({
        attachment: fs.readFileSync(GENIE_ICON_PATH),
        name: GENIE_EMOJI_NAME,
      });
      auditLog("info", "AKINATOR", `Registered persona emoji :${GENIE_EMOJI_NAME}:`);
    }
    genieIcon = `<:${emoji.name}:${emoji.id}>`;
  } catch (e) {
    genieIcon = "🧞";
    auditLog("warn", "AKINATOR", `Persona emoji unavailable, using fallback: ${e.message}`);
  }
}

/**
 * Initializes the module: stores the client, registers the persona icon, and
 * starts the idle sweeper.
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
export async function initAkinator(client) {
  discordClient = client;
  setInterval(sweepIdle, 30 * 1000);
  await registerGenieIcon(client);
  const channelId = process.env.AKINATOR_CHANNEL_ID;
  if (!channelId) {
    auditLog("warn", "AKINATOR", "AKINATOR_CHANNEL_ID not set — module idle.");
    return;
  }
  auditLog("info", "AKINATOR", `Module ready on channel ${channelId}.`);
}

/**
 * (Re)arms the timer that closes the shared TLS client once no game is running.
 * @returns {void}
 */
function armClientIdle() {
  if (clientIdleTimer) clearTimeout(clientIdleTimer);
  clientIdleTimer = setTimeout(() => {
    if (!session.active) closeClient().catch(() => {});
  }, CLIENT_IDLE_MS);
}

/**
 * Records player activity to defer the inactivity timeout.
 * @returns {void}
 */
function touch() {
  session.lastActivity = Date.now();
}

/**
 * Ends the current game, retires any live buttons, clears session state, and
 * schedules the browser to close on idle.
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function endGame(reason) {
  if (gameIdleTimer) {
    clearTimeout(gameIdleTimer);
    gameIdleTimer = null;
  }
  const aki = session.aki;
  retireLastMessage();
  session.active = false;
  session.phase = null;
  session.playerId = null;
  session.playerTag = null;
  session.channelId = null;
  session.aki = null;
  session.busy = false;
  if (aki) await aki.dispose().catch(() => {});
  auditLog("info", "AKINATOR", `Game ended (${reason}).`);
  armClientIdle();
}

/**
 * Ends a game that the player has abandoned past the inactivity threshold.
 * @returns {void}
 */
function sweepIdle() {
  if (session.active && Date.now() - session.lastActivity > GAME_IDLE_MS) {
    const channel = discordClient?.channels?.cache?.get(session.channelId);
    const built = buildMessage({
      header: header(
        "The genie dozed off",
        "Game ended due to inactivity — type anything to start a new one!",
        "TIMER",
      ),
      pose: akitude("sleeping"),
      accent: ACCENT,
    });
    endGame("idle-timeout").then(() => {
      if (channel) sendPlain(channel, built);
    });
  }
}

/**
 * messageCreate handler for the Akinator channel. Starts a game on the first
 * message, routes the active player's input, and asks other members to wait.
 * @param {import('discord.js').Message} message
 * @returns {Promise<void>}
 */
export async function handleAkinatorMessage(message) {
  try {
    if (!discordClient || message.author.bot) return;
    const channelId = process.env.AKINATOR_CHANNEL_ID;
    if (!channelId || message.channelId !== channelId) return;

    const content = message.content.trim();
    if (!content) return;
    const low = content.toLowerCase();

    if (!session.active) {
      const displayName = message.member?.displayName || message.author.username;
      await startGame(message.author, displayName, message.channel);
      return;
    }

    if (message.author.id !== session.playerId) {
      const now = Date.now();
      if (now - lastBusyReplyAt > BUSY_REPLY_COOLDOWN_MS) {
        lastBusyReplyAt = now;
        await message
          .reply({
            components: [
              brandFooter(
                new ContainerBuilder()
                  .setAccentColor(ACCENT)
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      header(
                        "The genie is busy",
                        `A game with ${session.playerTag} is already in progress — please wait your turn!`,
                      ),
                    ),
                  ),
              ),
            ],
            flags: V2,
          })
          .catch(() => {});
      }
      return;
    }

    touch();
    if (STOP_WORDS.has(low)) {
      await stopGame(message.channel);
      return;
    }
    if (BACK_WORDS.has(low)) {
      await doBack(message.channel);
      return;
    }

    if (session.phase === "guess") {
      const yn = parseYesNo(low);
      if (yn === null) {
        await message.reply("Was I right? Answer yes or no.").catch(() => {});
        return;
      }
      await resolveGuess(yn, message.channel);
      return;
    }

    const key = parseAnswer(low);
    if (!key) {
      await message
        .reply(
          "I didn't catch that. Reply yes, no, don't know, probably, or probably not (or use the buttons).",
        )
        .catch(() => {});
      return;
    }
    await submitAnswer(key, message.channel);
  } catch (err) {
    auditLog("error", "AKINATOR", `message handler error: ${err.message}`);
  }
}

/**
 * interactionCreate handler for Akinator buttons.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>} Whether the interaction was an Akinator button.
 */
export async function handleAkinatorButton(interaction) {
  if (!interaction.isButton?.() || !interaction.customId.startsWith("aki_")) {
    return false;
  }
  try {
    if (!session.active) {
      await replyNotice(interaction, "That game has ended", "Type in the channel to start a new one!");
      return true;
    }
    if (interaction.user.id !== session.playerId) {
      await replyNotice(
        interaction,
        "Not your game",
        `This is ${session.playerTag}'s game — start your own when it's free!`,
      );
      return true;
    }

    const id = interaction.customId;
    const ack = interaction.deferUpdate().catch((e) =>
      auditLog("warn", "AKINATOR", `deferUpdate failed: ${e.message}`),
    );
    touch();
    auditLog("info", "AKINATOR", `button '${id}' by ${interaction.user.tag}`);
    await ack;

    if (id === "aki_stop") {
      await stopGame(interaction.channel);
    } else if (id === "aki_back") {
      await doBack(interaction.channel);
    } else if (id.startsWith("aki_ans_")) {
      await submitAnswer(id.replace("aki_ans_", ""), interaction.channel);
    } else if (id === "aki_guess_yes" || id === "aki_guess_no") {
      await resolveGuess(id === "aki_guess_yes", interaction.channel);
    }
    return true;
  } catch (err) {
    auditLog("error", "AKINATOR", `button handler error: ${err.message}`);
    return true;
  }
}

/**
 * Sends an ephemeral V2 notice in response to a button interaction.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} title
 * @param {string} body
 * @returns {Promise<void>}
 */
async function replyNotice(interaction, title, body) {
  await interaction
    .reply({
      components: [
        brandFooter(
          new ContainerBuilder()
            .setAccentColor(ACCENT)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(header(title, body)),
            ),
        ),
      ],
      flags: V2 | MessageFlags.Ephemeral,
    })
    .catch(() => {});
}

/**
 * Opens a new session for the given user and starts a Characters game straight
 * away (the only supported theme). Posts a transient "summoning" card while the
 * browser clears Cloudflare and fetches the first question, then replaces it
 * with the question card.
 * @param {import('discord.js').User} user
 * @param {string} displayName The player's server nickname (or username fallback).
 * @param {import('discord.js').TextBasedChannel} channel
 * @returns {Promise<void>}
 */
async function startGame(user, displayName, channel) {
  if (session.busy) return;
  session.busy = true;
  let summoning = null;
  try {
    session.active = true;
    session.phase = "question";
    session.playerId = user.id;
    session.playerTag = displayName;
    session.channelId = channel.id;
    session.aki = new AkinatorClient();
    touch();
    if (gameIdleTimer) clearTimeout(gameIdleTimer);
    auditLog("info", "AKINATOR", `${user.tag} started a game.`);

    summoning = await sendPlain(
      channel,
      buildMessage({
        header: header(
          "Summoning the genie…",
          `Think of a character, ${displayName} — real or fictional!`,
          "AKI_LOADING",
        ),
        pose: akitude("mindreading"),
        accent: ACCENT,
      }),
    );

    const state = await session.aki.startGame();
    if (summoning) await summoning.delete().catch(() => {});
    await postState(state, channel);
  } catch (err) {
    auditLog("error", "AKINATOR", `startGame failed: ${err.message}`);
    if (summoning) await summoning.delete().catch(() => {});
    await sendPlain(
      channel,
      buildMessage({
        header: header(
          "The genie got lost",
          "Game cancelled — type anything to retry.",
          "WARNING",
        ),
        pose: akitude("stumped"),
        accent: DEFEAT_COLOR,
      }),
    );
    await endGame("start-error");
  } finally {
    session.busy = false;
  }
}

/**
 * Submits the player's answer and posts the resulting state.
 * @param {string} key
 * @param {import('discord.js').TextBasedChannel} channel
 * @returns {Promise<void>}
 */
async function submitAnswer(key, channel) {
  if (session.busy || session.phase !== "question") return;
  session.busy = true;
  try {
    const qMsg = session.lastMsg;
    retireLastMessage();
    const meta = ANSWER_META[key];
    const choice = await postChoice(channel, qMsg, meta?.emoji, meta?.label || key);
    const state = await session.aki.answer(key);
    await postState(state, channel, choice);
  } catch (err) {
    auditLog("error", "AKINATOR", `submitAnswer failed: ${err.message}`);
    await sendPlain(
      channel,
      buildMessage({
        header: header(
          "Something glitched mid-thought",
          "Game ended — type anything to start over.",
          "WARNING",
        ),
        pose: akitude("stumped"),
        accent: DEFEAT_COLOR,
      }),
    );
    await endGame("answer-error");
  } finally {
    session.busy = false;
  }
}

/**
 * Steps the game back one question and posts the resulting state.
 * @param {import('discord.js').TextBasedChannel} channel
 * @returns {Promise<void>}
 */
async function doBack(channel) {
  if (session.busy || session.phase !== "question") return;
  session.busy = true;
  try {
    const qMsg = session.lastMsg;
    retireLastMessage();
    const choice = await postChoice(channel, qMsg, "AKI_BACK", "Back");
    const state = await session.aki.back();
    await postState(state, channel, choice);
  } catch (err) {
    auditLog("error", "AKINATOR", `back failed: ${err.message}`);
  } finally {
    session.busy = false;
  }
}

/**
 * Stops the current game at the player's request and posts a closing card.
 * @param {import('discord.js').TextBasedChannel} channel
 * @returns {Promise<void>}
 */
async function stopGame(channel) {
  await endGame("player-stop");
  await sendPlain(
    channel,
    buildMessage({
      header: header(
        "Game stopped",
        "Thanks for playing — type anything to start a new one!",
        "STOP",
      ),
      pose: akitude("serene"),
      accent: ACCENT,
    }),
  );
}

/**
 * Resolves a guess. Accepting ends the game as a win; declining resumes play.
 * @param {boolean} accept
 * @param {import('discord.js').TextBasedChannel} channel
 * @returns {Promise<void>}
 */
async function resolveGuess(accept, channel) {
  if (session.busy || session.phase !== "guess") return;
  session.busy = true;
  try {
    const gMsg = session.lastMsg;
    retireLastMessage();
    if (accept) {
      const choice = await postChoice(channel, gMsg, "AKI_CORRECT", "That's the one");
      await session.aki.confirmGuess(true);
      const built = buildMessage({
        header: header(
          "Guessed it!",
          "The genie read your mind — type anything to play again!",
          "SUCCESS",
        ),
        pose: akitude("confident"),
        accent: WIN_COLOR,
      });
      await endGame("win");
      await sendPlain(channel, built, choice);
    } else {
      const choice = await postChoice(channel, gMsg, "AKI_RETRY", "Keep guessing");
      const state = await session.aki.confirmGuess(false);
      session.phase = "question";
      await postState(state, channel, choice);
    }
  } catch (err) {
    auditLog("error", "AKINATOR", `resolveGuess failed: ${err.message}`);
    await sendPlain(
      channel,
      buildMessage({
        header: header(
          "The genie vanished",
          "Game ended — type anything to start over.",
          "WARNING",
        ),
        pose: akitude("stumped"),
        accent: DEFEAT_COLOR,
      }),
    );
    await endGame("guess-error");
  } finally {
    session.busy = false;
  }
}

/**
 * Posts the appropriate card for a state and advances the session phase. When
 * `replyTo` is given the card is threaded as a reply to it.
 * @param {{type:string, [key:string]: any}} state
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {import('discord.js').Message|null} [replyTo]
 * @returns {Promise<void>}
 */
async function postState(state, channel, replyTo = null) {
  if (!state || !state.type) {
    await endGame("empty-state");
    await sendPlain(
      channel,
      buildMessage({
        header: header("The genie went quiet", "Game ended.", "WARNING"),
        pose: akitude("stumped"),
        accent: DEFEAT_COLOR,
      }),
      replyTo,
    );
    return;
  }

  if (state.type === "guess") {
    session.phase = "guess";
    const data = {
      name: state.name,
      description: state.description,
      progression: state.progression,
    };
    await sendTracked(
      channel,
      renderGuess(data, { interactive: true }),
      { kind: "guess", data },
      replyTo,
    );
    return;
  }

  if (state.type === "defeat") {
    const built = buildMessage({
      header: header(
        "You beat the genie!",
        "I couldn't guess it. Well played — type anything to challenge me again!",
        "STAFF",
      ),
      pose: akitude("stumped"),
      accent: DEFEAT_COLOR,
    });
    await endGame("defeat");
    await sendPlain(channel, built, replyTo);
    return;
  }

  session.phase = "question";
  const data = {
    step: state.step,
    question: state.question,
    progression: state.progression,
  };
  const posted = await sendTracked(
    channel,
    renderQuestion(data, { interactive: true }),
    { kind: "question", data },
    replyTo,
  );
  if (!posted) {
    auditLog("warn", "AKINATOR", `failed to post question ${state.step} card`);
  }
}
