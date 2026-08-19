import fs from "fs";
import path from "path";
import { resolvePlayableStream } from "./resolvers.js";
import { ensureLocalCopy } from "./prefetch.js";
import { config } from "./config.js";

const dataDir = path.join(process.cwd(), "data");
const scheduleFile = path.join(dataDir, "schedule.json");
const TICK_INTERVAL_MS = 10000;

export class TheaterScheduler {
  constructor() {
    this.schedule = [];
    this.timerInterval = null;
    this.tickRunning = false;
    this.load();
  }

  load() {
    fs.mkdirSync(dataDir, { recursive: true });

    if (!fs.existsSync(scheduleFile)) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(scheduleFile, "utf8"));
      this.schedule = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn(
        `[SCHEDULER] Could not read schedule.json (${err.message}). Starting empty.`,
      );
      this.schedule = [];
      return;
    }

    let recovered = 0;
    for (const show of this.schedule) {
      if (show.status === "live") {
        show.status = "finished";
        recovered += 1;
      }
    }
    if (recovered > 0) {
      console.log(
        `[SCHEDULER] Cleared ${recovered} stale live show(s) left over from a previous run.`,
      );
      this.save();
    }
  }

  save() {
    try {
      fs.writeFileSync(scheduleFile, JSON.stringify(this.schedule), "utf8");
    } catch (err) {
      console.error(`[SCHEDULER] Failed to persist schedule: ${err.message}`);
    }
  }

  parseTimeInput(timeInput) {
    const now = Date.now();
    const str = String(timeInput || "")
      .trim()
      .toLowerCase();

    const relative = str.match(/^(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)$/);
    if (relative) {
      const amount = Number.parseInt(relative[1], 10);
      const unitMs = relative[2].startsWith("h") ? 3600000 : 60000;
      return now + amount * unitMs;
    }

    const clock = str.match(/^(\d{1,2}):(\d{2})$/);
    if (clock) {
      const hours = Number.parseInt(clock[1], 10);
      const minutes = Number.parseInt(clock[2], 10);
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
      title: item.title,
      tmdbId: item.tmdbId,
      mediaType: item.mediaType === "tv" ? "tv" : "movie",
      season: item.season ?? 1,
      episode: item.episode ?? 1,
      showtime,
      serverIndex: item.serverIndex ?? 0,
      status: "scheduled",
      addedAt: Date.now(),
    };

    this.schedule.push(show);
    this.schedule.sort((a, b) => a.showtime - b.showtime);
    this.save();
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
    this.save();
    return true;
  }

  getUpcoming() {
    const now = Date.now();
    return this.schedule.filter(
      (show) => show.status === "scheduled" && show.showtime > now,
    );
  }

  getCurrentShow() {
    return this.schedule.find((show) => show.status === "live") || null;
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
      this.tick(streamer, notifyCallback).catch((err) => {
        console.error(`[SCHEDULER] Tick failed: ${err.message}`);
      });
    }, TICK_INTERVAL_MS);
  }

  stopTimerLoop() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  async tick(streamer, notifyCallback) {
    if (this.tickRunning || streamer.isStreaming) return;

    const show = this.getDueShow();
    if (!show) return;

    const guildId = config.defaultGuildId;
    const voiceChannelId = config.defaultVoiceChannelId;

    if (!guildId || !voiceChannelId) {
      console.warn(
        `[SCHEDULER] Skipping "${show.title}": DEFAULT_GUILD_ID and DEFAULT_VOICE_CHANNEL_ID must be set in .env.`,
      );
      show.status = "failed";
      show.error = "Missing DEFAULT_GUILD_ID or DEFAULT_VOICE_CHANNEL_ID.";
      this.save();
      return;
    }

    this.tickRunning = true;
    show.status = "live";
    this.save();

    try {
      const media = {
        tmdbId: show.tmdbId,
        type: show.mediaType,
        season: show.season,
        episode: show.episode,
      };

      const source = await resolvePlayableStream(media, streamer.urlExtractor, {
        preferredServerIndex: show.serverIndex,
      });

      let input = source.url;
      let playOptions = {
        headers: source.headers,
        sourceHint: { width: source.width, height: source.height },
      };

      // Same treatment as a manual request: a scheduled showtime must not fall
      // back to the unreliable live path.
      if (config.prefetch.enabled) {
        try {
          const { file, cached } = await ensureLocalCopy({
            media,
            resolved: source,
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
          if (!cached)
            console.log(
              `[SCHEDULER] Downloaded "${show.title}" ready to play.`,
            );
        } catch (err) {
          console.warn(
            `[SCHEDULER] Download failed (${err.message}); streaming directly.`,
          );
        }
      }

      if (notifyCallback) await notifyCallback(show, source);

      await streamer.join(guildId, voiceChannelId);
      const { playback } = await streamer.play(input, playOptions);
      await playback;

      show.status = "finished";
    } catch (err) {
      console.error(`[SCHEDULER] Show "${show.title}" failed: ${err.message}`);
      show.status = "failed";
      show.error = err.message;
    } finally {
      this.save();
      this.tickRunning = false;
    }
  }
}
