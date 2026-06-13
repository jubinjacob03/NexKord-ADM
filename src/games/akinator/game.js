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
import { closeBrowser } from "./browser.js";
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
const BROWSER_IDLE_MS = 5 * 60 * 1000;
const BUSY_REPLY_COOLDOWN_MS = 15 * 1000;

const V2 = MessageFlags.IsComponentsV2;

/** @type {import('discord.js').Client | null} */
let discordClient = null;
let gameIdleTimer = null;
let browserIdleTimer = null;
let lastBusyReplyAt = 0;

/**
 * The single global game session. Exactly one game runs at a time; any other
 * member who chats while a game is active is asked to wait.
 */
const session = {
  active: false,
  /** @type {"theme"|"question"|"guess"|null} */
  phase: null,
  playerId: null,
  playerTag: null,
  channelId: null,
  theme: null,
  /** @type {AkinatorClient | null} */
  aki: null,
  busy: false,
  lastActivity: 0,
  /** @type {import('discord.js').Message | null} */
  lastMsg: null,
  /** @type {ContainerBuilder[] | null} Button-less rendering of {@link session.lastMsg}. */
  lastRetired: null,
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

/**
 * Maps free-text input to a theme key.
 * @type {Record<string, string>}
 */
const THEME_WORDS = {
  characters: "characters", character: "characters", char: "characters",
  c: "characters", people: "characters", person: "characters",
  animals: "animals", animal: "animals", a: "animals",
  objects: "objects", object: "objects", o: "objects", thing: "objects",
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
 * Resolves free text to a theme key.
 * @param {string} text
 * @returns {string|null}
 */
function parseTheme(text) {
  return THEME_WORDS[text] ?? null;
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
 * Builds a uniformly grey button. An optional icon-map key (uppercase) resolves
 * to a custom emoji; a raw emoji string is used as-is; omit it for a text-only
 * button. With grey buttons the icon, when present, conveys the meaning.
 * @param {string} id Custom ID.
 * @param {string} label Button label.
 * @param {string|import('discord.js').ComponentEmojiResolvable} [emoji] Icon key or raw emoji.
 * @returns {ButtonBuilder}
 */
function greyButton(id, label, emoji = null) {
  const button = new ButtonBuilder()
    .setCustomId(id)
    .setLabel(sc(label))
    .setStyle(ButtonStyle.Secondary);
  if (emoji) {
    button.setEmoji(
      typeof emoji === "string" && /^[A-Z0-9_]+$/.test(emoji) ? emojiObj(emoji) : emoji,
    );
  }
  return button;
}

/**
 * Builds the theme-selection button row.
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
function themeRow() {
  return new ActionRowBuilder().addComponents(
    greyButton("aki_theme_characters", "Characters"),
    greyButton("aki_theme_animals", "Animals"),
    greyButton("aki_theme_objects", "Objects"),
  );
}

/**
 * Builds the answer rows: the five responses laid out as a yes-to-no gradient,
 * plus the back and stop controls.
 * @returns {ActionRowBuilder<ButtonBuilder>[]}
 */
function answerRows() {
  const answers = new ActionRowBuilder().addComponents(
    greyButton("aki_ans_yes", "Yes"),
    greyButton("aki_ans_probably", "Probably"),
    greyButton("aki_ans_idk", "Don't know"),
    greyButton("aki_ans_probably_not", "Probably not"),
    greyButton("aki_ans_no", "No"),
  );
  const controls = new ActionRowBuilder().addComponents(
    greyButton("aki_back", "Back", "PREVIOUS"),
    greyButton("aki_stop", "Stop", "STOP"),
  );
  return [answers, controls];
}

/**
 * Builds the guess-confirmation button row.
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
function guessRow() {
  return new ActionRowBuilder().addComponents(
    greyButton("aki_guess_yes", "Yes, that's it!", "SUCCESS"),
    greyButton("aki_guess_no", "No, keep going", "ERROR"),
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
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large),
    );
    for (const row of rows) container.addActionRowComponents(row);
  }
  brandFooter(container, withControls ? hint : null);
  return container;
}

/**
 * Builds an interactive message payload together with its button-less retired
 * variant and the pose attachment.
 * @param {object} opts See {@link renderContainer}.
 * @returns {{components: ContainerBuilder[], retired: ContainerBuilder[], files: import('discord.js').AttachmentBuilder[]}}
 */
function buildMessage(opts) {
  return {
    components: [renderContainer(opts, true)],
    retired: [renderContainer(opts, false)],
    files: [opts.pose.attachment],
  };
}

/**
 * Composes the header markdown: a muted persona line, an H3 small-caps title
 * (optionally icon-prefixed), and an optional small-caps body. Icons are kept
 * outside {@link sc} so emoji tokens are never corrupted.
 * @param {string} title Title text (rendered as H3 small caps).
 * @param {string} [body=""] Optional body text (small caps).
 * @param {string|null} [titleIcon=null] Optional icon-map key prefixed to the title.
 * @returns {string}
 */
function header(title, body = "", titleIcon = null) {
  const persona = `-# ${genieIcon} ${sc("Akinator")}`;
  const titleLine = `### ${titleIcon ? `${icon(titleIcon)} ` : ""}${sc(title)}`;
  return body ? `${persona}\n${titleLine}\n${sc(body)}` : `${persona}\n${titleLine}`;
}

/**
 * Sends an interactive (buttoned) message, retiring the previously tracked one
 * so a player cannot act on a superseded question or guess.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {{components: ContainerBuilder[], retired: ContainerBuilder[], files: import('discord.js').AttachmentBuilder[]}} built
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function sendTracked(channel, built) {
  await retireLastMessage();
  const msg = await channel
    .send({ components: built.components, files: built.files, flags: V2 })
    .catch(() => null);
  if (msg) {
    session.lastMsg = msg;
    session.lastRetired = built.retired;
  }
  return msg;
}

/**
 * Sends a non-interactive V2 message (no buttons to track).
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {{components: ContainerBuilder[], files: import('discord.js').AttachmentBuilder[]}} built
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function sendPlain(channel, built) {
  return channel
    .send({ components: built.components, files: built.files, flags: V2 })
    .catch(() => null);
}

/**
 * Strips the buttons from the currently tracked message, leaving its card intact.
 * @returns {Promise<void>}
 */
async function retireLastMessage() {
  if (session.lastMsg && session.lastRetired) {
    await session.lastMsg
      .edit({ components: session.lastRetired, flags: V2 })
      .catch(() => {});
  }
  session.lastMsg = null;
  session.lastRetired = null;
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
  } else {
    auditLog("info", "AKINATOR", `Module ready on channel ${channelId}.`);
  }
}

/**
 * (Re)arms the timer that closes the dedicated browser once no game is running.
 * @returns {void}
 */
function armBrowserIdle() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(() => {
    if (!session.active) closeBrowser().catch(() => {});
  }, BROWSER_IDLE_MS);
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
  await retireLastMessage();
  session.active = false;
  session.phase = null;
  session.playerId = null;
  session.playerTag = null;
  session.channelId = null;
  session.theme = null;
  session.aki = null;
  session.busy = false;
  if (aki) await aki.dispose().catch(() => {});
  auditLog("info", "AKINATOR", `Game ended (${reason}).`);
  armBrowserIdle();
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
                        `A game with **${session.playerTag}** is already in progress — please wait your turn!`,
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

    if (session.phase === "theme") {
      const theme = parseTheme(low);
      if (!theme) {
        await message
          .reply("Pick a theme: **Characters**, **Animals**, or **Objects** (or tap a button).")
          .catch(() => {});
        return;
      }
      await chooseTheme(theme, message.channel);
      return;
    }

    if (session.phase === "guess") {
      const yn = parseYesNo(low);
      if (yn === null) {
        await message.reply("Was I right? Answer **yes** or **no**.").catch(() => {});
        return;
      }
      await resolveGuess(yn, message.channel);
      return;
    }

    const key = parseAnswer(low);
    if (!key) {
      await message
        .reply(
          "I didn't catch that. Reply **yes**, **no**, **don't know**, **probably**, or **probably not** (or use the buttons).",
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
        `This is **${session.playerTag}**'s game — start your own when it's free!`,
      );
      return true;
    }

    const id = interaction.customId;
    touch();

    if (id === "aki_stop") {
      await interaction.deferUpdate().catch(() => {});
      await stopGame(interaction.channel);
      return true;
    }
    if (id === "aki_back") {
      await interaction.deferUpdate().catch(() => {});
      await doBack(interaction.channel);
      return true;
    }
    if (id.startsWith("aki_theme_")) {
      await interaction.deferUpdate().catch(() => {});
      await chooseTheme(id.replace("aki_theme_", ""), interaction.channel);
      return true;
    }
    if (id.startsWith("aki_ans_")) {
      await interaction.deferUpdate().catch(() => {});
      await submitAnswer(id.replace("aki_ans_", ""), interaction.channel);
      return true;
    }
    if (id === "aki_guess_yes" || id === "aki_guess_no") {
      await interaction.deferUpdate().catch(() => {});
      await resolveGuess(id === "aki_guess_yes", interaction.channel);
      return true;
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
 * Opens a new session for the given user and prompts for a theme.
 * @param {import('discord.js').User} user
 * @param {string} displayName The player's server nickname (or username fallback).
 * @param {import('discord.js').TextBasedChannel} channel
 * @returns {Promise<void>}
 */
async function startGame(user, displayName, channel) {
  if (session.busy) return;
  session.busy = true;
  try {
    session.active = true;
    session.phase = "theme";
    session.playerId = user.id;
    session.playerTag = displayName;
    session.channelId = channel.id;
    session.aki = new AkinatorClient();
    touch();
    if (gameIdleTimer) clearTimeout(gameIdleTimer);

    await sendTracked(
      channel,
      buildMessage({
        header: header(
          `Think of someone or something, ${displayName}!`,
          "Pick a theme below, or type **Characters**, **Animals**, or **Objects**.",
        ),
        pose: akitude("serene"),
        accent: ACCENT,
        rows: [themeRow()],
        hint: "Only you can play until this game ends",
      }),
    );
    auditLog("info", "AKINATOR", `${user.tag} started a game.`);
  } catch (err) {
    auditLog("error", "AKINATOR", `startGame failed: ${err.message}`);
    await sendPlain(
      channel,
      buildMessage({
        header: header("The genie won't wake", "Try again in a moment.", "WARNING"),
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
 * Begins the live game in the chosen theme and posts the first question.
 * @param {string} theme
 * @param {import('discord.js').TextBasedChannel} channel
 * @returns {Promise<void>}
 */
async function chooseTheme(theme, channel) {
  if (session.busy || session.phase !== "theme") return;
  session.busy = true;
  const summoning = await sendPlain(
    channel,
    buildMessage({
      header: header("Summoning the genie…", "", "PENDING"),
      pose: akitude("mindreading"),
      accent: ACCENT,
    }),
  );
  try {
    session.theme = theme;
    const state = await session.aki.startGame(theme);
    session.phase = "question";
    if (summoning) await summoning.delete().catch(() => {});
    await postState(state, channel);
  } catch (err) {
    auditLog("error", "AKINATOR", `chooseTheme failed: ${err.message}`);
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
    await endGame("theme-error");
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
    const state = await session.aki.answer(key);
    await postState(state, channel);
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
    const state = await session.aki.back();
    await postState(state, channel);
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
    if (accept) {
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
      await sendPlain(channel, built);
    } else {
      const state = await session.aki.confirmGuess(false);
      session.phase = "question";
      await postState(state, channel);
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
 * Posts the appropriate card for a state and advances the session phase.
 * @param {{type:string, [key:string]: any}} state
 * @param {import('discord.js').TextBasedChannel} channel
 * @returns {Promise<void>}
 */
async function postState(state, channel) {
  if (!state || !state.type) {
    await endGame("empty-state");
    await sendPlain(
      channel,
      buildMessage({
        header: header("The genie went quiet", "Game ended.", "WARNING"),
        pose: akitude("stumped"),
        accent: DEFEAT_COLOR,
      }),
    );
    return;
  }

  if (state.type === "guess") {
    session.phase = "guess";
    const desc = state.description ? `\n-# ${sc(state.description)}` : "";
    await sendTracked(
      channel,
      buildMessage({
        header: `-# ${genieIcon} ${sc("Akinator")}\n### ${sc("I think I've got it!")}\n${sc("Is your character…")}\n\n**${sc(state.name)}**${desc}`,
        pose: akitude("confident"),
        accent: ACCENT,
        rows: [guessRow()],
        hint: "Was I right?",
      }),
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
    await sendPlain(channel, built);
    return;
  }

  session.phase = "question";
  await sendTracked(
    channel,
    buildMessage({
      header: `-# ${genieIcon} ${sc("Akinator")} · ${sc("Question")} ${state.step ?? "?"}\n### ${sc(state.question || "…")}`,
      pose: akitude(questionAkitude(state.step)),
      accent: ACCENT,
      rows: answerRows(),
      hint: "Tap a button or just type your answer",
    }),
  );
}
