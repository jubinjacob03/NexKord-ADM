import dotenv from "dotenv";

dotenv.config();

if (!process.env.DEBUG_LEVEL) {
  process.env.DEBUG_LEVEL = "warn";
}

const snowflakePattern = /^\d{16,22}$/;

function str(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function bool(value, fallback) {
  if (value === undefined || value === null || value.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const input = str(value);
  if (!/^-?\d+$/.test(input)) return fallback;
  const parsed = Number(input);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function zeroOrInteger(value, fallback, minimum, maximum) {
  const parsed = boundedInteger(value, fallback, 0, maximum);
  return parsed === 0 ? 0 : Math.max(minimum, parsed);
}

function boundedNumber(value, fallback, minimum, maximum) {
  const input = str(value);
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(input)) return fallback;
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function optionalSnowflake(name, value) {
  const parsed = str(value);
  if (parsed && !snowflakePattern.test(parsed)) {
    throw new Error(`${name} must be a Discord snowflake ID.`);
  }
  return parsed;
}

function snowflakeList(name, value) {
  const input = str(value);
  if (!input) return [];
  const values = input.split(",").map((item) => item.trim());
  if (values.some((item) => !snowflakePattern.test(item))) {
    throw new Error(`${name} must contain only comma-separated Discord IDs.`);
  }
  return [...new Set(values)];
}

function hostnameList(value) {
  return str(value)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

const streamBitrateCeiling = boundedInteger(
  process.env.STREAM_BITRATE_MAX,
  4000,
  100,
  100000,
);
const streamBitrateFloor = Math.min(
  boundedInteger(process.env.STREAM_BITRATE_FLOOR, 4000, 100, 100000),
  streamBitrateCeiling,
);
const localBitrateCeiling = boundedInteger(
  process.env.LOCAL_STREAM_BITRATE_MAX,
  16000,
  100,
  100000,
);
const localBitrateFloor = Math.min(
  boundedInteger(process.env.LOCAL_STREAM_BITRATE_FLOOR, 8000, 100, 100000),
  localBitrateCeiling,
);

export const config = {
  token: str(process.env.SELFBOT_TOKEN),
  tmdbApiKey: str(process.env.TMDB_API_KEY),
  defaultGuildId: optionalSnowflake(
    "SELFBOT_GUILD_ID",
    process.env.SELFBOT_GUILD_ID,
  ),
  defaultChannelId: optionalSnowflake(
    "SELFBOT_CHANNEL_ID",
    process.env.SELFBOT_CHANNEL_ID,
  ),
  defaultVoiceChannelId: optionalSnowflake(
    "SELFBOT_VOICE_CHANNEL_ID",
    process.env.SELFBOT_VOICE_CHANNEL_ID,
  ),
  controllerId: optionalSnowflake(
    "SELFBOT_CONTROLLER_ID",
    process.env.SELFBOT_CONTROLLER_ID || process.env.CLIENT_ID,
  ),
  operatorIds: snowflakeList(
    "SELFBOT_OPERATOR_IDS",
    process.env.SELFBOT_OPERATOR_IDS,
  ),
  playAllowedHosts: hostnameList(process.env.SELFBOT_PLAY_ALLOWED_HOSTS),
  prefix: str(process.env.SELFBOT_PREFIX, "!") || "!",
  defaultServerIndex: boundedInteger(
    process.env.SELFBOT_SERVER_INDEX,
    0,
    0,
    100,
  ),
  stayInVoice: bool(process.env.SELFBOT_STAY_IN_VC, true),
  voiceKeepAliveMs: boundedInteger(
    process.env.SELFBOT_VC_KEEPALIVE_MS,
    30000,
    5000,
    300000,
  ),
  tokenValidationTimeoutMs: boundedInteger(
    process.env.SELFBOT_TOKEN_VALIDATION_TIMEOUT_MS,
    10000,
    1000,
    30000,
  ),
  chromiumPath:
    str(process.env.CHROMIUM_PATH) ||
    str(process.env.PUPPETEER_EXECUTABLE_PATH),
  extractorTimeoutMs: boundedInteger(
    process.env.EXTRACTOR_TIMEOUT_MS,
    25000,
    1000,
    300000,
  ),
  streamStartupTimeoutMs: boundedInteger(
    process.env.STREAM_STARTUP_TIMEOUT_MS,
    60000,
    1000,
    300000,
  ),
  sourceReadTimeoutMs: boundedInteger(
    process.env.SOURCE_READ_TIMEOUT_MS,
    30000,
    1000,
    300000,
  ),
  sourceDownloadTimeoutMs: boundedInteger(
    process.env.SOURCE_DOWNLOAD_TIMEOUT_MS,
    3600000,
    10000,
    86400000,
  ),
  sourceMaximumBytes:
    boundedInteger(process.env.SOURCE_MAX_MB, 20480, 1, 1048576) * 1024 * 1024,
  probeTimeoutMs: boundedInteger(
    process.env.PROBE_TIMEOUT_MS,
    15000,
    1000,
    300000,
  ),
  stream: {
    maxWidth: boundedInteger(process.env.STREAM_MAX_WIDTH, 2560, 320, 7680),
    maxFps: boundedInteger(process.env.STREAM_MAX_FPS, 60, 1, 120),
    forceWidth: zeroOrInteger(process.env.STREAM_FORCE_WIDTH, 0, 320, 7680),
    forceFps: zeroOrInteger(process.env.STREAM_FORCE_FPS, 0, 1, 120),
    bitrateVideo: Math.min(
      zeroOrInteger(process.env.STREAM_BITRATE, 0, 100, 100000),
      streamBitrateCeiling,
    ),
    bitrateFloor: streamBitrateFloor,
    // 4000 kbps is the measured ceiling before the send path drops frames.
    bitrateCeiling: streamBitrateCeiling,
    bitrateAudio: boundedInteger(
      process.env.STREAM_BITRATE_AUDIO,
      192,
      32,
      512,
    ),
    preset: str(process.env.STREAM_PRESET, "veryfast") || "veryfast",
    videoCodec: str(process.env.STREAM_CODEC, "H264") || "H264",
    hardwareAcceleratedDecoding: bool(process.env.STREAM_HWACCEL, true),
  },
  localStream: {
    enabled: bool(process.env.LOCAL_STREAM_PROFILE, true),
    skipProbe: bool(process.env.LOCAL_STREAM_SKIP_PROBE, true),
    startupTimeoutMs: boundedInteger(
      process.env.LOCAL_STREAM_STARTUP_TIMEOUT_MS,
      10000,
      1000,
      300000,
    ),
    probeTimeoutMs: boundedInteger(
      process.env.LOCAL_STREAM_PROBE_TIMEOUT_MS,
      3000,
      1000,
      300000,
    ),
    bitrateVideo: Math.min(
      zeroOrInteger(process.env.LOCAL_STREAM_BITRATE, 12000, 100, 100000),
      localBitrateCeiling,
    ),
    bitrateFloor: localBitrateFloor,
    bitrateCeiling: localBitrateCeiling,
    bitrateAudio: boundedInteger(
      process.env.LOCAL_STREAM_BITRATE_AUDIO,
      256,
      32,
      512,
    ),
    preset: str(process.env.LOCAL_STREAM_PRESET, "ultrafast") || "ultrafast",
  },
  prefetch: {
    enabled: bool(process.env.PREFETCH, true),
    preset: str(process.env.PREFETCH_PRESET, "veryfast") || "veryfast",
    maxCacheGB: boundedInteger(process.env.PREFETCH_CACHE_GB, 80, 1, 1024),
    bitrateFactor: boundedNumber(
      process.env.PREFETCH_BITRATE_FACTOR,
      2.5,
      0.1,
      10,
    ),
    crf: boundedInteger(process.env.PREFETCH_CRF, 18, 0, 51),
    maxrateKbps: boundedInteger(
      process.env.PREFETCH_MAXRATE,
      12000,
      100,
      100000,
    ),
    durationLimit: zeroOrInteger(
      process.env.PREFETCH_LIMIT_SECONDS,
      0,
      1,
      604800,
    ),
    minDurationSeconds: boundedInteger(
      process.env.PREFETCH_MIN_DURATION_SECONDS,
      60,
      1,
      3600,
    ),
    maxConcurrent: boundedInteger(process.env.PREFETCH_MAX_CONCURRENT, 1, 1, 4),
  },
};
