import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import {
  buildModDashboard,
  buildSearchResults,
  buildShowtimePoster,
  buildMovieCard,
  buildShowtimesBoard,
  BTN,
} from "./dashboard.js";
import { initScreens, getScreens, getScreen } from "./screens.js";
import {
  loadSchedule,
  addShow,
  getUpcoming,
  setShowMessageId,
  getDueShows,
  claimShowForDispatch,
  markShowDispatchAttempting,
  completeShowDispatch,
  markShowDispatchUnknown,
  expireStaleShows,
} from "./schedule.js";
import {
  initializeLibrary,
  addMovie,
  addVariant,
  getMovie,
  getAllMovies,
  getBestVariant,
  getPlayableVariant,
  qualityRank,
} from "./library.js";
import {
  downloadFromUrl,
  getDownloadProgress,
  cancelDownload,
  validateDownloadRequest,
  initializeDownloads,
  shutdownDownloads,
  removeInterruptedPartials,
} from "./downloader.js";
import { searchAll } from "./tmdb.js";
import { eReply } from "../../utils/embed.js";
import { auditLog } from "../../utils/logger.js";
import path from "path";
import {
  readJsonFileSync,
  writeJsonFileAtomicSync,
} from "../../utils/jsonStore.js";

let dashboardChannelId = null;
let announcementChannelId = null;
let dashboardChannel = null;
let announcementChannel = null;
let showtimesChannelId = null;
let showtimesChannel = null;
let admClient = null;

const uiStateFile = path.join(process.cwd(), "data", "cinema-ui-state.json");
const searchCache = new Map();
const refreshQueues = {
  dashboard: Promise.resolve(),
  showtimes: Promise.resolve(),
};
let retirementQueue = Promise.resolve();
let activeChannelRecovery = null;
let uiState = {
  version: 1,
  dashboard: null,
  showtimes: null,
  retirements: [],
};
const STATIC_MODERATOR_BUTTON_IDS = new Set(Object.values(BTN));

function parseIdSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d{16,22}$/.test(id)),
  );
}

function isCinemaModerator(interaction) {
  const configuredGuildId =
    process.env.CINEMA_GUILD_ID || process.env.GUILD_ID || "";
  if (!interaction.guildId) return false;
  if (configuredGuildId && interaction.guildId !== configuredGuildId) {
    return false;
  }

  const allowedUsers = parseIdSet(process.env.CINEMA_MODERATOR_USER_IDS);
  if (allowedUsers.has(interaction.user.id)) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  const allowedRoles = parseIdSet(process.env.CINEMA_MODERATOR_ROLE_IDS);
  const memberRoles = interaction.member?.roles;
  if (memberRoles?.cache) {
    return [...allowedRoles].some((roleId) => memberRoles.cache.has(roleId));
  }
  if (Array.isArray(memberRoles)) {
    return memberRoles.some((roleId) => allowedRoles.has(roleId));
  }
  return false;
}

async function requireCinemaModerator(interaction) {
  if (isCinemaModerator(interaction)) return true;
  await interaction.reply(
    eReply(
      "Not Authorized",
      "You need Manage Server or an approved Cinema moderator role to use this control.",
    ),
  );
  return false;
}

function validManagedMessage(value) {
  return (
    value === null ||
    (value &&
      typeof value.channelId === "string" &&
      typeof value.messageId === "string")
  );
}

function validUiState(value) {
  return (
    value?.version === 1 &&
    validManagedMessage(value.dashboard) &&
    validManagedMessage(value.showtimes) &&
    (value.retirements === undefined ||
      (Array.isArray(value.retirements) &&
        value.retirements.every(
          (record) => record !== null && validManagedMessage(record),
        )))
  );
}

function loadUiState() {
  uiState = readJsonFileSync(uiStateFile, {
    fallback: {
      version: 1,
      dashboard: null,
      showtimes: null,
      retirements: [],
    },
    validate: validUiState,
    label: "cinema UI state",
  });
  if (!Array.isArray(uiState.retirements)) {
    uiState.retirements = [];
    saveUiState();
  }
}

function saveUiState() {
  writeJsonFileAtomicSync(uiStateFile, uiState, { pretty: true });
}

function unknownMessage(error) {
  return error?.code === 10008 || error?.rawError?.code === 10008;
}

function queueRefresh(kind, operation) {
  const queued = refreshQueues[kind].catch(() => {}).then(operation);
  refreshQueues[kind] = queued;
  return queued;
}

async function retireManagedMessage(record) {
  if (!record || !admClient) return false;
  try {
    const channel = await admClient.channels.fetch(record.channelId);
    const message = await channel?.messages?.fetch(record.messageId);
    if (message?.deletable !== false) await message?.delete();
    return true;
  } catch (error) {
    if (unknownMessage(error)) return true;
    console.warn(
      `[CINEMA] Could not retire managed message ${record.messageId}: ${error.message}`,
    );
    return false;
  }
}

function sameManagedMessage(left, right) {
  return (
    left?.channelId === right?.channelId && left?.messageId === right?.messageId
  );
}

async function executePendingRetirements() {
  const pending = [...uiState.retirements];
  if (pending.length === 0) return;
  const retired = [];
  for (const record of pending) {
    if (await retireManagedMessage(record)) retired.push(record);
  }
  if (retired.length === 0) return;
  const previous = uiState.retirements;
  uiState.retirements = previous.filter(
    (record) => !retired.some((item) => sameManagedMessage(item, record)),
  );
  try {
    saveUiState();
  } catch (error) {
    uiState.retirements = previous;
    throw error;
  }
}

function retryPendingRetirements() {
  const queued = retirementQueue
    .catch(() => {})
    .then(executePendingRetirements);
  retirementQueue = queued;
  return queued;
}

async function replaceManagedMessage(kind, channel, payload, previous) {
  const message = await channel.send(payload);
  const replacement = { channelId: channel.id, messageId: message.id };
  const previousRetirements = uiState.retirements;
  const shouldRetire = previous && !sameManagedMessage(previous, replacement);
  uiState[kind] = replacement;
  if (
    shouldRetire &&
    !uiState.retirements.some((record) => sameManagedMessage(record, previous))
  ) {
    uiState.retirements = [...uiState.retirements, previous];
  }
  try {
    saveUiState();
  } catch (error) {
    uiState[kind] = previous;
    uiState.retirements = previousRetirements;
    await message.delete().catch(() => {});
    throw error;
  }

  if (shouldRetire) await retryPendingRetirements();
  return message;
}

async function updateManagedMessage(kind, channel, payload) {
  const record = uiState[kind];
  if (record?.channelId === channel.id) {
    try {
      const message = await channel.messages.fetch(record.messageId);
      await message.edit(payload);
      return message;
    } catch (error) {
      if (!unknownMessage(error)) throw error;
    }
  }

  return replaceManagedMessage(kind, channel, payload, record);
}

function parsePositiveInteger(value) {
  const normalized = String(value || "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function movieModalId(prefix, movieId) {
  const customId = `${prefix}${movieId}`;
  return customId.length <= 100 ? customId : null;
}

function cacheSearchResults(userId, results) {
  const entry = { results };
  searchCache.set(userId, entry);
  setTimeout(() => {
    if (searchCache.get(userId) === entry) searchCache.delete(userId);
  }, 300_000).unref?.();
}

async function sendToScreen(screenId, command, onAttempt) {
  if (!admClient) throw new Error("Cinema client is not initialized.");
  const screen = getScreen(screenId);
  if (!screen) throw new Error(`Screen ${screenId} is not configured.`);
  if (!screen.channelId) {
    throw new Error(`${screen.name} has no command channel configured.`);
  }
  const channel = await admClient.channels.fetch(screen.channelId);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
    throw new Error(`${screen.name} command channel is not sendable.`);
  }
  const message = `${screen.prefix}${command}`;
  onAttempt?.();
  const sent = await channel.send(message);
  const commandName = String(command).trim().split(/\s+/, 1)[0] || "unknown";
  auditLog(
    "info",
    "CINEMA",
    `Dispatched ${commandName} command to ${screen.name}`,
  );
  return sent;
}

async function startBackgroundDownload(request, movieId, variantId) {
  const progress = await downloadFromUrl(
    request.url,
    movieId,
    variantId,
    request.filename,
  );
  void progress.promise.catch((error) => {
    console.error(
      `[CINEMA] Background download ${progress.filename} failed: ${error.message}`,
    );
  });
  return progress;
}

async function refreshDashboard() {
  if (!dashboardChannel) return;
  return queueRefresh("dashboard", async () => {
    try {
      await updateManagedMessage(
        "dashboard",
        dashboardChannel,
        buildModDashboard(getUpcoming()),
      );
    } catch (error) {
      console.error(`[CINEMA] Dashboard refresh failed: ${error.message}`);
    }
  });
}

async function refreshShowtimesBoard() {
  if (!showtimesChannel) return;
  return queueRefresh("showtimes", async () => {
    try {
      await updateManagedMessage(
        "showtimes",
        showtimesChannel,
        buildShowtimesBoard(getUpcoming()),
      );
    } catch (error) {
      console.error(
        `[CINEMA] Showtimes board refresh failed: ${error.message}`,
      );
    }
  });
}

async function postAnnouncement(show) {
  if (!announcementChannel) return;
  const screen = getScreen(show.screenId);
  const payload = buildShowtimePoster({
    title: show.title,
    year: show.year,
    overview: show.overview,
    posterUrl: show.posterUrl,
    showtimeUnix: show.showtimeUnix,
    screenName: screen?.name || "Screen",
  });

  try {
    const msg = await announcementChannel.send(payload);
    setShowMessageId(show.id, msg.id);
    auditLog("info", "CINEMA", `Announced "${show.title}" (${msg.id})`);
  } catch (err) {
    console.error(`[CINEMA] Announcement failed: ${err.message}`);
  }
}

const SHOWTIME_TICK_MS = 30_000;
const SHOWTIME_GRACE_SECONDS = 900;
let showtimeTimer = null;
let activeShowtimeTick = null;

function resolvePlaybackCommand(show) {
  if (
    show.playback?.version !== 1 ||
    !show.playback.movieId ||
    !show.playback.variantId
  ) {
    throw new Error("Showtime has no verified playback binding.");
  }
  const variant = getPlayableVariant(
    show.playback.movieId,
    show.playback.variantId,
  );
  if (!variant?.filePath) {
    throw new Error("The exact scheduled media variant is no longer playable.");
  }
  const relativePath = path.relative(
    process.cwd(),
    path.resolve(variant.filePath),
  );
  if (
    !relativePath ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      "The scheduled media path is outside the shared data root.",
    );
  }
  const portablePath = relativePath.split(path.sep).join("/");
  return `play ${portablePath}`;
}

async function executeShowtimeTick() {
  const due = getDueShows(SHOWTIME_GRACE_SECONDS);

  for (const candidate of due) {
    let show;
    try {
      show = claimShowForDispatch(candidate.id, SHOWTIME_GRACE_SECONDS);
    } catch (error) {
      auditLog(
        "error",
        "CINEMA",
        `Could not claim showtime "${candidate.title}": ${error.message}`,
      );
      continue;
    }
    if (!show) continue;

    const screen = getScreen(show.screenId);
    let sendAttempted = false;
    try {
      if (!screen) {
        throw new Error(`Screen ${show.screenId} is not configured.`);
      }
      const command = resolvePlaybackCommand(show);
      await sendToScreen(show.screenId, command, () => {
        if (!markShowDispatchAttempting(show.id)) {
          throw new Error("Showtime dispatch claim changed unexpectedly.");
        }
        sendAttempted = true;
      });
      if (!completeShowDispatch(show.id, "dispatched")) {
        throw new Error("Showtime dispatch state changed unexpectedly.");
      }
      auditLog(
        "info",
        "CINEMA",
        `Showtime dispatched: "${show.title}" on ${screen.name}`,
      );
    } catch (error) {
      if (sendAttempted) {
        try {
          markShowDispatchUnknown(
            show.id,
            "A dispatch was attempted, but delivery could not be confirmed.",
          );
        } catch (persistenceError) {
          auditLog(
            "error",
            "CINEMA",
            `Could not persist uncertain dispatch for "${show.title}": ${persistenceError.message}`,
          );
        }
        auditLog(
          "warn",
          "CINEMA",
          `Showtime delivery is uncertain for "${show.title}": ${error.message}`,
        );
      } else {
        try {
          completeShowDispatch(show.id, "failed", error.message);
        } catch (persistenceError) {
          auditLog(
            "error",
            "CINEMA",
            `Could not persist failed showtime "${show.title}": ${persistenceError.message}`,
          );
        }
        auditLog(
          "error",
          "CINEMA",
          `Showtime failed for "${show.title}": ${error.message}`,
        );
      }
    }
  }

  const missed = expireStaleShows(SHOWTIME_GRACE_SECONDS);
  for (const show of missed) {
    auditLog(
      "warn",
      "CINEMA",
      `Show "${show.title}" missed its slot by more than ${SHOWTIME_GRACE_SECONDS}s`,
    );
  }

  if (due.length || missed.length) {
    await Promise.allSettled([refreshDashboard(), refreshShowtimesBoard()]);
  }
}

async function runShowtimeTick() {
  if (activeShowtimeTick) return activeShowtimeTick;
  activeShowtimeTick = executeShowtimeTick().finally(() => {
    activeShowtimeTick = null;
  });
  return activeShowtimeTick;
}

async function fetchConfiguredChannel(client, channelId, label) {
  if (!channelId) {
    console.warn(`[CINEMA] ${label} channel is not configured.`);
    return null;
  }
  try {
    return await client.channels.fetch(channelId);
  } catch (error) {
    console.warn(
      `[CINEMA] Could not fetch ${label} channel ${channelId}: ${error.message}`,
    );
    return null;
  }
}

async function executeChannelRecovery() {
  if (!admClient) return;
  const hadDashboard = Boolean(dashboardChannel);
  const hadShowtimes = Boolean(showtimesChannel);
  [dashboardChannel, announcementChannel, showtimesChannel] = await Promise.all(
    [
      dashboardChannel ||
        (dashboardChannelId
          ? fetchConfiguredChannel(admClient, dashboardChannelId, "dashboard")
          : null),
      announcementChannel ||
        (announcementChannelId
          ? fetchConfiguredChannel(
              admClient,
              announcementChannelId,
              "announcement",
            )
          : null),
      showtimesChannel ||
        (showtimesChannelId
          ? fetchConfiguredChannel(admClient, showtimesChannelId, "showtimes")
          : null),
    ],
  );

  const recovery = [retryPendingRetirements()];
  if (!hadDashboard && dashboardChannel) recovery.push(refreshDashboard());
  if (!hadShowtimes && showtimesChannel) {
    recovery.push(refreshShowtimesBoard());
  }
  await Promise.allSettled(recovery);
}

function recoverUnavailableChannels() {
  if (activeChannelRecovery) return activeChannelRecovery;
  activeChannelRecovery = executeChannelRecovery().finally(() => {
    activeChannelRecovery = null;
  });
  return activeChannelRecovery;
}

export async function initCinema(client) {
  admClient = client;
  initScreens();
  loadSchedule();
  initializeLibrary();
  initializeDownloads();
  loadUiState();

  const interruptedPartials = await removeInterruptedPartials();
  if (interruptedPartials.removed > 0) {
    auditLog(
      "warn",
      "CINEMA",
      `Removed ${interruptedPartials.removed} interrupted download file${interruptedPartials.removed === 1 ? "" : "s"}`,
    );
  }
  if (interruptedPartials.failed > 0) {
    auditLog(
      "error",
      "CINEMA",
      `Could not remove ${interruptedPartials.failed} interrupted download file${interruptedPartials.failed === 1 ? "" : "s"}`,
    );
  }

  dashboardChannelId = process.env.CINEMA_DASHBOARD_CHANNEL_ID || null;
  announcementChannelId = process.env.CINEMA_ANNOUNCEMENT_CHANNEL_ID || null;
  showtimesChannelId =
    process.env.CINEMA_SHOWTIMES_CHANNEL_ID || announcementChannelId;

  [dashboardChannel, announcementChannel, showtimesChannel] = await Promise.all(
    [
      fetchConfiguredChannel(client, dashboardChannelId, "dashboard"),
      fetchConfiguredChannel(client, announcementChannelId, "announcement"),
      fetchConfiguredChannel(client, showtimesChannelId, "showtimes"),
    ],
  );

  await retryPendingRetirements();
  await Promise.allSettled([refreshDashboard(), refreshShowtimesBoard()]);

  if (showtimeTimer) clearInterval(showtimeTimer);
  await runShowtimeTick();
  showtimeTimer = setInterval(() => {
    runShowtimeTick().catch((error) =>
      console.error(`[CINEMA] Showtime tick failed: ${error.message}`),
    );
    recoverUnavailableChannels().catch((error) =>
      console.error(`[CINEMA] Channel recovery failed: ${error.message}`),
    );
  }, SHOWTIME_TICK_MS);
  showtimeTimer.unref?.();

  console.log(
    `[CINEMA] Cinema system initialised (showtime tick every ${SHOWTIME_TICK_MS / 1000}s).`,
  );
}

export async function shutdownCinema() {
  const downloadsShutdown = shutdownDownloads();
  if (showtimeTimer) {
    clearInterval(showtimeTimer);
    showtimeTimer = null;
  }
  if (activeShowtimeTick) await activeShowtimeTick.catch(() => {});
  if (activeChannelRecovery) await activeChannelRecovery.catch(() => {});
  await Promise.allSettled(Object.values(refreshQueues));
  await retirementQueue.catch(() => {});
  await downloadsShutdown;
  admClient = null;
}

export async function handleCinemaButton(interaction) {
  if (!interaction.isButton()) return false;
  const id = interaction.customId;
  if (!id.startsWith("cinema:")) return false;

  if (id.startsWith("cinema:poster_") || id.startsWith("cinema:noop")) {
    await interaction.deferUpdate();
    return true;
  }

  if (id.startsWith("cinema:screen_join_")) {
    const screenId = parsePositiveInteger(
      id.slice("cinema:screen_join_".length),
    );
    const screen = screenId ? getScreen(screenId) : null;
    if (!screen?.voiceChannelId) {
      await interaction.reply(
        eReply("No VC", "This screen has no voice channel configured."),
      );
      return true;
    }
    await interaction.reply({
      content: `🎬 Join the screen here: <#${screen.voiceChannelId}>`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (STATIC_MODERATOR_BUTTON_IDS.has(id)) {
    const dashboard = uiState.dashboard;
    if (
      !dashboard ||
      !dashboardChannel ||
      dashboardChannel.id !== dashboard.channelId ||
      dashboardChannelId !== dashboard.channelId ||
      interaction.channelId !== dashboard.channelId ||
      interaction.message?.id !== dashboard.messageId
    ) {
      await interaction.reply(
        eReply(
          "Control Expired",
          "Use the controls on the current Cinema dashboard.",
        ),
      );
      return true;
    }
  }

  if (!(await requireCinemaModerator(interaction))) return true;

  if (id.startsWith("cinema:pick_")) {
    await handlePick(interaction);
    return true;
  }

  if (id.startsWith("cinema:card_upload_")) {
    const movieId = id.slice("cinema:card_upload_".length);
    const modalId = movieModalId("cinema:card_upload_modal:", movieId);
    if (!modalId || !getMovie(movieId)) {
      await interaction.reply(
        eReply("Not Found", "This library entry is unavailable."),
      );
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle("Upload Offline File")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cul_url")
            .setLabel("GDrive or direct download URL")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cul_quality")
            .setLabel("Quality (e.g. 1080p, 4K)")
            .setStyle(TextInputStyle.Short)
            .setValue("1080p")
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cul_filename")
            .setLabel("Filename (e.g. movie-1080p.mkv)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  if (id.startsWith("cinema:card_download_")) {
    await interaction.reply(
      eReply(
        "Use Offline Upload",
        "Provider prefetch is unavailable here. Upload a validated HTTPS media file instead.",
      ),
    );
    return true;
  }

  if (id.startsWith("cinema:card_schedule_")) {
    const movieId = id.slice("cinema:card_schedule_".length);
    const modalId = movieModalId("cinema:card_schedule_modal:", movieId);
    const movie = getMovie(movieId);
    if (!modalId || !movie || !getBestVariant(movieId)) {
      await interaction.reply(
        eReply(
          "Movie Not Ready",
          "A verified offline media file is required before scheduling.",
        ),
      );
      return true;
    }
    const screens = getScreens();
    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle("Schedule Showtime")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cs_time")
            .setLabel("Time (e.g. 8:30 PM or 20:30)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cs_screen")
            .setLabel(`Screen number (1-${screens.length || 3})`)
            .setStyle(TextInputStyle.Short)
            .setValue("1")
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  switch (id) {
    case BTN.SEARCH: {
      const modal = new ModalBuilder()
        .setCustomId("cinema:search_modal")
        .setTitle("Search Movie / TV")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:search_input")
              .setLabel("Title")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("Interstellar")
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    case BTN.SCHEDULE: {
      const movies = getAllMovies().filter((m) =>
        m.variants.some(
          (v) => v.status === "offline" || v.status === "downloaded",
        ),
      );
      if (movies.length === 0) {
        await interaction.reply(
          eReply(
            "No Movies Ready",
            "No offline movies available. Download one first.",
          ),
        );
        return true;
      }
      const options = movies.slice(0, 25).map((m) => ({
        label: `${m.title} ${m.year ? `(${m.year})` : ""}`.slice(0, 100),
        value: m.id,
      }));
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("cinema:schedule_select")
          .setPlaceholder("Pick a movie to schedule")
          .addOptions(options),
      );
      await interaction.reply({
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    case BTN.DOWNLOAD: {
      const progress = getDownloadProgress();
      if (!progress) {
        await interaction.reply(
          eReply("No Downloads", "Nothing is downloading right now."),
        );
        return true;
      }
      const pct =
        progress.totalBytes > 0
          ? `${Math.round((progress.bytes / progress.totalBytes) * 100)}%`
          : `${(progress.bytes / 1e6).toFixed(1)} MB`;
      const status =
        progress.state === "completed"
          ? "✅ Complete"
          : progress.state === "cancelled"
            ? "⏹️ Cancelled"
            : progress.state === "timed_out"
              ? "⏱️ Timed out"
              : progress.state === "failed"
                ? `❌ ${progress.error || "Failed"}`
                : progress.state === "cancelling"
                  ? "⏳ Cancelling"
                  : `⬇️ ${pct}`;
      await interaction.reply(
        eReply("Download Progress", `**${progress.filename}**\n${status}`),
      );
      return true;
    }

    case BTN.CANCEL: {
      const progress = getDownloadProgress();
      if (!progress || progress.state !== "running") {
        await interaction.reply(
          eReply("Nothing to Cancel", "No active download."),
        );
        return true;
      }
      const cancelled = cancelDownload(progress.jobId);
      if (!cancelled) {
        await interaction.reply(
          eReply("Nothing to Cancel", "That download already finished."),
        );
        return true;
      }

      await interaction.reply(
        eReply(
          "Cancellation Requested",
          `Stopping **${cancelled.filename}**. The partial file will be removed after the transfer closes.`,
        ),
      );
      await refreshDashboard();
      return true;
    }

    case BTN.ADD_MOVIE: {
      const modal = new ModalBuilder()
        .setCustomId("cinema:add_movie_modal")
        .setTitle("Add External Movie")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:add_title")
              .setLabel("Movie title (searches TMDB)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:add_url")
              .setLabel("GDrive or direct download URL")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:add_quality")
              .setLabel("Quality (e.g. 1080p, 4K)")
              .setStyle(TextInputStyle.Short)
              .setValue("1080p")
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:add_filename")
              .setLabel("Filename (e.g. movie-1080p.mkv)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    case BTN.LIBRARY: {
      const movies = getAllMovies();
      const offlineMovies = movies.filter((m) =>
        m.variants.some(
          (v) => v.status === "offline" || v.status === "downloaded",
        ),
      );
      if (offlineMovies.length === 0) {
        await interaction.reply(
          eReply(
            "Library Empty",
            "No offline files yet. Use **Add Movie** to add one.",
          ),
        );
        return true;
      }
      const list = offlineMovies
        .slice(0, 15)
        .map((m) => {
          const best = m.variants
            .filter((v) => v.status === "offline" || v.status === "downloaded")
            .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0];
          return `🟢 **${m.title}** ${m.year ? `(${m.year})` : ""} — ${best?.quality || "?"}`;
        })
        .join("\n");
      await interaction.reply(eReply("Offline Library", list));
      return true;
    }

    case BTN.REFRESH:
      await interaction.deferUpdate();
      await Promise.allSettled([refreshDashboard(), refreshShowtimesBoard()]);
      return true;

    default:
      return false;
  }
}

async function handlePick(interaction) {
  const match = interaction.customId.match(/^cinema:pick_(\d+)_(movie|tv)$/);
  if (!match) {
    await interaction.reply(eReply("Invalid Selection", "Search again."));
    return;
  }
  const [, tmdbId, type] = match;
  const cached = searchCache.get(interaction.user.id);
  const picked = cached?.results.find(
    (result) => String(result.id) === tmdbId && result.type === type,
  );
  if (!picked) {
    await interaction.reply(
      eReply("Expired", "Search results expired. Search again."),
    );
    return;
  }

  const movie = addMovie({
    title: picked.title,
    year: picked.year,
    tmdbId: picked.id,
    posterUrl: picked.poster,
    overview: picked.overview,
    mediaType: picked.type,
  });

  if (
    !movie.variants.some(
      (variant) =>
        variant.source === "Provider" &&
        variant.quality.toLowerCase() === "1080p",
    )
  ) {
    addVariant(movie.id, {
      quality: "1080p",
      source: "Provider",
      status: "available",
    });
  }

  const card = buildMovieCard(movie);
  await interaction.reply(card);
}

function parseTime(input) {
  const str = input.trim().toLowerCase();

  const ampm = str.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2]);
    if (h < 1 || h > 12 || m > 59) return null;
    if (ampm[3].toLowerCase() === "pm" && h !== 12) h += 12;
    if (ampm[3].toLowerCase() === "am" && h === 12) h = 0;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  const h24 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const hours = Number(h24[1]);
    const minutes = Number(h24[2]);
    if (hours > 23 || minutes > 59) return null;
    const d = new Date();
    d.setHours(hours, minutes, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  return null;
}

export async function handleCinemaModal(interaction) {
  if (!interaction.isModalSubmit()) return false;
  const id = interaction.customId;
  if (!id.startsWith("cinema:")) return false;
  if (!(await requireCinemaModerator(interaction))) return true;

  switch (true) {
    case id === "cinema:search_modal": {
      const query = interaction.fields
        .getTextInputValue("cinema:search_input")
        .trim();
      if (!query) {
        await interaction.reply(eReply("Missing", "Enter a title to search."));
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const results = await searchAll(query);
        if (results.length === 0) {
          await interaction.editReply(
            eReply("No Results", `Nothing found for "${query}".`),
          );
          return true;
        }

        cacheSearchResults(interaction.user.id, results);

        const payload = buildSearchResults(results);
        await interaction.editReply(payload);
      } catch (err) {
        await interaction.editReply(eReply("Error", err.message));
      }
      return true;
    }

    case id === "cinema:add_movie_modal": {
      const title = interaction.fields
        .getTextInputValue("cinema:add_title")
        .trim();
      const url = interaction.fields.getTextInputValue("cinema:add_url").trim();
      const quality = interaction.fields
        .getTextInputValue("cinema:add_quality")
        .trim();
      const filename = interaction.fields
        .getTextInputValue("cinema:add_filename")
        .trim();

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let request;
      try {
        request = await validateDownloadRequest(url, filename);
      } catch (error) {
        await interaction.editReply(eReply("Invalid Download", error.message));
        return true;
      }

      let movieData = null;
      try {
        const results = await searchAll(title);
        if (results.length > 0) movieData = results[0];
      } catch {}

      const movie = addMovie({
        title: movieData?.title || title,
        year: movieData?.year || "",
        tmdbId: movieData?.id || null,
        posterUrl: movieData?.poster || "",
        overview: movieData?.overview || "",
        mediaType: movieData?.type || "movie",
      });

      const variant = addVariant(movie.id, {
        quality,
        source: "External",
        status: "available",
      });
      try {
        await startBackgroundDownload(request, movie.id, variant.id);
      } catch (error) {
        await interaction.editReply(
          eReply("Download Not Started", error.message),
        );
        return true;
      }

      await interaction.editReply(
        eReply(
          "Adding & Downloading",
          `**${movie.title}** ${movie.year ? `(${movie.year})` : ""}\n${quality} · \`${request.filename}\`\nDownloading in background.`,
        ),
      );
      return true;
    }

    case id.startsWith("cinema:card_upload_modal:"): {
      const movieId = id.slice("cinema:card_upload_modal:".length);
      const url = interaction.fields.getTextInputValue("cinema:cul_url").trim();
      const quality = interaction.fields
        .getTextInputValue("cinema:cul_quality")
        .trim();
      const filename = interaction.fields
        .getTextInputValue("cinema:cul_filename")
        .trim();

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const movie = getMovie(movieId);
      if (!movie) {
        await interaction.editReply(
          eReply("Not Found", "Movie removed from library."),
        );
        return true;
      }

      let request;
      try {
        request = await validateDownloadRequest(url, filename);
      } catch (error) {
        await interaction.editReply(eReply("Invalid Download", error.message));
        return true;
      }

      const variant = addVariant(movie.id, {
        quality,
        source: "External",
        status: "available",
      });
      try {
        await startBackgroundDownload(request, movie.id, variant.id);
      } catch (error) {
        await interaction.editReply(
          eReply("Download Not Started", error.message),
        );
        return true;
      }
      await interaction.editReply(
        eReply(
          "Downloading",
          `**${movie.title}** ${quality}\nFile: \`${request.filename}\`\nRunning in background.`,
        ),
      );
      return true;
    }

    case id.startsWith("cinema:card_schedule_modal:"): {
      const movieId = id.slice("cinema:card_schedule_modal:".length);
      const timeStr = interaction.fields
        .getTextInputValue("cinema:cs_time")
        .trim();
      const screenNum = parsePositiveInteger(
        interaction.fields.getTextInputValue("cinema:cs_screen"),
      );

      const showtimeUnix = parseTime(timeStr);
      if (!showtimeUnix) {
        await interaction.reply(
          eReply("Invalid Time", "Use `8:30 PM` or `20:30`."),
        );
        return true;
      }
      const screen = screenNum ? getScreen(screenNum) : null;
      if (!screen) {
        await interaction.reply(
          eReply("Invalid Screen", "Enter a configured screen number."),
        );
        return true;
      }

      const movie = getMovie(movieId);
      if (!movie) {
        await interaction.reply(
          eReply("Not Found", "Movie removed from library."),
        );
        return true;
      }
      const variant = getBestVariant(movie.id);
      if (!variant) {
        await interaction.reply(
          eReply(
            "Movie Not Ready",
            "A verified offline media file is required before scheduling.",
          ),
        );
        return true;
      }

      const show = addShow({
        title: movie.title,
        year: movie.year,
        overview: movie.overview,
        posterUrl: movie.posterUrl,
        showtimeUnix,
        screenId: screen.id,
        tmdbId: movie.tmdbId,
        mediaType: movie.mediaType,
        playback: {
          version: 1,
          movieId: movie.id,
          variantId: variant.id,
        },
      });

      await interaction.reply(
        eReply(
          "Scheduled",
          `**${movie.title}** at <t:${showtimeUnix}:F> on **${screen.name}**.`,
        ),
      );
      await postAnnouncement(show);
      await Promise.allSettled([refreshDashboard(), refreshShowtimesBoard()]);
      return true;
    }

    default:
      return false;
  }
}

export async function handleCinemaSelect(interaction) {
  if (!interaction.isStringSelectMenu()) return false;
  if (!interaction.customId.startsWith("cinema:")) return false;
  if (!(await requireCinemaModerator(interaction))) return true;

  if (interaction.customId === "cinema:schedule_select") {
    const movieId = interaction.values[0];
    const modalId = movieModalId("cinema:card_schedule_modal:", movieId);
    if (!modalId || !getMovie(movieId) || !getBestVariant(movieId)) {
      await interaction.reply(
        eReply(
          "Movie Not Ready",
          "A verified offline media file is required before scheduling.",
        ),
      );
      return true;
    }
    const screens = getScreens();
    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle("Schedule Showtime")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cs_time")
            .setLabel("Time (e.g. 8:30 PM or 20:30)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cs_screen")
            .setLabel(`Screen (1-${screens.length || 3})`)
            .setStyle(TextInputStyle.Short)
            .setValue("1")
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  return false;
}
