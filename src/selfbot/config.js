import dotenv from "dotenv";

dotenv.config();

if (!process.env.DEBUG_LEVEL) {
  process.env.DEBUG_LEVEL = "warn";
}

function str(value, fallback = "") {
  return (value ?? fallback).trim();
}

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value.trim() === "")
    return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export const config = {
  token: str(process.env.SELFBOT_TOKEN),
  tmdbApiKey: str(process.env.TMDB_API_KEY),
  defaultGuildId: str(process.env.SELFBOT_GUILD_ID),
  defaultChannelId: str(process.env.SELFBOT_CHANNEL_ID),
  defaultVoiceChannelId: str(process.env.SELFBOT_VOICE_CHANNEL_ID),
  prefix: str(process.env.SELFBOT_PREFIX, "!") || "!",
  defaultServerIndex: int(process.env.SELFBOT_SERVER_INDEX, 0),
  chromiumPath:
    str(process.env.CHROMIUM_PATH) ||
    str(process.env.PUPPETEER_EXECUTABLE_PATH),
  extractorTimeoutMs: int(process.env.EXTRACTOR_TIMEOUT_MS, 25000),
  streamStartupTimeoutMs: int(process.env.STREAM_STARTUP_TIMEOUT_MS, 60000),
  sourceReadTimeoutMs: int(process.env.SOURCE_READ_TIMEOUT_MS, 30000),
  probeTimeoutMs: int(process.env.PROBE_TIMEOUT_MS, 15000),
  stream: {
    maxWidth: int(process.env.STREAM_MAX_WIDTH, 2560),
    maxFps: int(process.env.STREAM_MAX_FPS, 60),
    forceWidth: int(process.env.STREAM_FORCE_WIDTH, 0),
    forceFps: int(process.env.STREAM_FORCE_FPS, 0),
    bitrateVideo: int(process.env.STREAM_BITRATE, 0),
    bitrateFloor: int(process.env.STREAM_BITRATE_FLOOR, 4000),
    // 4000 kbps is the measured ceiling before the send path drops frames.
    bitrateCeiling: int(process.env.STREAM_BITRATE_MAX, 4000),
    bitrateAudio: int(process.env.STREAM_BITRATE_AUDIO, 192),
    preset: str(process.env.STREAM_PRESET, "veryfast") || "veryfast",
    videoCodec: str(process.env.STREAM_CODEC, "H264") || "H264",
    hardwareAcceleratedDecoding: bool(process.env.STREAM_HWACCEL, true),
  },
  localStream: {
    enabled: bool(process.env.LOCAL_STREAM_PROFILE, true),
    skipProbe: bool(process.env.LOCAL_STREAM_SKIP_PROBE, true),
    startupTimeoutMs: int(process.env.LOCAL_STREAM_STARTUP_TIMEOUT_MS, 10000),
    probeTimeoutMs: int(process.env.LOCAL_STREAM_PROBE_TIMEOUT_MS, 3000),
    bitrateVideo: int(process.env.LOCAL_STREAM_BITRATE, 12000),
    bitrateFloor: int(process.env.LOCAL_STREAM_BITRATE_FLOOR, 8000),
    bitrateCeiling: int(process.env.LOCAL_STREAM_BITRATE_MAX, 16000),
    bitrateAudio: int(process.env.LOCAL_STREAM_BITRATE_AUDIO, 256),
    preset: str(process.env.LOCAL_STREAM_PRESET, "ultrafast") || "ultrafast",
  },
  prefetch: {
    enabled: bool(process.env.PREFETCH, true),
    preset: str(process.env.PREFETCH_PRESET, "veryfast") || "veryfast",
    maxCacheGB: int(process.env.PREFETCH_CACHE_GB, 80),
    bitrateFactor: Number(process.env.PREFETCH_BITRATE_FACTOR) || 2.5,
    crf: int(process.env.PREFETCH_CRF, 18),
    maxrateKbps: int(process.env.PREFETCH_MAXRATE, 12000),
    durationLimit: int(process.env.PREFETCH_LIMIT_SECONDS, 0),
  },
};
