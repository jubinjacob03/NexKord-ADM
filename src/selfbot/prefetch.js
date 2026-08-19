import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { config } from "./config.js";
import { planEncoding, probeSource } from "./mediaProbe.js";

const cacheDir = path.join(process.cwd(), "data", "cache");
const CACHE_LIST_SNAPSHOT_MS = 3000;

export function cacheKey(media) {
  const parts = [media.type || "movie", media.tmdbId];
  if (media.type === "tv")
    parts.push(`s${media.season ?? 1}`, `e${media.episode ?? 1}`);
  return parts.join("-");
}

export function cachedFile(key) {
  const file = path.join(cacheDir, `${key}.mkv`);
  return fs.existsSync(file) ? file : null;
}

function humanBytes(bytes) {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

const indexFile = path.join(cacheDir, "index.json");
let indexCache = null;
let listSnapshot = null;

function invalidateListSnapshot() {
  listSnapshot = null;
}

function readIndex() {
  if (indexCache) return indexCache;
  try {
    indexCache = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch {
    indexCache = {};
  }
  return indexCache;
}

function writeIndex(index) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf8");
    indexCache = index;
    invalidateListSnapshot();
  } catch (err) {
    console.warn(`[CACHE] Could not write the index: ${err.message}`);
  }
}

function recordCacheEntry(key, label) {
  const index = readIndex();
  index[key] = { label, addedAt: Date.now() };
  writeIndex(index);
}

export function listCache() {
  if (listSnapshot && Date.now() - listSnapshot.at <= CACHE_LIST_SNAPSHOT_MS) {
    return listSnapshot.entries;
  }
  if (!fs.existsSync(cacheDir)) return [];
  const index = readIndex();

  const entries = fs
    .readdirSync(cacheDir)
    .filter((name) => name.endsWith(".mkv"))
    .map((name) => {
      const key = name.replace(/\.mkv$/, "");
      const full = path.join(cacheDir, name);
      const stat = fs.statSync(full);
      return {
        key,
        file: full,
        label: index[key]?.label || key,
        bytes: stat.size,
        lastUsed: stat.atimeMs,
      };
    })
    .sort((a, b) => b.bytes - a.bytes);

  listSnapshot = { at: Date.now(), entries };
  return entries;
}

export function cacheUsage() {
  const entries = listCache();
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return { entries, bytes, limitBytes: config.prefetch.maxCacheGB * 1e9 };
}

export function removeFromCache(query) {
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  if (!needle) return null;

  const entries = listCache();
  const match =
    entries.find((entry) => entry.key.toLowerCase() === needle) ||
    entries.find((entry) => entry.label.toLowerCase().includes(needle));

  if (!match) return null;

  fs.rmSync(match.file, { force: true });
  const index = readIndex();
  delete index[match.key];
  writeIndex(index);
  invalidateListSnapshot();

  console.log(`[CACHE] Removed ${match.label} (${humanBytes(match.bytes)})`);
  return match;
}

export function clearPartials() {
  if (!fs.existsSync(cacheDir)) return { count: 0, bytes: 0 };

  let count = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.endsWith(".part")) continue;
    const full = path.join(cacheDir, name);
    try {
      bytes += fs.statSync(full).size;
      fs.rmSync(full, { force: true });
      count += 1;
    } catch {
      // Still being written by a live download; leave it alone.
    }
  }
  if (count > 0)
    console.log(
      `[CACHE] Cleared ${count} partial file(s), ${humanBytes(bytes)}`,
    );
  return { count, bytes };
}

const PROGRESS_INTERVAL_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows: ffmpeg/AV may hold the file handle briefly after exit → EBUSY
async function withFileRetry(operation, attempts = 20, delayMs = 250) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      operation();
      return;
    } catch (err) {
      const retryable = err.code === "EBUSY" || err.code === "EPERM";
      if (!retryable || attempt === attempts) throw err;
      await sleep(delayMs);
    }
  }
}

async function discardPartial(partial) {
  await withFileRetry(() => fs.rmSync(partial, { force: true })).catch(
    () => {},
  );
}

function pruneCache() {
  if (!fs.existsSync(cacheDir)) return;
  const limit = config.prefetch.maxCacheGB * 1e9;
  if (limit <= 0) return;

  const files = fs
    .readdirSync(cacheDir)
    .filter((name) => name.endsWith(".mkv"))
    .map((name) => {
      const full = path.join(cacheDir, name);
      const stat = fs.statSync(full);
      return { full, size: stat.size, atime: stat.atimeMs };
    })
    .sort((a, b) => a.atime - b.atime);

  let total = files.reduce((sum, f) => sum + f.size, 0);
  while (total > limit && files.length > 1) {
    const victim = files.shift();
    fs.rmSync(victim.full, { force: true });
    total -= victim.size;
    console.log(
      `[CACHE] Evicted ${path.basename(victim.full)} (${humanBytes(victim.size)})`,
    );
  }
  invalidateListSnapshot();
}

export async function ensureLocalCopy({ media, resolved, onPlan, onProgress }) {
  const key = cacheKey(media);
  const existing = cachedFile(key);
  if (existing) {
    console.log(`[PREFETCH] Using cached ${key}`);
    return { file: existing, cached: true, plan: null, durationSeconds: 0 };
  }

  if (media.label) recordCacheEntry(key, media.label);

  const probe = await probeSource(
    resolved.url,
    resolved.headers,
    config.probeTimeoutMs,
  ).catch(() => null);

  const plan = planEncoding(probe, {
    maxWidth: config.stream.maxWidth,
    maxFps: config.stream.maxFps,
    forceWidth: config.stream.forceWidth,
    forceFps: config.stream.forceFps,
    bitrateVideo: config.stream.bitrateVideo,
    bitrateFloor: config.stream.bitrateFloor,
    bitrateCeiling: config.stream.bitrateCeiling,
    bitrateFactor: config.prefetch.bitrateFactor,
    bitrateAudio: config.stream.bitrateAudio,
  });

  const durationSeconds = probe?.durationSeconds ?? 0;
  onPlan?.({ plan, durationSeconds });

  const file = await prefetchToCache({
    url: resolved.url,
    headers: resolved.headers,
    plan,
    key,
    durationLimit: config.prefetch.durationLimit,
    onProgress: (progress) => onProgress?.({ ...progress, durationSeconds }),
  });

  return { file, cached: false, plan, durationSeconds };
}

const inFlight = new Map();

function prefetchToCache(options) {
  const existing = inFlight.get(options.key);
  if (existing) {
    console.log(
      `[PREFETCH] ${options.key} is already being prepared; waiting for it.`,
    );
    return existing;
  }

  const job = runPrefetch(options).finally(() => inFlight.delete(options.key));
  inFlight.set(options.key, job);
  return job;
}

function runPrefetch({
  url,
  headers,
  plan,
  key,
  durationLimit = 0,
  onProgress,
  signal,
}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `${key}.mkv`);
  const partial = `${target}.part`;

  const headerLines = Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-progress",
    "pipe:1",
    "-nostats",
  ];

  if (config.stream.hardwareAcceleratedDecoding) args.push("-hwaccel", "auto");

  if (/^https?:\/\//i.test(url)) {
    args.push("-rw_timeout", String(config.sourceReadTimeoutMs * 1000));
    if (headerLines) args.push("-headers", `${headerLines}\r\n`);
    args.push(
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "10",
    );
  }

  args.push("-i", url);

  args.push("-map", "0:v:0");
  if (plan?.excludeFlags?.length) {
    for (let i = 0; i < plan.excludeFlags.length; i += 2) {
      if (plan.excludeFlags[i + 1]?.startsWith("-0:a:")) {
        args.push(plan.excludeFlags[i], plan.excludeFlags[i + 1]);
      }
    }
  }

  const filters = [];
  if (plan?.width) filters.push(`scale=${plan.width}:-2`);
  if (filters.length) args.push("-vf", filters.join(","));
  if (plan?.frameRate) args.push("-r", String(plan.frameRate));

  const ceiling = config.prefetch.maxrateKbps;
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    config.prefetch.preset,
    "-crf",
    String(config.prefetch.crf),
    "-maxrate:v",
    `${ceiling}k`,
    "-bufsize",
    `${ceiling * 2}k`,
    "-bf",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    "expr:gte(t,n_forced*1)",
    "-map",
    "0:a:0?",
    "-c:a",
    "libopus",
    "-b:a",
    `${config.stream.bitrateAudio}k`,
    "-ac",
    "2",
    "-ar",
    "48000",
  );

  if (durationLimit > 0) args.push("-t", String(durationLimit));
  args.push("-f", "matroska", partial);

  console.log(
    `[PREFETCH] Building ${path.basename(target)} (preset=${config.prefetch.preset})`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let stderr = "";
    let lastReport = 0;
    const startedAt = Date.now();

    const onAbort = () => {
      child.kill("SIGKILL");
      discardPartial(partial);
      reject(new Error("Prefetch cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      const now = Date.now();
      if (now - lastReport < PROGRESS_INTERVAL_MS) return;
      const match = chunk.toString().match(/out_time_ms=(\d+)/);
      if (!match) return;
      lastReport = now;
      const mediaSeconds = Number(match[1]) / 1_000_000;
      const wallSeconds = (now - startedAt) / 1000;
      const speed = wallSeconds > 0 ? mediaSeconds / wallSeconds : 0;
      const bytes = fs.statSync(partial, { throwIfNoEntry: false })?.size ?? 0;
      onProgress?.({ mediaSeconds, wallSeconds, speed, bytes });
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", async (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return;

      if (code !== 0) {
        await discardPartial(partial);
        reject(
          new Error(
            `Prefetch failed: ${stderr.trim().split("\n").pop() || `exit ${code}`}`,
          ),
        );
        return;
      }

      try {
        await withFileRetry(() => fs.renameSync(partial, target));
      } catch (err) {
        await discardPartial(partial);
        reject(new Error(`Could not finalise the cache file: ${err.message}`));
        return;
      }

      const size = fs.statSync(target).size;
      const seconds = (Date.now() - startedAt) / 1000;
      console.log(
        `[PREFETCH] Done: ${humanBytes(size)} in ${seconds.toFixed(0)}s`,
      );
      pruneCache();
      invalidateListSnapshot();
      resolve(target);
    });

    child.on("error", (err) =>
      reject(new Error(`Could not start ffmpeg: ${err.message}`)),
    );
  });
}
