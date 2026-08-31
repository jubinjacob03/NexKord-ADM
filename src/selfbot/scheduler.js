import path from "node:path";
import { clampServerIndex, resolvePlayableStream } from "./resolvers.js";
import { ensureLocalCopy } from "./prefetch.js";
import { config } from "./config.js";
import { validateRemoteMediaUrl } from "./mediaInput.js";
import {
  readJsonFileSync,
  writeJsonFileAtomicSync,
} from "../utils/jsonStore.js";

const dataDir = path.join(process.cwd(), "data");
const scheduleFile = path.join(dataDir, "schedule.json");
const TICK_INTERVAL_MS = 10000;
const validStatuses = new Set([
  "scheduled",
  "live",
  "finished",
  "failed",
  "cancelled",
]);

function validSchedule(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (show) =>
        show &&
        typeof show.id === "string" &&
        typeof show.shortId === "string" &&
        typeof show.title === "string" &&
        (typeof show.tmdbId === "string" ||
          Number.isSafeInteger(show.tmdbId)) &&
        (show.mediaType === "movie" || show.mediaType === "tv") &&
        Number.isSafeInteger(show.season) &&
        show.season > 0 &&
        Number.isSafeInteger(show.episode) &&
        show.episode > 0 &&
        Number.isSafeInteger(show.showtime) &&
        Number.isSafeInteger(show.serverIndex) &&
        Number.isSafeInteger(show.addedAt) &&
        validStatuses.has(show.status),
    )
  );
}

export class TheaterScheduler {
  constructor() {
    this.schedule = [];
    this.timerInterval = null;
    this.tickRunning = false;
    this.load();
  }

  load() {
    this.schedule = readJsonFileSync(scheduleFile, {
      fallback: [],
      validate: validSchedule,
      label: "selfbot schedule",
    });

    let recovered = 0;
    for (const show of this.schedule) {
      if (show.status === "live") {
        show.status = "failed";
        show.error = "Playback was interrupted by a process restart.";
        recovered += 1;
      }
    }
    if (recovered > 0) {
      console.log(
        `[SCHEDULER] Marked ${recovered} interrupted show(s) as failed.`,
      );
      this.save();
    }
  }

  save() {
    writeJsonFileAtomicSync(scheduleFile, this.schedule);
  }

  parseTimeInput(timeInput) {
    const now = Date.now();
    const str = String(timeInput || "")
      .trim()
      .toLowerCase();

    const relative = str.match(/^(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)$/);
    if (relative) {
      const amount = Number(relative[1]);
      const maximum = relative[2].startsWith("h") ? 168 : 10080;
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > maximum) {
        throw new Error(
          "Relative showtime must be between one minute and seven days.",
        );
      }
      const unitMs = relative[2].startsWith("h") ? 3600000 : 60000;
      return now + amount * unitMs;
    }

    const clock = str.match(/^(\d{1,2}):(\d{2})$/);
    if (clock) {
      const hours = Number(clock[1]);
      const minutes = Number(clock[2]);
      if (hours > 23 || minutes > 59) {
        throw new Error(
          "Invalid clock time. Hours must be 0-23 and minutes 0-59.",
        );
      }
      const target = new Date();
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() <= now) target.setDate(target.getDate() + 1);
      return target.getTime();
    }

    const absolute = Date.parse(timeInput);
    if (!Number.isNaN(absolute) && absolute > now) return absolute;

    throw new Error(
      'Invalid time format. Use a relative offset ("15m", "2h") or a 24h clock time ("20:30").',
    );
  }

  addShow(item) {
    const showtime = this.parseTimeInput(item.timeInput);
    const shortId = Math.random().toString(36).slice(2, 8);
    const show = {
      id: `show_${Date.now()}_${shortId}`,
      shortId,
      title: String(item.title || "Untitled").slice(0, 200),
      tmdbId: item.tmdbId,
      mediaType: item.mediaType === "tv" ? "tv" : "movie",
      season:
        Number.isSafeInteger(item.season) && item.season > 0 ? item.season : 1,
      episode:
        Number.isSafeInteger(item.episode) && item.episode > 0
          ? item.episode
          : 1,
      showtime,
      serverIndex: clampServerIndex(item.serverIndex ?? 0),
      status: "scheduled",
      addedAt: Date.now(),
    };

    this.schedule.push(show);
    this.schedule.sort((a, b) => a.showtime - b.showtime);
    try {
      this.save();
    } catch (error) {
      this.schedule = this.schedule.filter((entry) => entry !== show);
      throw error;
    }
    return show;
  }

  findShow(id) {
    const needle = String(id || "").trim();
    if (!needle) return null;
    return (
      this.schedule.find(
        (show) => show.id === needle || show.shortId === needle,
      ) || null
    );
  }

  cancelShow(id) {
    const show = this.findShow(id);
    if (!show || show.status !== "scheduled") return false;
    show.status = "cancelled";
    try {
      this.save();
    } catch (error) {
      show.status = "scheduled";
      throw error;
    }
    return true;
  }

  getUpcoming() {
    const now = Date.now();
    return this.schedule.filter(
      (show) => show.status === "scheduled" && show.showtime > now,
    );
  }

  getDueShow() {
    const now = Date.now();
    return (
      this.schedule.find(
        (show) => show.status === "scheduled" && now >= show.showtime,
      ) || null
    );
  }

  startTimerLoop(streamer, notifyCallback) {
    this.stopTimerLoop();
    this.timerInterval = setInterval(() => {
      this.tick(streamer, notifyCallback).catch((error) => {
        console.error(`[SCHEDULER] Tick failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timerInterval.unref?.();
  }

  stopTimerLoop() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  async tick(streamer, notifyCallback) {
    if (this.tickRunning || streamer.isStreaming || streamer.isPreparing)
      return;

    const show = this.getDueShow();
    if (!show) return;

    const guildId = config.defaultGuildId;
    const voiceChannelId = config.defaultVoiceChannelId;
    if (!guildId || !voiceChannelId) {
      show.status = "failed";
      show.error = "Missing SELFBOT_GUILD_ID or SELFBOT_VOICE_CHANNEL_ID.";
      this.save();
      return;
    }

    const preparation = streamer.beginPreparation();
    const signal = preparation.controller.signal;
    let handedOff = false;
    this.tickRunning = true;
    show.status = "live";
    try {
      this.save();
    } catch (error) {
      show.status = "scheduled";
      this.tickRunning = false;
      streamer.completePreparation(preparation);
      throw error;
    }

    try {
      const media = {
        tmdbId: show.tmdbId,
        type: show.mediaType,
        season: show.season,
        episode: show.episode,
      };

      const resolved = await resolvePlayableStream(
        media,
        streamer.urlExtractor,
        {
          preferredServerIndex: show.serverIndex,
          signal,
        },
      );
      const source = {
        ...resolved,
        url: await validateRemoteMediaUrl(resolved.url),
      };
      signal.throwIfAborted();

      let input = source.url;
      let playOptions = {
        headers: source.headers,
        sourceHint: { width: source.width, height: source.height },
      };

      if (config.prefetch.enabled) {
        const { file, cached } = await ensureLocalCopy({
          media,
          resolved: source,
          signal,
          onProgress: ({ mediaSeconds, speed, durationSeconds }) => {
            const pct =
              durationSeconds > 0
                ? ` (${Math.round((mediaSeconds / durationSeconds) * 100)}%)`
                : "";
            console.log(
              `[SCHEDULER] Downloading "${show.title}"${pct} at ${speed.toFixed(2)}x`,
            );
          },
        });
        input = file;
        playOptions = {};
        if (!cached) {
          console.log(`[SCHEDULER] Downloaded "${show.title}" ready to play.`);
        }
      }

      signal.throwIfAborted();
      if (notifyCallback) await notifyCallback(show, source);
      signal.throwIfAborted();
      await streamer.join(guildId, voiceChannelId, signal);
      signal.throwIfAborted();
      streamer.completePreparation(preparation);
      handedOff = true;
      const { playback } = await streamer.play(input, playOptions);
      await playback;
      show.status = "finished";
      delete show.error;
    } catch (error) {
      console.error(
        `[SCHEDULER] Show "${show.title}" failed: ${error.message}`,
      );
      show.status = "failed";
      show.error = "Scheduled playback failed. See logs for details.";
    } finally {
      if (!handedOff) streamer.completePreparation(preparation);
      this.tickRunning = false;
      this.save();
    }
  }
}
