import { config } from "./config.js";
import * as ui from "./ui.js";
import { findMedia, searchTMDB } from "./tmdb.js";
import {
  SERVERS,
  clampServerIndex,
  resolvePlayableStream,
} from "./resolvers.js";
import {
  cacheKey,
  cacheUsage,
  cachedFile,
  clearPartials,
  ensureLocalCopy,
  removeFromCache,
} from "./prefetch.js";
import {
  findMovies as findLibraryMovies,
  getBestVariant,
  formatVariantList,
  loadLibraryReadOnly,
} from "../games/cinema/library.js";
import { validatePlayInput, validateRemoteMediaUrl } from "./mediaInput.js";
import { RequestedStreamStop } from "./streamer.js";

export { validatePlayInput };

const STREAM_COMMANDS = new Set(["movie", "tv", "play", "prepare"]);
const SEEN_MESSAGE_TTL_MS = 60000;

const seenMessages = new Map();
let streamCommandInFlight = false;

function alreadyHandled(messageId) {
  const now = Date.now();
  for (const [id, at] of seenMessages) {
    if (now - at <= SEEN_MESSAGE_TTL_MS) break;
    seenMessages.delete(id);
  }
  if (seenMessages.has(messageId)) return true;
  seenMessages.set(messageId, now);
  return false;
}

function serverList() {
  return SERVERS.map((server, index) => `\`${index}\`: ${server.name}`).join(
    ", ",
  );
}

function usage(syntax, note) {
  return ui.stack(
    ui.heading("usage", "❔"),
    `\`${config.prefix}${syntax}\``,
    note && ui.subtext(note),
  );
}

function notFound(query) {
  return ui.stack(
    ui.heading("not found", "🔍"),
    `Nothing on TMDB for "${query}".`,
    ui.subtext(
      `\`${config.prefix}search ${query}\` ${ui.smallCaps("to see close matches")}`,
    ),
  );
}

function splitTimeInput(args) {
  const tokens = [...args];
  const timeInput = tokens.pop();
  if (tokens[tokens.length - 1]?.toLowerCase() === "in") tokens.pop();
  return { query: tokens.join(" ").trim(), timeInput };
}

function splitSeasonEpisode(args) {
  const tokens = [...args];
  let season = 1;
  let episode = 1;

  const compact = tokens[tokens.length - 1]?.match(/^s(\d{1,2})e(\d{1,3})$/i);
  if (compact && tokens.length > 1) {
    tokens.pop();
    season = Number.parseInt(compact[1], 10);
    episode = Number.parseInt(compact[2], 10);
    return { query: tokens.join(" ").trim(), season, episode };
  }

  const isNumber = (value) => /^\d{1,3}$/.test(value ?? "");
  if (
    tokens.length >= 3 &&
    isNumber(tokens[tokens.length - 1]) &&
    isNumber(tokens[tokens.length - 2])
  ) {
    episode = Number.parseInt(tokens.pop(), 10);
    season = Number.parseInt(tokens.pop(), 10);
  }

  return { query: tokens.join(" ").trim(), season, episode };
}

function isAuthorizedCommand(message) {
  if (
    !config.defaultGuildId ||
    !config.defaultChannelId ||
    !config.controllerId
  ) {
    return false;
  }
  if (message.guildId !== config.defaultGuildId) return false;
  if (message.channelId !== config.defaultChannelId) return false;
  const allowedSenders = new Set([config.controllerId, ...config.operatorIds]);
  return allowedSenders.has(message.author?.id);
}

async function resolveVoiceChannel() {
  if (!config.defaultGuildId || !config.defaultVoiceChannelId) return null;
  return {
    guildId: config.defaultGuildId,
    channelId: config.defaultVoiceChannelId,
  };
}

async function prepareLocalCopy({ media, resolved, notice, header, signal }) {
  const { file, cached } = await ensureLocalCopy({
    media,
    resolved,
    signal,
    onPlan: ({ plan, durationSeconds }) => {
      const estimateGB =
        durationSeconds > 0
          ? (durationSeconds * plan.estimatedBytesPerSecond) / 1e9
          : 0;
      notice
        .edit(
          ui.stack(
            header,
            ui.heading("preparing", "⏳"),
            ui.subtext(
              plan.reason.join(" · "),
              ui.minutes(durationSeconds) &&
                `${ui.smallCaps("runtime")} ${ui.minutes(durationSeconds)}`,
              durationSeconds > 0 &&
                `~${Math.round(durationSeconds / 60 / 2.9)}m ${ui.smallCaps("to download")}`,
              estimateGB > 0 && `~${estimateGB.toFixed(1)} GB`,
            ),
          ),
        )
        .catch(() => {});
    },
    onProgress: ({ mediaSeconds, speed, bytes, durationSeconds }) => {
      const fraction = durationSeconds > 0 ? mediaSeconds / durationSeconds : 0;
      const etaMinutes =
        durationSeconds > 0 && speed > 0
          ? Math.max(
              0,
              Math.round((durationSeconds - mediaSeconds) / speed / 60),
            )
          : null;
      notice
        .edit(
          ui.stack(
            header,
            ui.heading("downloading", "⬇️"),
            durationSeconds > 0 ? ui.progressBar(fraction) : null,
            ui.subtext(
              `${ui.minutes(mediaSeconds) ?? "0m"} ${ui.smallCaps("of")} ${ui.minutes(durationSeconds) ?? "?"}`,
              ui.gigabytes(bytes),
              `${speed.toFixed(2)}×`,
              etaMinutes !== null && `~${etaMinutes}m ${ui.smallCaps("left")}`,
            ),
          ),
        )
        .catch(() => {});
    },
  });

  if (cached) {
    await notice
      .edit(ui.stack(header, ui.subtext(ui.smallCaps("ready from cache"))))
      .catch(() => {});
  }
  return file;
}

async function startStream({
  message,
  streamer,
  panelManager,
  media,
  directInput,
  header,
  preparation,
}) {
  if (!preparation) throw new Error("Media preparation was not reserved.");
  const signal = preparation.controller.signal;
  signal.throwIfAborted();
  const vc = await resolveVoiceChannel();
  if (!vc) {
    await message.reply(
      ui.stack(
        ui.heading("no voice channel", "⚠️"),
        `Join a voice channel, or set \`SELFBOT_VOICE_CHANNEL_ID\` in \`.env\`.`,
      ),
    );
    return;
  }

  const notice = await message.reply(
    ui.stack(header, ui.subtext(ui.smallCaps("finding a source"))),
  );
  signal.throwIfAborted();
  let playInput = directInput;
  let playOptions = {};
  let provider = null;

  try {
    if (media) {
      const resolved = await resolvePlayableStream(
        media,
        streamer.urlExtractor,
        {
          preferredServerIndex: panelManager.activeServerIndex,
          signal,
        },
      );
      const source = {
        ...resolved,
        url: await validateRemoteMediaUrl(resolved.url),
      };
      signal.throwIfAborted();
      playInput = source.url;
      playOptions = {
        headers: source.headers,
        sourceHint: { width: source.width, height: source.height },
      };

      if (panelManager.activeServerIndex !== source.serverIndex) {
        console.log(
          `[COMMAND] Sticking to ${source.serverName} for future requests.`,
        );
        panelManager.setActiveServerIndex(source.serverIndex);
      }

      if (config.prefetch.enabled) {
        try {
          playInput = await prepareLocalCopy({
            media,
            resolved: source,
            notice,
            header,
            signal,
          });
          playOptions = {};
        } catch (err) {
          if (err instanceof RequestedStreamStop) {
            console.log("[PREFETCH] Preparation cancelled by a stop request.");
            throw err;
          }
          console.warn(`[PREFETCH] Preparation failed: ${err.message}`);
          await notice
            .edit(
              ui.stack(
                header,
                ui.heading("download failed", "⚠️"),
                "The title could not be prepared safely for playback.",
              ),
            )
            .catch(() => {});
          throw err;
        }
      }

      provider = source.serverName;
    }

    signal.throwIfAborted();
    await notice
      .edit(
        ui.stack(
          header,
          ui.subtext(
            provider && `${ui.smallCaps("provider")} ${provider}`,
            `${ui.smallCaps("joining")} ${ui.channelMention(vc.channelId)}`,
          ),
        ),
      )
      .catch(() => {});

    signal.throwIfAborted();
    await streamer.join(vc.guildId, vc.channelId, signal);
    signal.throwIfAborted();
    await notice
      .edit(
        ui.stack(
          header,
          ui.subtext(
            `▶️ ${ui.smallCaps("live in")} ${ui.channelMention(vc.channelId)}`,
            provider && provider,
          ),
        ),
      )
      .catch(() => {});
    signal.throwIfAborted();
  } catch (error) {
    streamer.completePreparation(preparation);
    throw error;
  }

  streamer.completePreparation(preparation);
  const { playback } = await streamer.play(playInput, playOptions);
  void playback
    .catch(async (error) => {
      console.error(`[COMMAND] Playback failed: ${error.message}`);
      await notice.edit(
        ui.stack(
          header,
          ui.heading("playback failed", "⚠️"),
          "The media pipeline stopped unexpectedly.",
        ),
      );
    })
    .catch((error) => {
      console.error(
        `[COMMAND] Could not report playback failure: ${error.message}`,
      );
    });
}

export async function handleCommand(
  message,
  streamer,
  scheduler,
  panelManager,
) {
  if (!message.content?.startsWith(config.prefix)) return;
  if (!isAuthorizedCommand(message)) return;

  if (alreadyHandled(message.id)) {
    console.warn(
      `[COMMAND] Duplicate gateway delivery for message ${message.id} ignored.`,
    );
    return;
  }

  const args = message.content.slice(config.prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  if (STREAM_COMMANDS.has(command) && streamCommandInFlight) {
    console.log(
      `[COMMAND] "${command}" ignored: another stream request is still resolving.`,
    );
    await message.reply(
      ui.stack(
        ui.heading("already working", "⏳"),
        "A stream request is still in progress.",
        ui.subtext(`\`${config.prefix}stop\` ${ui.smallCaps("to cancel it")}`),
      ),
    );
    return;
  }

  console.log(`[COMMAND] ${message.author?.id || "unknown"}: ${command}`);

  const managesPreparation = STREAM_COMMANDS.has(command);
  let preparation = null;
  if (managesPreparation) {
    try {
      preparation = streamer.beginPreparation();
    } catch {
      console.log(
        `[COMMAND] "${command}" ignored: media preparation is already active.`,
      );
      await message.reply(
        ui.stack(
          ui.heading("already working", "⏳"),
          "Another title is still being prepared.",
          ui.subtext(
            `\`${config.prefix}stop\` ${ui.smallCaps("to cancel it")}`,
          ),
        ),
      );
      return;
    }
    streamCommandInFlight = true;
  }

  try {
    await dispatch({
      command,
      args,
      message,
      streamer,
      scheduler,
      panelManager,
      preparation,
    });
  } catch (err) {
    if (err instanceof RequestedStreamStop) {
      console.log(`[COMMAND] "${command}" was cancelled by a stop request.`);
    } else {
      console.error(`[COMMAND] "${command}" failed: ${err.message}`);
      await message.reply(
        ui.stack(
          ui.heading("something went wrong", "⚠️"),
          "The request could not be completed. Check the bot logs for details.",
          ui.subtext(
            `${ui.smallCaps("command")} \`${config.prefix}${command}\``,
          ),
        ),
      );
    }
  } finally {
    streamer.completePreparation(preparation);
    if (managesPreparation) streamCommandInFlight = false;
  }
}

async function dispatch({
  command,
  args,
  message,
  streamer,
  scheduler,
  panelManager,
  preparation,
}) {
  switch (command) {
    case "help": {
      const p = config.prefix;
      const cacheInfo = cacheUsage();
      await message.reply(
        ui.stack(
          `# 🍿 ${ui.smallCaps("nexkord cinema")}`,
          ui.lines(
            ui.label("playback"),
            `\`${p}movie <title>\` — download, then stream a film`,
            `\`${p}tv <title> [season] [episode]\` — an episode, \`s1e2\` also works`,
            `\`${p}play <url or path>\` — a direct URL or local file`,
          ),
          ui.lines(
            ui.label("library"),
            `\`${p}prepare <title>\` — download ahead of a showing`,
            `\`${p}cache\` — list cached titles`,
            `\`${p}cache remove <title>\` — free space`,
          ),
          ui.lines(
            ui.label("showtimes"),
            `\`${p}schedule <title> <time>\` — \`20:30\` or \`in 15m\``,
            `\`${p}shows\` — upcoming showtimes`,
            `\`${p}cancel <id>\` — cancel one`,
          ),
          ui.lines(
            ui.label("session"),
            `\`${p}status\`  \`${p}stop\`  \`${p}join\`  \`${p}leave\``,
            `\`${p}server [0-${SERVERS.length - 1}]\` — ${serverList()}`,
          ),
          ui.subtext(
            `${ui.smallCaps("provider")} ${SERVERS[panelManager.activeServerIndex].name}`,
            `${ui.smallCaps("cache")} ${(cacheInfo.bytes / 1e9).toFixed(1)} / ${(cacheInfo.limitBytes / 1e9).toFixed(0)} GB`,
          ),
        ),
      );
      break;
    }

    case "movie": {
      const query = args.join(" ");
      if (!query) {
        await message.reply(usage("movie <title>"));
        return;
      }

      preparation.controller.signal.throwIfAborted();
      loadLibraryReadOnly();
      preparation.controller.signal.throwIfAborted();
      const libraryResults = findLibraryMovies(query);

      if (libraryResults.length === 0) {
        await message.reply(
          ui.stack(
            ui.heading("not in library", "📂"),
            `"${query}" is not in the offline library.`,
            ui.subtext("ask a moderator to add and download it first"),
          ),
        );
        return;
      }

      const match = libraryResults[0];
      const best = getBestVariant(match.id);

      if (
        !best?.filePath ||
        (best.status !== "offline" && best.status !== "downloaded")
      ) {
        const variantList = formatVariantList(match);
        await message.reply(
          ui.stack(
            ui.lines(
              ui.heading("not ready", "⏳"),
              ui.title(match.title, match.year),
            ),
            variantList,
            ui.subtext("no offline file available yet — download it first"),
          ),
        );
        return;
      }

      await startStream({
        message,
        streamer,
        panelManager,
        preparation,
        directInput: best.filePath,
        header: ui.lines(
          ui.heading("now playing", "🎬"),
          ui.title(match.title, match.year),
          ui.subtext(`${best.quality} · ${best.source}`),
        ),
      });
      break;
    }

    case "tv": {
      if (args.length === 0) {
        await message.reply(
          usage("tv <title> [season] [episode]", "`s1e2` also works"),
        );
        return;
      }

      const { query, season, episode } = splitSeasonEpisode(args);
      if (!query) {
        await message.reply(
          usage("tv <title> [season] [episode]", "`s1e2` also works"),
        );
        return;
      }

      const show = await findMedia(query, "tv", {
        signal: preparation.controller.signal,
      });
      if (!show) {
        await message.reply(notFound(query));
        return;
      }

      await startStream({
        message,
        streamer,
        panelManager,
        preparation,
        media: {
          tmdbId: show.id,
          type: "tv",
          season,
          episode,
          label: `${show.title} S${season}E${episode}`,
        },
        header: ui.lines(
          ui.heading("now playing", "📺"),
          `**${show.title}** · S${season}E${episode}`,
        ),
      });
      break;
    }

    case "play": {
      const requestedInput = args.join(" ");
      if (!requestedInput) {
        await message.reply(usage("play <url or path>"));
        return;
      }
      preparation.controller.signal.throwIfAborted();
      const validated = await validatePlayInput(requestedInput);
      preparation.controller.signal.throwIfAborted();

      await startStream({
        message,
        streamer,
        panelManager,
        preparation,
        directInput: validated.input,
        header: ui.lines(
          ui.heading("direct stream", "▶️"),
          `\`${validated.label}\``,
        ),
      });
      break;
    }

    case "schedule": {
      if (args.length < 2) {
        await message.reply(
          `Usage: \`${config.prefix}schedule <title> <time>\` — e.g. \`${config.prefix}schedule Interstellar 21:00\``,
        );
        return;
      }

      const { query, timeInput } = splitTimeInput(args);
      if (!query) {
        await message.reply(
          usage("schedule <title> <time>", "`20:30` or `in 15m`"),
        );
        return;
      }

      const media = await findMedia(query);
      if (!media) {
        await message.reply(notFound(query));
        return;
      }

      const show = scheduler.addShow({
        title: media.year ? `${media.title} (${media.year})` : media.title,
        tmdbId: media.id,
        mediaType: media.type,
        timeInput,
        serverIndex: panelManager.activeServerIndex,
      });

      const unixTs = Math.floor(show.showtime / 1000);
      await message.reply(
        ui.stack(
          ui.lines(ui.heading("showtime scheduled", "📅"), `**${show.title}**`),
          ui.lines(
            `${ui.label("starts")} ${ui.fullTime(unixTs)}`,
            `${ui.label("that is")} ${ui.relativeTime(unixTs)}`,
          ),
          ui.subtext(
            `${ui.smallCaps("provider")} ${SERVERS[show.serverIndex].name}`,
            `${ui.smallCaps("id")} \`${show.shortId}\``,
          ),
        ),
      );

      break;
    }

    case "prepare": {
      const query = args.join(" ");
      if (!query) {
        await message.reply(
          usage("prepare <title>", "downloads ahead of a showing"),
        );
        return;
      }

      const signal = preparation.controller.signal;
      const movie = await findMedia(query, "movie", { signal });
      if (!movie) {
        await message.reply(notFound(query));
        return;
      }

      const media = {
        tmdbId: movie.id,
        type: "movie",
        label: movie.year ? `${movie.title} (${movie.year})` : movie.title,
      };
      const key = cacheKey(media);
      if (cachedFile(key)) {
        await message.reply(
          ui.stack(
            ui.lines(
              ui.heading("already ready", "✅"),
              ui.title(movie.title, movie.year),
            ),
            ui.subtext(ui.smallCaps("starts instantly")),
          ),
        );
        return;
      }

      const header = ui.lines(
        ui.heading("preparing", "📦"),
        ui.title(movie.title, movie.year),
      );
      const notice = await message.reply(
        ui.stack(header, ui.subtext(ui.smallCaps("finding a source"))),
      );

      const resolved = await resolvePlayableStream(
        media,
        streamer.urlExtractor,
        {
          preferredServerIndex: panelManager.activeServerIndex,
          signal,
        },
      );

      await prepareLocalCopy({ media, resolved, notice, header, signal });
      try {
        await notice.edit(
          ui.stack(
            ui.lines(
              ui.heading("ready", "✅"),
              ui.title(movie.title, movie.year),
            ),
            ui.subtext(
              `\`${config.prefix}movie ${query}\` ${ui.smallCaps("starts instantly now")}`,
            ),
          ),
        );
      } catch {
        console.warn(
          "[PREFETCH] Could not update the completed preparation notice.",
        );
      }
      console.log(`[PREFETCH] Prepared ${key}`);
      break;
    }

    case "cache": {
      const [action, ...rest] = args;
      const target = rest.join(" ");

      if (!action || action === "list") {
        const { entries, bytes, limitBytes } = cacheUsage();
        if (entries.length === 0) {
          await message.reply(
            ui.stack(
              ui.heading("library", "💾"),
              `-# ${ui.smallCaps("nothing cached yet")}`,
            ),
          );
          return;
        }
        const rows = entries.map((entry, index) =>
          ui.lines(
            `**${index + 1}.** ${entry.label}`,
            `-# ${(entry.bytes / 1e9).toFixed(2)} GB · \`${entry.key}\``,
          ),
        );
        await message.reply(
          ui.stack(
            ui.heading("library", "💾"),
            ui.progressBar(bytes / limitBytes),
            rows.join("\n\n"),
            ui.subtext(
              `${(bytes / 1e9).toFixed(1)} / ${(limitBytes / 1e9).toFixed(0)} GB`,
              `${entries.length} ${ui.smallCaps(entries.length === 1 ? "title" : "titles")}`,
              `\`${config.prefix}cache remove <title>\``,
            ),
          ),
        );
        return;
      }

      if (action === "remove" || action === "delete" || action === "rm") {
        if (!target) {
          await message.reply(usage("cache remove <title>"));
          return;
        }
        const removed = removeFromCache(target);
        if (!removed) {
          await message.reply(
            ui.stack(
              ui.heading("no match", "🔍"),
              `Nothing cached matches "${target}".`,
              ui.subtext(
                `\`${config.prefix}cache\` ${ui.smallCaps("lists what is stored")}`,
              ),
            ),
          );
          return;
        }
        const { bytes, limitBytes } = cacheUsage();
        await message.reply(
          ui.stack(
            ui.lines(ui.heading("removed", "🗑️"), `**${removed.label}**`),
            ui.subtext(
              `${ui.smallCaps("freed")} ${(removed.bytes / 1e9).toFixed(2)} GB`,
              `${ui.smallCaps("now")} ${(bytes / 1e9).toFixed(1)} / ${(limitBytes / 1e9).toFixed(0)} GB`,
            ),
          ),
        );
        return;
      }

      if (action === "partials") {
        const { count, bytes } = clearPartials();
        await message.reply(
          count > 0
            ? ui.stack(
                ui.heading("cleaned up", "🧹"),
                ui.subtext(
                  `${count} ${ui.smallCaps(count === 1 ? "unfinished download" : "unfinished downloads")}`,
                  ui.gigabytes(bytes) &&
                    `${ui.smallCaps("freed")} ${ui.gigabytes(bytes)}`,
                ),
              )
            : ui.stack(ui.heading("nothing to clean", "🧹")),
        );
        return;
      }

      await message.reply(
        ui.stack(
          ui.heading("cache", "💾"),
          ui.lines(
            `\`${config.prefix}cache\` — list what is stored`,
            `\`${config.prefix}cache remove <title>\` — free space`,
            `\`${config.prefix}cache partials\` — clear unfinished downloads`,
          ),
        ),
      );
      break;
    }

    case "shows":
    case "timetable": {
      const upcoming = scheduler.getUpcoming();
      if (upcoming.length === 0) {
        await message.reply(
          ui.stack(
            ui.heading("showtimes", "📅"),
            `-# ${ui.smallCaps("nothing scheduled")}`,
            ui.subtext(`\`${config.prefix}schedule <title> <time>\``),
          ),
        );
        return;
      }

      const rows = upcoming.map((show, index) => {
        const at = Math.floor(show.showtime / 1000);
        return ui.lines(
          `**${index + 1}.** ${show.title}`,
          `-# ${ui.fullTime(at)} · ${ui.relativeTime(at)} · \`${show.shortId}\``,
        );
      });

      await message.reply(
        ui.stack(
          ui.heading("showtimes", "📅"),
          rows.join("\n\n"),
          ui.subtext(
            `\`${config.prefix}cancel <id>\` ${ui.smallCaps("to remove one")}`,
          ),
        ),
      );
      break;
    }

    case "cancel": {
      const id = args[0];
      if (!id) {
        await message.reply(usage("cancel <id>"));
        return;
      }

      if (scheduler.cancelShow(id)) {
        await message.reply(
          ui.stack(
            ui.heading("showtime cancelled", "🚫"),
            ui.subtext(`${ui.smallCaps("id")} \`${id}\``),
          ),
        );
      } else {
        await message.reply(
          ui.stack(
            ui.heading("no match", "🔍"),
            `No scheduled showtime with ID \`${id}\`.`,
            ui.subtext(
              `\`${config.prefix}shows\` ${ui.smallCaps("lists them")}`,
            ),
          ),
        );
      }
      break;
    }

    case "server": {
      if (args.length === 0) {
        await message.reply(
          ui.stack(
            ui.lines(
              ui.heading("provider", "🛰️"),
              `**${SERVERS[panelManager.activeServerIndex].name}**`,
            ),
            ui.subtext(`${ui.smallCaps("available")} ${serverList()}`),
          ),
        );
        return;
      }

      const requested = /^\d+$/.test(args[0]) ? Number(args[0]) : NaN;
      if (
        !Number.isSafeInteger(requested) ||
        requested < 0 ||
        requested >= SERVERS.length
      ) {
        await message.reply(
          ui.stack(
            ui.heading("invalid index", "⚠️"),
            `Choose between 0 and ${SERVERS.length - 1}.`,
            ui.subtext(serverList()),
          ),
        );
        return;
      }

      panelManager.setActiveServerIndex(clampServerIndex(requested));
      await message.reply(
        ui.stack(
          ui.lines(
            ui.heading("provider switched", "🛰️"),
            `**${SERVERS[panelManager.activeServerIndex].name}**`,
          ),
          ui.subtext(
            `${ui.smallCaps("index")} ${panelManager.activeServerIndex}`,
          ),
        ),
      );
      break;
    }

    case "search": {
      const query = args.join(" ");
      if (!query) {
        await message.reply(usage("search <title>"));
        return;
      }

      const results = (await searchTMDB(query)).slice(0, 5);
      if (results.length === 0) {
        await message.reply(
          ui.stack(
            ui.heading("no results", "🔍"),
            `Nothing on TMDB for "${query}".`,
          ),
        );
        return;
      }

      const rows = results.map(
        (item, index) =>
          `**${index + 1}.** ${item.title}${item.year ? ` · ${item.year}` : ""} ` +
          `-# ${ui.smallCaps(item.type)}`,
      );

      await message.reply(
        ui.stack(
          ui.heading("search results", "🔍"),
          ui.lines(rows),
          ui.subtext(`${ui.smallCaps("query")} ${query}`),
        ),
      );
      break;
    }

    case "status": {
      const status = streamer.getStatus();
      const cacheInfo = cacheUsage();
      await message.reply(
        ui.stack(
          ui.heading(
            status.isStreaming ? "streaming" : "idle",
            status.isStreaming ? "🔴" : "⚪",
          ),
          ui.lines(
            `${ui.label("voice")} ${ui.channelMention(status.currentChannelId) ?? `\`${ui.smallCaps("disconnected")}\``}`,
            `${ui.label("provider")} ${SERVERS[panelManager.activeServerIndex].name}`,
            `${ui.label("showtimes")} ${scheduler.getUpcoming().length}`,
          ),
          ui.subtext(
            `${ui.smallCaps("cache")} ${(cacheInfo.bytes / 1e9).toFixed(1)} / ${(cacheInfo.limitBytes / 1e9).toFixed(0)} GB`,
            `${cacheInfo.entries.length} ${ui.smallCaps("titles")}`,
          ),
        ),
      );
      break;
    }

    case "stop": {
      await streamer.stop();
      await message.reply(ui.stack(ui.heading("stream stopped", "⏹️")));
      break;
    }

    case "join": {
      const vc = await resolveVoiceChannel();
      if (!vc) {
        await message.reply(
          ui.stack(
            ui.heading("no voice channel", "⚠️"),
            "Set `SELFBOT_GUILD_ID` and `SELFBOT_VOICE_CHANNEL_ID` in `.env`.",
          ),
        );
        return;
      }

      await streamer.join(vc.guildId, vc.channelId);
      await message.reply(
        ui.stack(
          ui.heading("joined", "🎙️"),
          ui.subtext(ui.channelMention(vc.channelId)),
        ),
      );
      break;
    }

    case "leave": {
      if (config.stayInVoice) {
        await message.reply(
          ui.stack(
            ui.heading("voice hold enabled", "🎙️"),
            "Disable `SELFBOT_STAY_IN_VC` to allow manual disconnects.",
          ),
        );
        return;
      }
      await streamer.leave();
      await message.reply(ui.stack(ui.heading("left voice", "🚪")));
      break;
    }

    default:
      break;
  }
}
