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
import { validatePlayInput, validateRemoteMediaUrl } from "./mediaInput.js";
import { spoolProgressiveMedia } from "./progressiveMedia.js";
import { cancelPrefetchOperations } from "./prefetch.js";

const DIRECT_MEDIA_PATTERN = /\.(mp4|mkv|webm|avi|mov|flv)(\?|$)/i;
const STOP_GRACE_MS = 3000;
const PLAYBACK_DRAIN_GRACE_MS = 10000;
const JOIN_TIMEOUT_MS = 15000;
const STALE_CLEAR_TIMEOUT_MS = 5000;

export class RequestedStreamStop extends Error {}

export class PlaybackStalled extends Error {}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Operation aborted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function waitForSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Operation aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
    this.preparationOperation = null;
    this.preparedStream = null;
    this.voiceOperation = Promise.resolve();
  }

  cachedVoiceChannelId(guildId = config.defaultGuildId) {
    const guild = this.client.guilds.cache.get(guildId);
    return guild?.members?.me?.voice?.channelId || null;
  }

  hasReadyVoiceTransport(
    guildId = config.defaultGuildId,
    channelId = config.defaultVoiceChannelId,
    expectedRtc = null,
  ) {
    const connection = this.streamer.voiceConnection;
    const rtc = connection?.webRtcConn;
    return Boolean(
      guildId &&
      channelId &&
      this.cachedVoiceChannelId(guildId) === channelId &&
      connection?.guildId === guildId &&
      connection?.channelId === channelId &&
      rtc &&
      (!expectedRtc || rtc === expectedRtc) &&
      rtc.mediaConnection === connection &&
      rtc.ready,
    );
  }

  get isConnected() {
    return this.hasReadyVoiceTransport();
  }

  get isPreparing() {
    return Boolean(this.preparationOperation);
  }

  queueVoiceOperation(operation) {
    const queued = this.voiceOperation.catch(() => {}).then(operation);
    this.voiceOperation = queued.catch(() => {});
    return queued;
  }

  beginPreparation() {
    if (this.preparationOperation) {
      throw new Error("Another media preparation is already active.");
    }
    let resolveSettlement;
    const operation = {
      controller: new AbortController(),
      settled: new Promise((resolve) => {
        resolveSettlement = resolve;
      }),
      resolveSettlement,
      completed: false,
    };
    this.preparationOperation = operation;
    return operation;
  }

  completePreparation(operation) {
    if (!operation || operation.completed) return;
    operation.completed = true;
    operation.resolveSettlement();
    if (this.preparationOperation === operation) {
      this.preparationOperation = null;
    }
  }

  async fetchVoiceChannelId(guildId) {
    const guild = await this.client.guilds.fetch(guildId);
    const member =
      guild.members.me ?? (await guild.members.fetch(this.client.user.id));
    if (typeof member.voice?.fetch === "function") {
      await member.voice.fetch(true).catch(() => {});
    }
    return member.voice?.channelId || null;
  }

  async waitForVoiceChannel(guildId, expectedChannelId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do {
      const current = await this.fetchVoiceChannelId(guildId).catch(() =>
        this.cachedVoiceChannelId(guildId),
      );
      if (current === expectedChannelId) return true;
      await sleep(200);
    } while (Date.now() < deadline);
    return false;
  }

  async waitForVoiceTransport(
    guildId,
    channelId,
    expectedRtc,
    timeoutMs,
    signal,
  ) {
    const deadline = Date.now() + timeoutMs;
    do {
      signal?.throwIfAborted();
      await waitForSignal(
        this.fetchVoiceChannelId(guildId).catch(() => null),
        signal,
      );
      if (this.hasReadyVoiceTransport(guildId, channelId, expectedRtc)) {
        return true;
      }
      await sleep(200, signal);
    } while (Date.now() < deadline);
    return false;
  }

  async join(guildId, channelId, signal) {
    const queued = this.queueVoiceOperation(() => {
      signal?.throwIfAborted();
      return this.joinInternal(guildId, channelId, signal);
    });
    queued.catch(() => {});
    return waitForSignal(queued, signal);
  }

  async joinInternal(guildId, channelId, signal) {
    signal?.throwIfAborted();
    if (!guildId || !channelId) {
      throw new Error(
        "Guild ID and Channel ID are required to join a voice channel.",
      );
    }
    if (
      guildId !== config.defaultGuildId ||
      channelId !== config.defaultVoiceChannelId
    ) {
      throw new Error(
        "Voice joins are limited to the configured Cinema channel.",
      );
    }

    const currentChannelId = await waitForSignal(
      this.fetchVoiceChannelId(guildId).catch(() =>
        this.cachedVoiceChannelId(guildId),
      ),
      signal,
    );
    if (
      currentChannelId === channelId &&
      this.hasReadyVoiceTransport(guildId, channelId)
    ) {
      this.currentGuildId = guildId;
      this.currentChannelId = channelId;
      return;
    }

    if (currentChannelId || this.streamer.voiceConnection) {
      console.log("[VOICE] Clearing a stale voice session.");
      await this.teardownVoiceSession(guildId);
      signal?.throwIfAborted();
    }

    console.log(`[VOICE] Joining configured channel ${channelId}.`);
    const joinAttempt = Promise.resolve(
      this.streamer.joinVoice(guildId, channelId),
    );
    let joinResolved = false;
    let expectedRtc;

    try {
      expectedRtc = await waitForSignal(
        withTimeout(
          joinAttempt,
          JOIN_TIMEOUT_MS,
          `Voice channel join timed out after ${JOIN_TIMEOUT_MS / 1000}s.`,
        ),
        signal,
      );
      joinResolved = true;
      const ready = await this.waitForVoiceTransport(
        guildId,
        channelId,
        expectedRtc,
        JOIN_TIMEOUT_MS,
        signal,
      );
      if (!ready) {
        throw new Error("The configured voice transport did not become ready.");
      }
    } catch (error) {
      if (!joinResolved) {
        void joinAttempt
          .then((lateRtc) =>
            this.queueVoiceOperation(async () => {
              if (this.streamer.voiceConnection?.webRtcConn === lateRtc) {
                await this.teardownVoiceSession(guildId);
              }
            }),
          )
          .catch(() => {});
      }

      let cleanupError = null;
      try {
        await this.teardownVoiceSession(guildId);
      } catch (failure) {
        cleanupError = failure;
      }
      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Voice join failed and the partial session could not be cleared.",
        );
      }
      throw error;
    }

    signal?.throwIfAborted();
    this.currentGuildId = guildId;
    this.currentChannelId = channelId;
    console.log(`[VOICE] Connected to configured channel ${channelId}.`);
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

  async teardownVoiceSession(guildId, { cancelPreparation = false } = {}) {
    await this.stop({ cancelPreparation });
    try {
      this.streamer.stopStream();
    } catch (error) {
      console.warn(`[VOICE] stopStream warning: ${error.message}`);
    }
    try {
      this.streamer.leaveVoice();
    } catch (error) {
      console.warn(`[VOICE] leaveVoice warning: ${error.message}`);
    }
    try {
      this.forceVoiceDisconnect(guildId);
    } catch (error) {
      console.warn(`[VOICE] disconnect signal warning: ${error.message}`);
    }

    const disconnected = await this.waitForVoiceChannel(
      guildId,
      null,
      STALE_CLEAR_TIMEOUT_MS,
    );
    if (!disconnected) {
      throw new Error("Discord did not clear the previous voice session.");
    }
    this.currentGuildId = null;
    this.currentChannelId = null;
  }

  async resolvePlayableSource(mediaInput, presetHeaders, signal) {
    if (isDirectMedia(mediaInput)) {
      return { source: mediaInput, headers: presetHeaders ?? {} };
    }

    console.log("[STREAM] Embed page detected. Extracting direct stream URL.");
    const extracted = await this.urlExtractor.extractStreamUrl(mediaInput, {
      timeout: config.extractorTimeoutMs,
      signal,
    });

    if (!extracted) {
      throw new Error(
        "Could not extract a playable stream. Try a different server provider.",
      );
    }

    return {
      source: await validateRemoteMediaUrl(extracted.url),
      headers: {
        Referer: extracted.referer,
        Origin: extracted.origin,
        "User-Agent": extracted.userAgent,
      },
    };
  }

  async describeSource(source, timeoutMs, signal) {
    const probe = await probeSource(
      source,
      timeoutMs ?? config.probeTimeoutMs,
      2,
      signal,
    );
    const renditions = probe.videoStreams
      .map((stream) => `${stream.width}x${stream.height}`)
      .join(", ");
    console.log(
      `[STREAM] Source ${probe.codec} @${probe.fps}fps ${probe.bitrateKbps}kbps ` +
        `renditions=[${renditions}] audioTracks=${probe.audioCount}`,
    );
    return probe;
  }

  async play(mediaInput, options = {}) {
    if (!this.isConnected) {
      throw new Error("The bot must join a voice channel before streaming.");
    }

    const preparation = this.beginPreparation();
    const controller = preparation.controller;
    let sourceSpool = null;
    let setupPreparedState = null;
    try {
      if (this.isStreaming) {
        console.log("[STREAM] Replacing the active stream.");
        await this.stop({ cancelPreparation: false });
      }

      controller.signal.throwIfAborted();
      if (!this.isConnected) {
        throw new Error("The voice transport disconnected before playback.");
      }
      this.currentMedia = mediaInput;
      const validatedInput = await validatePlayInput(mediaInput);
      const resolved = await this.resolvePlayableSource(
        validatedInput.input,
        options.headers,
        controller.signal,
      );
      const remoteSource = isHttpUrl(resolved.source);
      sourceSpool = remoteSource
        ? await spoolProgressiveMedia(resolved.source, resolved.headers, {
            signal: controller.signal,
          })
        : null;
      const source = sourceSpool?.file ?? resolved.source;
      const localFileProfile =
        options.localFileProfile ??
        (!remoteSource &&
          config.localStream.enabled &&
          isLocalFileInput(source));
      const probeTimeoutMs = localFileProfile
        ? config.localStream.probeTimeoutMs
        : config.probeTimeoutMs;

      const probe =
        localFileProfile && config.localStream.skipProbe
          ? null
          : await this.describeSource(
              source,
              probeTimeoutMs,
              controller.signal,
            );

      const durationSeconds = probe?.durationSeconds ?? 0;
      if (
        remoteSource &&
        durationSeconds < config.prefetch.minDurationSeconds
      ) {
        throw new Error(
          `Remote media is only ${durationSeconds.toFixed(1)}s; refusing to play a likely segment.`,
        );
      }

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
      const customInputOptions = [
        "-protocol_whitelist",
        "file,pipe",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
      ];

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
        customHeaders: {},
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

      if (!this.isConnected) {
        throw new Error("The voice transport disconnected before playback.");
      }

      controller.signal.throwIfAborted();
      this.abortController = controller;
      this.isStreaming = true;

      let prepared;
      try {
        prepared = prepareStream(source, encoderOptions, controller.signal);
      } catch (err) {
        this.resetPlaybackState();
        throw new Error(`FFmpeg pipeline failed to start: ${err.message}`);
      }

      const preparedState = {
        prepared,
        controller,
        forceKill: false,
        onAbort: null,
        onStart: null,
        stop: null,
      };
      const stopPreparedProcess = () => {
        const reason =
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("Media processing was aborted.");
        if (!prepared.output.destroyed) prepared.output.destroy(reason);
        try {
          prepared.command.kill(
            preparedState.forceKill ? "SIGKILL" : "SIGTERM",
          );
        } catch (error) {
          console.warn(`[STREAM] FFmpeg termination warning: ${error.message}`);
        }
      };
      preparedState.onAbort = stopPreparedProcess;
      preparedState.stop = stopPreparedProcess;
      preparedState.onStart = () => {
        if (controller.signal.aborted) stopPreparedProcess();
      };
      controller.signal.addEventListener("abort", preparedState.onAbort, {
        once: true,
      });
      prepared.command.once("start", preparedState.onStart);
      this.preparedStream = preparedState;
      setupPreparedState = preparedState;

      const ffmpegOutcome = prepared.promise.then(
        () => null,
        (error) => {
          if (!controller.signal.aborted) {
            console.error(`[STREAM] FFmpeg error: ${error.message}`);
            controller.abort(error);
          }
          return error;
        },
      );

      const startupTimeoutMs = localFileProfile
        ? config.localStream.startupTimeoutMs
        : config.streamStartupTimeoutMs;
      const watchdog = this.startProgressWatchdog(
        prepared.command,
        controller,
        startupTimeoutMs,
      );
      this.completePreparation(preparation);

      const playback = (async () => {
        try {
          let playbackError = null;
          try {
            await playStream(
              prepared.output,
              this.streamer,
              playOptions,
              controller.signal,
            );
          } catch (error) {
            playbackError = error;
            if (!controller.signal.aborted) controller.abort(error);
            try {
              this.streamer.stopStream();
            } catch (cleanupError) {
              console.warn(
                `[STREAM] Partial stream cleanup warning: ${cleanupError.message}`,
              );
            }
          }

          if (!playbackError && !controller.signal.aborted) {
            const producerFinished = await Promise.race([
              ffmpegOutcome.then(() => true),
              sleep(PLAYBACK_DRAIN_GRACE_MS).then(() => false),
            ]);
            if (!producerFinished) {
              playbackError = new PlaybackStalled(
                "The stream stopped while media was still being produced.",
              );
              console.error(
                "[STREAM] The stream ended before FFmpeg finished; treating it as a failure.",
              );
              controller.abort(playbackError);
              try {
                this.streamer.stopStream();
              } catch (cleanupError) {
                console.warn(
                  `[STREAM] Partial stream cleanup warning: ${cleanupError.message}`,
                );
              }
            }
          }

          const ffmpegError = await ffmpegOutcome;
          const abortReason = controller.signal.reason;
          if (abortReason instanceof RequestedStreamStop) {
            console.log("[STREAM] Playback stopped by request.");
            return;
          }
          if (playbackError instanceof PlaybackStalled) throw playbackError;
          if (ffmpegError) throw ffmpegError;
          if (playbackError) throw playbackError;
          if (controller.signal.aborted) {
            throw abortReason instanceof Error
              ? abortReason
              : new Error("Playback aborted unexpectedly.");
          }
          console.log("[STREAM] Playback finished.");
        } catch (error) {
          if (controller.signal.reason instanceof RequestedStreamStop) {
            console.log("[STREAM] Playback stopped by request.");
            return;
          }
          console.error(`[STREAM] Playback failed: ${error.message}`);
          throw error;
        } finally {
          clearTimeout(watchdog.timer);
          controller.signal.removeEventListener("abort", preparedState.onAbort);
          prepared.command.off("start", preparedState.onStart);
          if (this.preparedStream === preparedState) this.preparedStream = null;
          if (sourceSpool) {
            await sourceSpool.dispose().catch(() => {
              console.warn("[STREAM] Could not remove the remote media spool.");
            });
          }
          if (this.abortController === controller) this.resetPlaybackState();
        }
      })();

      this.playback = playback;
      return { playback };
    } catch (error) {
      this.completePreparation(preparation);
      if (setupPreparedState) {
        if (!controller.signal.aborted) controller.abort(error);
        setupPreparedState.forceKill = true;
        setupPreparedState.stop();
        await setupPreparedState.prepared.promise.catch(() => {});
        controller.signal.removeEventListener(
          "abort",
          setupPreparedState.onAbort,
        );
        setupPreparedState.prepared.command.off(
          "start",
          setupPreparedState.onStart,
        );
        if (this.preparedStream === setupPreparedState) {
          this.preparedStream = null;
        }
      }
      if (sourceSpool) {
        await sourceSpool.dispose().catch(() => {
          console.warn("[STREAM] Could not remove the remote media spool.");
        });
      }
      if (this.currentMedia === mediaInput) this.resetPlaybackState();
      throw error;
    }
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

  async stop({ cancelPreparation = true } = {}) {
    const reason = new RequestedStreamStop("Stream stopped by request.");
    const actionablePreparation = cancelPreparation
      ? this.preparationOperation
      : null;
    const playback = this.playback;
    const preparedState = this.preparedStream;
    const controller = this.abortController;

    if (
      actionablePreparation &&
      !actionablePreparation.controller.signal.aborted
    ) {
      actionablePreparation.controller.abort(reason);
    }
    if (controller && !controller.signal.aborted) controller.abort(reason);
    const prefetchSettlement = cancelPreparation
      ? cancelPrefetchOperations(reason)
      : Promise.resolve();

    if (!actionablePreparation && !playback && !preparedState && !controller) {
      await prefetchSettlement;
      return;
    }

    console.log("[STREAM] Stopping active media work.");
    const initialSettlements = [
      playback,
      actionablePreparation?.settled,
    ].filter(Boolean);
    let mediaSettled =
      initialSettlements.length === 0 ||
      (await Promise.race([
        Promise.allSettled(initialSettlements).then(() => true),
        sleep(STOP_GRACE_MS).then(() => false),
      ]));

    if (!mediaSettled) {
      console.warn(
        "[STREAM] Media work did not settle in time; forcing it closed.",
      );
      try {
        this.streamer.stopStream();
      } catch (error) {
        console.warn(`[STREAM] stopStream warning: ${error.message}`);
      }
      const activePrepared = this.preparedStream;
      if (activePrepared) {
        activePrepared.forceKill = true;
        activePrepared.stop();
      }
      const forcedSettlements = [
        playback,
        activePrepared?.prepared.promise,
      ].filter(Boolean);
      mediaSettled =
        forcedSettlements.length === 0 ||
        (await Promise.race([
          Promise.allSettled(forcedSettlements).then(() => true),
          sleep(STOP_GRACE_MS).then(() => false),
        ]));
      if (!mediaSettled) {
        console.warn("[STREAM] Forced media shutdown remains unsettled.");
        if (this.preparedStream === activePrepared) this.preparedStream = null;
      }
    }

    await prefetchSettlement;
    if (playback && mediaSettled) await playback.catch(() => {});
    if (
      this.abortController === controller ||
      (actionablePreparation &&
        this.preparationOperation === actionablePreparation)
    ) {
      this.resetPlaybackState();
    }
  }

  async leave() {
    return this.queueVoiceOperation(() => this.leaveInternal());
  }

  async leaveInternal() {
    await this.stop();
    const guildId = this.currentGuildId || config.defaultGuildId;
    if (!guildId) return;
    const connectedChannelId = await this.fetchVoiceChannelId(guildId).catch(
      () => this.cachedVoiceChannelId(guildId),
    );
    if (!connectedChannelId && !this.streamer.voiceConnection) {
      this.currentGuildId = null;
      this.currentChannelId = null;
      return;
    }

    console.log("[VOICE] Leaving configured channel.");
    await this.teardownVoiceSession(guildId);
  }

  async dispose() {
    await this.leave();
    await this.urlExtractor.close();
  }

  getStatus() {
    const currentChannelId = this.cachedVoiceChannelId();
    return {
      isStreaming: this.isStreaming,
      currentGuildId: currentChannelId ? config.defaultGuildId : null,
      currentChannelId,
      currentMedia: this.currentMedia,
    };
  }
}
