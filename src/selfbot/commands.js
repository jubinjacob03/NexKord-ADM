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
  loadLibrary,
} from "../games/cinema/library.js";

const STREAM_COMMANDS = new Set(["movie", "tv", "play"]);
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

async function resolveVoiceChannel(message, client) {
  if (message.member?.voice?.channelId) {
    return {
      guildId: message.guildId,
      channelId: message.member.voice.channelId,
    };
  }

  const guildId = message.guildId || config.defaultGuildId;

  if (config.defaultVoiceChannelId && guildId) {
    return { guildId, channelId: config.defaultVoiceChannelId };
  }

  if (!guildId) return null;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;

  const channels = await guild.channels
    .fetch()
    .catch(() => guild.channels.cache);
  const voiceChannel = channels?.find(
    (c) => c?.type === "GUILD_VOICE" || c?.type === "GUILD_STAGE_VOICE",
  );

  return voiceChannel
    ? { guildId: guild.id, channelId: voiceChannel.id }
    : null;
}

async function prepareLocalCopy({ media, resolved, notice, header }) {
  const { file, cached } = await ensureLocalCopy({
    media,
    resolved,
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
}) {
  const vc = await resolveVoiceChannel(message, streamer.client);
  if (!vc) {
    await message.reply(
      ui.stack(
        ui.heading("no voice channel", "⚠️"),
        `Join a voice channel, or set \`DEFAULT_VOICE_CHANNEL_ID\` in \`.env\`.`,
      ),
    );
    return;
  }

  const notice = await message.reply(
    ui.stack(header, ui.subtext(ui.smallCaps("finding a source"))),
  );

  let playInput = directInput;
  let playOptions = {};
  let provider = null;

  if (media) {
    const resolved = await resolvePlayableStream(media, streamer.urlExtractor, {
      preferredServerIndex: panelManager.activeServerIndex,
    });
    playInput = resolved.url;
    playOptions = {
      headers: resolved.headers,
      sourceHint: { width: resolved.width, height: resolved.height },
    };

    if (panelManager.activeServerIndex !== resolved.serverIndex) {
      console.log(
        `[COMMAND] Sticking to ${resolved.serverName} for future requests.`,
      );
      panelManager.activeServerIndex = resolved.serverIndex;
      panelManager.saveStore();
    }

    if (config.prefetch.enabled) {
      try {
        playInput = await prepareLocalCopy({ media, resolved, notice, header });
        playOptions = {};
      } catch (err) {
        // A failed download should not kill the request. Streaming straight from
        // the CDN is worse, but it is better than nothing.
        console.warn(
          `[PREFETCH] Failed, falling back to direct streaming: ${err.message}`,
        );
        await notice
          .edit(
            ui.stack(
              header,
              ui.heading("download failed", "⚠️"),
              err.message,
              ui.subtext(ui.smallCaps("streaming directly instead")),
            ),
          )
          .catch(() => {});
      }
    }

    provider = resolved.serverName;
  }

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

  // Join only once the media is ready. Joining first would leave the bot sitting
  // silently in the channel for as long as preparation takes.
  await streamer.join(vc.guildId, vc.channelId);
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

  await panelManager.refreshPanel();
  await streamer.play(playInput, playOptions);
  await panelManager.refreshPanel();
}

export async function handleCommand(
  message,
  streamer,
  scheduler,
  panelManager,
) {
  if (!message.content?.startsWith(config.prefix)) return;
  if (message.author?.bot) return;

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
    await message
      .reply(
        ui.stack(
          ui.heading("already working", "⏳"),
          "A stream request is still in progress.",
          ui.subtext(
            `\`${config.prefix}stop\` ${ui.smallCaps("to cancel it")}`,
          ),
        ),
      )
      .catch(() => {});
    return;
  }

  console.log(
    `[COMMAND] ${message.author?.tag}: ${command} ${args.join(" ")}`.trim(),
  );

  if (STREAM_COMMANDS.has(command)) streamCommandInFlight = true;

  try {
    await dispatch({
      command,
      args,
      message,
      streamer,
      scheduler,
      panelManager,
    });
  } catch (err) {
    console.error(`[COMMAND] "${command}" failed: ${err.message}`);
    await message
      .reply(
        ui.stack(
          ui.heading("something went wrong", "⚠️"),
          err.message,
          ui.subtext(
            `${ui.smallCaps("command")} \`${config.prefix}${command}\``,
          ),
        ),
      )
      .catch(() => {});
  } finally {
    if (STREAM_COMMANDS.has(command)) streamCommandInFlight = false;
  }
}

async function dispatch({
  command,
  args,
  message,
  streamer,
  scheduler,
  panelManager,
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

      loadLibrary();
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

      const show = await findMedia(query, "tv");
      if (!show) {
        await message.reply(notFound(query));
        return;
      }

      await startStream({
        message,
        streamer,
        panelManager,
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
      const input = args.join(" ");
      if (!input) {
        await message.reply(usage("play <url or path>"));
        return;
      }

      await startStream({
        message,
        streamer,
        panelManager,
        directInput: input,
        header: ui.lines(ui.heading("direct stream", "▶️"), `\`${input}\``),
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

      await panelManager.refreshPanel();
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

      const movie = await findMedia(query, "movie");
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
        },
      );

      const file = await prepareLocalCopy({ media, resolved, notice, header });
      await notice
        .edit(
          ui.stack(
            ui.lines(
              ui.heading("ready", "✅"),
              ui.title(movie.title, movie.year),
            ),
            ui.subtext(
              `\`${config.prefix}movie ${query}\` ${ui.smallCaps("starts instantly now")}`,
            ),
          ),
        )
        .catch(() => {});
      console.log(`[PREFETCH] Prepared ${file}`);
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
        await panelManager.refreshPanel();
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

      const requested = Number.parseInt(args[0], 10);
      if (
        !Number.isFinite(requested) ||
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

      panelManager.activeServerIndex = clampServerIndex(requested);
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
      await panelManager.refreshPanel();
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
      await panelManager.refreshPanel();
      break;
    }

    case "join": {
      const vc = await resolveVoiceChannel(message, streamer.client);
      if (!vc) {
        await message.reply(
          ui.stack(
            ui.heading("no voice channel", "⚠️"),
            "Join a voice channel, or set `DEFAULT_VOICE_CHANNEL_ID` in `.env`.",
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
      await panelManager.refreshPanel();
      break;
    }

    case "leave": {
      await streamer.leave();
      await message.reply(ui.stack(ui.heading("left voice", "🚪")));
      await panelManager.refreshPanel();
      break;
    }

    default:
      break;
  }
}
