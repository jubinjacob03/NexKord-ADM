import {
  Encoders,
  GatewayOpCodes,
  playStream,
  prepareStream,
  Streamer,
  Utils,
} from "@dank074/discord-video-stream";
import { existsSync } from "node:fs";
import { StreamUrlExtractor } from "./browserStreamer.js";
import { config } from "./config.js";
import { planEncoding, probeSource } from "./mediaProbe.js";

const DIRECT_MEDIA_PATTERN = /\.(m3u8|mpd|mp4|mkv|webm|avi|mov|ts)(\?|$)/i;
const STOP_GRACE_MS = 3000;
const JOIN_TIMEOUT_MS = 15000;
const STALE_CLEAR_TIMEOUT_MS = 1500;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpUrl(input) {
  return /^https?:\/\//i.test(String(input || ""));
}

function isLocalFileInput(input) {
  if (typeof input !== "string") return false;
  if (/^file:\/\//i.test(input)) return true;
  if (isHttpUrl(input)) return false;
  return existsSync(input);
}

function isDirectMedia(input) {
  if (typeof input !== "string") return false;
  if (!isHttpUrl(input)) return true;
  return DIRECT_MEDIA_PATTERN.test(input);
}

export class MovieStreamer {
  constructor(client) {
    this.client = client;
    this.streamer = new Streamer(client);
    this.urlExtractor = new StreamUrlExtractor();
    this.currentChannelId = null;
    this.currentGuildId = null;
    this.isStreaming = false;
    this.currentMedia = null;
    this.abortController = null;
    this.playback = null;
  }

  get isConnected() {
    return Boolean(this.streamer.voiceConnection);
  }

  async join(guildId, channelId) {
    if (!guildId || !channelId) {
      throw new Error(
        "Guild ID and Channel ID are required to join a voice channel.",
      );
    }

    if (
      this.currentGuildId === guildId &&
      this.currentChannelId === channelId &&
      this.isConnected
    ) {
      console.log(`[VOICE] Already connected to voice channel ${channelId}.`);
      return;
    }

    console.log(`[VOICE] Joining guild ${guildId} / channel ${channelId}`);

    if (!this.isConnected) {
      await this.clearStaleVoiceSession(guildId);
    }

    try {
      await withTimeout(
        this.streamer.joinVoice(guildId, channelId),
        JOIN_TIMEOUT_MS,
        `Voice channel join handshake timed out after ${JOIN_TIMEOUT_MS / 1000}s.`,
      );
    } catch (err) {
      console.warn(
        `[VOICE] ${err.message} Forcing a disconnect and retrying once.`,
      );
      this.forceVoiceDisconnect(guildId);
      await sleep(1500);

      await withTimeout(
        this.streamer.joinVoice(guildId, channelId),
        JOIN_TIMEOUT_MS,
        "Voice channel join failed twice. Discord may still hold a stale voice session for this " +
          "account - wait a minute, or disconnect the account from voice in the Discord client.",
      );
    }

    this.currentGuildId = guildId;
    this.currentChannelId = channelId;
    console.log(`[VOICE] Connected to voice channel ${channelId}.`);
  }

  forceVoiceDisconnect(guildId) {
    this.streamer.sendOpcode(GatewayOpCodes.VOICE_STATE_UPDATE, {
      guild_id: guildId,
      channel_id: null,
      self_mute: true,
      self_deaf: false,
      self_video: false,
    });
  }

  // Stale voice session: unclean shutdown leaves Discord believing this
  // account is still connected. Re-joining the same channel is a no-op, so
  // force a disconnect first.
  async clearStaleVoiceSession(guildId) {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const me =
      guild.members.me ??
      (await guild.members.fetch(this.client.user.id).catch(() => null));
    const staleChannelId = me?.voice?.channelId;
    if (!staleChannelId) return;

    console.log(`[VOICE] Clearing a stale voice session in ${staleChannelId}.`);
    this.forceVoiceDisconnect(guildId);

    const deadline = Date.now() + STALE_CLEAR_TIMEOUT_MS;
    while (Date.now() < deadline && guild.members.me?.voice?.channelId) {
      await sleep(150);
    }
  }

  async resolvePlayableSource(mediaInput, presetHeaders) {
    if (isDirectMedia(mediaInput)) {
      return { source: mediaInput, headers: presetHeaders ?? {} };
    }

    console.log("[STREAM] Embed page detected. Extracting direct stream URL.");
    const extracted = await this.urlExtractor.extractStreamUrl(mediaInput, {
      timeout: config.extractorTimeoutMs,
    });

    if (!extracted) {
      throw new Error(
        `Could not extract a playable stream from ${mediaInput}. Try a different server provider.`,
      );
    }

    return {
      source: extracted.url,
      headers: {
        Referer: extracted.referer,
        Origin: extracted.origin,
        "User-Agent": extracted.userAgent,
      },
    };
  }

  async describeSource(source, headers, hint, timeoutMs) {
    // Adaptive manifests must be probed; a player-reported hint is sufficient
    // for everything else.
    const isManifest = /\.(mpd|m3u8)(\?|$)/i.test(String(source));

    if (!isManifest && hint?.width > 0 && hint?.height > 0) {
      console.log(
        `[STREAM] Source ${hint.width}x${hint.height} (reported by the player)`,
      );
      return {
        width: hint.width,
        height: hint.height,
        fps: 0,
        codec: "unknown",
        bitrateKbps: 0,
        videoStreams: [
          {
            order: 0,
            width: hint.width,
            height: hint.height,
            fps: 0,
            bitrateKbps: 0,
          },
        ],
        audioCount: 1,
        hasAudio: true,
      };
    }

    try {
      const probe = await probeSource(
        source,
        headers,
        timeoutMs ?? config.probeTimeoutMs,
      );
      const renditions = probe.videoStreams
        .map((s) => `${s.width}x${s.height}`)
        .join(", ");
      console.log(
        `[STREAM] Source ${probe.codec} @${probe.fps}fps ${probe.bitrateKbps}kbps ` +
          `renditions=[${renditions}] audioTracks=${probe.audioCount}`,
      );
      return probe;
    } catch (err) {
      console.warn(
        `[STREAM] Could not probe the source (${err.message.split("\n")[0]}); using defaults.`,
      );
      if (isManifest) {
        console.warn(
          "[STREAM] Without a probe every rendition will be encoded, which will stutter.",
        );
      }
      return null;
    }
  }

  async play(mediaInput, options = {}) {
    if (!this.isConnected) {
      throw new Error("The bot must join a voice channel before streaming.");
    }

    if (this.isStreaming) {
      console.log("[STREAM] Replacing the active stream.");
      await this.stop();
    }

    const { source, headers } = await this.resolvePlayableSource(
      mediaInput,
      options.headers,
    );
    const localFileProfile =
      options.localFileProfile ??
      (config.localStream.enabled && isLocalFileInput(source));
    const probeTimeoutMs = localFileProfile
      ? config.localStream.probeTimeoutMs
      : config.probeTimeoutMs;

    const probe =
      localFileProfile && config.localStream.skipProbe
        ? null
        : await this.describeSource(
            source,
            headers,
            options.sourceHint,
            probeTimeoutMs,
          );

    const plan = planEncoding(probe, {
      maxWidth: options.maxWidth ?? config.stream.maxWidth,
      maxFps: options.maxFps ?? config.stream.maxFps,
      forceWidth: options.forceWidth ?? config.stream.forceWidth,
      forceFps: options.forceFps ?? config.stream.forceFps,
      bitrateVideo:
        options.bitrateVideo ??
        (localFileProfile
          ? config.localStream.bitrateVideo
          : config.stream.bitrateVideo),
      bitrateFloor: localFileProfile
        ? config.localStream.bitrateFloor
        : config.stream.bitrateFloor,
      bitrateCeiling: localFileProfile
        ? config.localStream.bitrateCeiling
        : config.stream.bitrateCeiling,
    });

    const preset =
      options.preset ??
      (localFileProfile ? config.localStream.preset : config.stream.preset);
    const bitrateAudio =
      options.bitrateAudio ??
      (localFileProfile
        ? config.localStream.bitrateAudio
        : config.stream.bitrateAudio);
    const customInputOptions = isHttpUrl(source)
      ? ["-rw_timeout", String(config.sourceReadTimeoutMs * 1000)]
      : ["-fflags", "nobuffer", "-flags", "low_delay"];

    const encoderOptions = {
      encoder: Encoders.software({ x264: { preset }, x265: { preset } }),
      videoCodec: Utils.normalizeVideoCodec(
        options.videoCodec ?? config.stream.videoCodec,
      ),
      bitrateVideo: plan.bitrateVideo,
      bitrateVideoMax: plan.bitrateVideoMax,
      bitrateAudio,
      hardwareAcceleratedDecoding:
        options.hardwareAcceleratedDecoding ??
        config.stream.hardwareAcceleratedDecoding,
      customHeaders: headers,
      customInputOptions,
      customFfmpegFlags: plan.excludeFlags,
    };

    if (plan.width) encoderOptions.width = plan.width;
    if (plan.frameRate) encoderOptions.frameRate = plan.frameRate;

    const playOptions = { type: options.type ?? "go-live" };

    console.log(
      `[STREAM] ${playOptions.type} ${encoderOptions.videoCodec} ${plan.reason.join(", ")} ` +
        `preset=${preset} audio=${encoderOptions.bitrateAudio}kbps profile=${localFileProfile ? "local" : "default"}`,
    );

    const controller = new AbortController();
    this.abortController = controller;
    this.isStreaming = true;
    this.currentMedia = mediaInput;

    let prepared;
    try {
      prepared = prepareStream(source, encoderOptions, controller.signal);
    } catch (err) {
      this.resetPlaybackState();
      throw new Error(`FFmpeg pipeline failed to start: ${err.message}`);
    }

    prepared.promise.catch((err) => {
      if (controller.signal.aborted) return;
      console.error(`[STREAM] FFmpeg error: ${err.message}`);
      controller.abort(err);
    });

    const startupTimeoutMs = localFileProfile
      ? config.localStream.startupTimeoutMs
      : config.streamStartupTimeoutMs;
    const watchdog = this.startProgressWatchdog(
      prepared.command,
      controller,
      startupTimeoutMs,
    );

    const playback = playStream(
      prepared.output,
      this.streamer,
      playOptions,
      controller.signal,
    )
      .finally(() => clearTimeout(watchdog.timer))
      .then(() => console.log("[STREAM] Playback finished."))
      .catch((err) => {
        if (controller.signal.aborted) {
          console.log("[STREAM] Playback ended (stopped).");
        } else {
          console.error(`[STREAM] Playback failed: ${err.message}`);
        }
      })
      .finally(() => {
        if (this.abortController === controller) this.resetPlaybackState();
      });

    this.playback = playback;
    return { playback };
  }

  startProgressWatchdog(
    command,
    controller,
    limitMs = config.streamStartupTimeoutMs,
  ) {
    const watchdog = { sawProgress: false, timer: null };

    command.on("progress", () => {
      watchdog.sawProgress = true;
    });

    watchdog.timer = setTimeout(() => {
      if (watchdog.sawProgress || controller.signal.aborted) return;
      console.error(
        `[STREAM] Source produced no frames within ${limitMs / 1000}s. Aborting.`,
      );
      controller.abort(
        new Error(
          "Source produced no video frames. It may be dead or geo-blocked.",
        ),
      );
    }, limitMs);

    return watchdog;
  }

  resetPlaybackState() {
    this.isStreaming = false;
    this.currentMedia = null;
    this.abortController = null;
    this.playback = null;
  }

  async stop() {
    if (!this.isStreaming && !this.abortController) return;

    console.log("[STREAM] Stopping the active stream.");
    const playback = this.playback;

    // Abort first; stopStream during abort cleanup causes half-torn connections.
    this.abortController?.abort(new Error("Stream stopped by request."));

    const settled = playback
      ? await Promise.race([
          playback.then(
            () => true,
            () => true,
          ),
          sleep(STOP_GRACE_MS).then(() => false),
        ])
      : true;

    if (!settled) {
      console.warn(
        "[STREAM] Playback did not settle in time; forcing the stream closed.",
      );
      try {
        this.streamer.stopStream();
      } catch (err) {
        console.warn(`[STREAM] stopStream warning: ${err.message}`);
      }
    }

    this.resetPlaybackState();
  }

  async leave() {
    await this.stop();
    if (!this.currentGuildId && !this.isConnected) return;

    console.log(`[VOICE] Leaving voice channel ${this.currentChannelId}.`);
    try {
      this.streamer.leaveVoice();
    } catch (err) {
      console.warn(`[VOICE] leaveVoice warning: ${err.message}`);
    }
    this.currentGuildId = null;
    this.currentChannelId = null;
  }

  async dispose() {
    await this.leave();
    await this.urlExtractor.close();
  }

  getStatus() {
    return {
      isStreaming: this.isStreaming,
      currentGuildId: this.currentGuildId,
      currentChannelId: this.currentChannelId,
      currentMedia: this.currentMedia,
    };
  }
}
