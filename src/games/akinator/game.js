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
import { AkinatorClient } from "./akinatorClient.js";
import { closeBrowser } from "./browser.js";
import { auditLog } from "../../utils/logger.js";
import { icon, emojiObj } from "../../utils/icons.js";
import { akitude, questionAkitude } from "./akitudes.js";

const ACCENT = 0x9b59ff;
const WIN_COLOR = 0x2ecc71;
const DEFEAT_COLOR = 0xe74c3c;

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
 * Builds a uniformly grey button carrying an icon-map emoji, so the icon rather
 * than the button colour conveys meaning.
 * @param {string} id Custom ID.
 * @param {string} label Button label.
 * @param {string|import('discord.js').ComponentEmojiResolvable} emoji Icon key or raw emoji.
 * @returns {ButtonBuilder}
 */
function greyButton(id, label, emoji) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setEmoji(typeof emoji === "string" && /^[A-Z0-9_]+$/.test(emoji) ? emojiObj(emoji) : emoji)
    .setStyle(ButtonStyle.Secondary);
}

/**
 * Builds the theme-selection button row.
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
function themeRow() {
  return new ActionRowBuilder().addComponents(
    greyButton("aki_theme_characters", "Characters", "USER"),
    greyButton("aki_theme_animals", "Animals", "🐾"),
    greyButton("aki_theme_objects", "Objects", "📦"),
  );
}

/**
 * Builds the answer rows: the five responses laid out as a yes-to-no gradient,
 * plus the back and stop controls.
 * @returns {ActionRowBuilder<ButtonBuilder>[]}
 */
function answerRows() {
  const answers = new ActionRowBuilder().addComponents(
    greyButton("aki_ans_yes", "Yes", "SUCCESS"),
    greyButton("aki_ans_probably", "Probably", "POWER_GREEN"),
    greyButton("aki_ans_idk", "Don't know", "MICRO_YELLOW"),
    greyButton("aki_ans_probably_not", "Probably not", "MICRO_ORANGE"),
    greyButton("aki_ans_no", "No", "ERROR"),
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
 * Renders a Components V2 container: a header section with the genie pose as a
 * thumbnail accessory, followed by the button rows and a muted footer. When
 * `withControls` is false the buttons and footer are omitted, yielding the
 * button-less card used to retire a superseded message.
 * @param {object} opts
 * @param {string} opts.header Markdown shown beside the thumbnail.
 * @param {{url:string}} opts.pose Akitude thumbnail reference.
 * @param {number} opts.accent Accent bar colour.
 * @param {ActionRowBuilder<ButtonBuilder>[]} [opts.rows=[]]
 * @param {string|null} [opts.footer=null] Muted footer markdown.
 * @param {boolean} withControls
 * @returns {ContainerBuilder}
 */
function renderContainer({ header, pose, accent, rows = [], footer = null }, withControls) {
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
    if (footer) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small),
      );
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));
    }
  }
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
 * Composes the header markdown for the genie persona line plus a title and body.
 * @param {string} title Markdown title (rendered large).
 * @param {string} [body=""] Optional body markdown.
 * @returns {string}
 */
function header(title, body = "") {
  const persona = `-# ${icon("BOT")} AKINATOR`;
  return body ? `${persona}\n## ${title}\n${body}` : `${persona}\n## ${title}`;
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
 * Initializes the module: stores the client and starts the idle sweeper.
 * @param {import('discord.js').Client} client
 * @returns {void}
 */
export function initAkinator(client) {
  discordClient = client;
  setInterval(sweepIdle, 30 * 1000);
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
        `${icon("TIMER")} The genie dozed off`,
        "Game ended due to inactivity — type anything to start a new one!",
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
      await startGame(message.author, message.channel);
      return;
    }

    if (message.author.id !== session.playerId) {
      const now = Date.now();
      if (now - lastBusyReplyAt > BUSY_REPLY_COOLDOWN_MS) {
        lastBusyReplyAt = now;
        await message
          .reply({
            components: [
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
        new ContainerBuilder()
          .setAccentColor(ACCENT)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(header(title, body)),
          ),
      ],
      flags: V2 | MessageFlags.Ephemeral,
    })
    .catch(() => {});
}

/**
 * Opens a new session for the given user and prompts for a theme.
 * @param {import('discord.js').User} user
 * @param {import('discord.js').TextBasedChannel} channel
 * @returns {Promise<void>}
 */
async function startGame(user, channel) {
  if (session.busy) return;
  session.busy = true;
  try {
    session.active = true;
    session.phase = "theme";
    session.playerId = user.id;
    session.playerTag = user.username;
    session.channelId = channel.id;
    session.aki = new AkinatorClient();
    touch();
    if (gameIdleTimer) clearTimeout(gameIdleTimer);

    await sendTracked(
      channel,
      buildMessage({
        header: header(
          `Think of someone or something, ${user.username}!`,
          "Pick a theme below, or type **Characters**, **Animals**, or **Objects**.",
        ),
        pose: akitude("serene"),
        accent: ACCENT,
        rows: [themeRow()],
        footer: "-# Only you can play until this game ends.",
      }),
    );
    auditLog("info", "AKINATOR", `${user.tag} started a game.`);
  } catch (err) {
    auditLog("error", "AKINATOR", `startGame failed: ${err.message}`);
    await sendPlain(
      channel,
      buildMessage({
        header: header(`${icon("WARNING")} The genie won't wake`, "Try again in a moment."),
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
      header: header(`${icon("PENDING")} Summoning the genie…`),
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
          `${icon("WARNING")} The genie got lost`,
          "Game cancelled — type anything to retry.",
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
          `${icon("WARNING")} Something glitched mid-thought`,
          "Game ended — type anything to start over.",
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
        `${icon("STOP")} Game stopped`,
        "Thanks for playing — type anything to start a new one!",
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
          `${icon("SUCCESS")} Guessed it!`,
          "The genie read your mind — type anything to play again!",
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
          `${icon("WARNING")} The genie vanished`,
          "Game ended — type anything to start over.",
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
        header: header(`${icon("WARNING")} The genie went quiet`, "Game ended."),
        pose: akitude("stumped"),
        accent: DEFEAT_COLOR,
      }),
    );
    return;
  }

  if (state.type === "guess") {
    session.phase = "guess";
    const desc = state.description ? `\n-# ${state.description}` : "";
    await sendTracked(
      channel,
      buildMessage({
        header: header("I think I've got it!", `Is your character…\n\n**${state.name}**${desc}`),
        pose: akitude("confident"),
        accent: ACCENT,
        rows: [guessRow()],
        footer: "-# Was I right?",
      }),
    );
    return;
  }

  if (state.type === "defeat") {
    const built = buildMessage({
      header: header(
        `${icon("STAFF")} You beat the genie!`,
        "I couldn't guess it. Well played — type anything to challenge me again!",
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
      header: `-# ${icon("BOT")} AKINATOR · QUESTION ${state.step ?? "?"}\n## ${state.question || "…"}`,
      pose: akitude(questionAkitude(state.step)),
      accent: ACCENT,
      rows: answerRows(),
      footer: "-# Tap a button or just type your answer · Back or Stop anytime",
    }),
  );
}
