import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { validateRemoteMediaUrl } from "./mediaInput.js";
import { planEncoding, probeSource } from "./mediaProbe.js";
import { spoolProgressiveMedia } from "./progressiveMedia.js";
import {
  readJsonFileSync,
  writeJsonFileAtomicSync,
} from "../utils/jsonStore.js";
import { redactUrl } from "../utils/network.js";

const cacheDir = path.join(process.cwd(), "data", "cache");
const indexFile = path.join(cacheDir, "index.json");
const CACHE_LIST_SNAPSHOT_MS = 3000;
const PROGRESS_INTERVAL_MS = 10000;
const STDERR_LIMIT_BYTES = 64 * 1024;
const CACHE_KEY_PATTERN = /^(?:movie-\d+|tv-\d+-s\d+-e\d+)$/;

let indexCache = null;
let listSnapshot = null;
let activeFfmpegCount = 0;
const activePartials = new Set();
const inFlight = new Map();
const ffmpegQueue = [];

function parsePositiveInteger(value, label, maximum) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > maximum ||
    !/^\d+$/.test(String(value))
  ) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function assertCacheKey(key) {
  const value = String(key || "");
  if (!CACHE_KEY_PATTERN.test(value)) {
    throw new Error("Invalid cache key.");
  }
  return value;
}

function cacheTarget(key) {
  return path.join(cacheDir, `${assertCacheKey(key)}.mkv`);
}

function normalizeLabel(value) {
  const withoutControls = Array.from(String(value || ""), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  const label = withoutControls.replace(/\s+/g, " ").trim();
  return label ? label.slice(0, 300) : null;
}

function partialIdentity(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function cacheKey(media) {
  if (!media || typeof media !== "object") {
    throw new Error("Media details are required.");
  }

  const type = media.type || "movie";
  if (type !== "movie" && type !== "tv") {
    throw new Error("Media type must be movie or tv.");
  }

  const tmdbId = parsePositiveInteger(media.tmdbId, "TMDB ID", 999999999999);
  const parts = [type, tmdbId];
  if (type === "tv") {
    const season = parsePositiveInteger(media.season ?? 1, "Season", 9999);
    const episode = parsePositiveInteger(media.episode ?? 1, "Episode", 9999);
    parts.push(`s${season}`, `e${episode}`);
  }
  return parts.join("-");
}

export function cachedFile(key) {
  const file = cacheTarget(key);
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size > 0 ? file : null;
  } catch {
    return null;
  }
}

function humanBytes(bytes) {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function invalidateListSnapshot() {
  listSnapshot = null;
}

function validIndex(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, entry]) =>
        CACHE_KEY_PATTERN.test(key) &&
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.label === "string" &&
        entry.label.length > 0 &&
        entry.label.length <= 300 &&
        Number.isSafeInteger(entry.addedAt) &&
        entry.addedAt > 0,
    )
  );
}

function readIndex() {
  if (indexCache !== null) return indexCache;
  indexCache = readJsonFileSync(indexFile, {
    fallback: {},
    validate: validIndex,
    label: "prefetch cache index",
  });
  return indexCache;
}

function writeIndex(index) {
  const candidate = structuredClone(index);
  if (!validIndex(candidate)) throw new Error("Invalid cache index data.");
  writeJsonFileAtomicSync(indexFile, candidate, { pretty: true });
  indexCache = candidate;
  invalidateListSnapshot();
}

function updateIndex(mutator) {
  const candidate = structuredClone(readIndex());
  if (mutator(candidate) === false) return false;
  writeIndex(candidate);
  return true;
}

function recordCacheEntry(key, rawLabel) {
  const label = normalizeLabel(rawLabel);
  if (!label) return false;
  return updateIndex((index) => {
    const existing = index[key];
    if (existing?.label === label) return false;
    index[key] = {
      label,
      addedAt: existing?.addedAt ?? Date.now(),
    };
    return true;
  });
}

function removeIndexEntries(keys) {
  if (keys.length === 0) return false;
  const uniqueKeys = new Set(keys);
  return updateIndex((index) => {
    let changed = false;
    for (const key of uniqueKeys) {
      if (!(key in index)) continue;
      delete index[key];
      changed = true;
    }
    return changed;
  });
}

function cacheEntries() {
  if (!fs.existsSync(cacheDir)) return [];
  return fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mkv"))
    .map((entry) => {
      const key = entry.name.slice(0, -4);
      if (!CACHE_KEY_PATTERN.test(key)) return null;
      const file = path.join(cacheDir, entry.name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size <= 0) return null;
        return {
          key,
          file,
          bytes: stat.size,
          lastUsed: stat.atimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function listCache() {
  if (listSnapshot && Date.now() - listSnapshot.at <= CACHE_LIST_SNAPSHOT_MS) {
    return listSnapshot.entries;
  }

  const index = readIndex();
  const entries = cacheEntries()
    .map((entry) => ({
      ...entry,
      label: index[entry.key]?.label || entry.key,
    }))
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
  invalidateListSnapshot();
  try {
    removeIndexEntries([match.key]);
  } catch {
    console.warn("[CACHE] The media was removed, but its index entry remains.");
  }

  console.log(`[CACHE] Removed ${match.label} (${humanBytes(match.bytes)})`);
  return match;
}

export function clearPartials() {
  if (!fs.existsSync(cacheDir)) return { count: 0, bytes: 0, active: 0 };

  let count = 0;
  let bytes = 0;
  let active = 0;
  let failed = 0;
  for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
    const file = path.join(cacheDir, entry.name);
    if (activePartials.has(partialIdentity(file))) {
      active += 1;
      continue;
    }
    try {
      bytes += fs.statSync(file).size;
      fs.rmSync(file, { force: true });
      count += 1;
    } catch {
      failed += 1;
    }
  }

  if (count > 0) {
    console.log(
      `[CACHE] Cleared ${count} partial file(s), ${humanBytes(bytes)}`,
    );
  }
  if (failed > 0) {
    console.warn(`[CACHE] Could not remove ${failed} partial file(s).`);
  }
  return { count, bytes, active };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withFileRetry(operation, attempts = 20, delayMs = 250) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      operation();
      return;
    } catch (error) {
      const retryable = error.code === "EBUSY" || error.code === "EPERM";
      if (!retryable || attempt === attempts) throw error;
      await sleep(delayMs);
    }
  }
}

async function discardPartial(partial) {
  try {
    await withFileRetry(() => fs.rmSync(partial, { force: true }));
    return true;
  } catch {
    console.warn(
      `[PREFETCH] Could not remove partial ${path.basename(partial)}.`,
    );
    return false;
  }
}

function pruneCache(preserveFile) {
  const limit = config.prefetch.maxCacheGB * 1e9;
  if (limit <= 0) return;

  const files = cacheEntries().sort((a, b) => a.lastUsed - b.lastUsed);
  let total = files.reduce((sum, file) => sum + file.bytes, 0);
  const removedKeys = [];

  for (const victim of files) {
    if (total <= limit) break;
    if (path.resolve(victim.file) === path.resolve(preserveFile)) continue;
    try {
      fs.rmSync(victim.file, { force: true });
      total -= victim.bytes;
      removedKeys.push(victim.key);
      console.log(
        `[CACHE] Evicted ${path.basename(victim.file)} (${humanBytes(victim.bytes)})`,
      );
    } catch {
      console.warn(`[CACHE] Could not evict ${path.basename(victim.file)}.`);
    }
  }

  if (removedKeys.length > 0) {
    invalidateListSnapshot();
    try {
      removeIndexEntries(removedKeys);
    } catch {
      console.warn(
        "[CACHE] Evicted media could not be removed from the index.",
      );
    }
  }
}

function invokeSubscriber(callback, payload, eventName) {
  if (typeof callback !== "function") return;
  try {
    const result = callback(payload);
    if (result && typeof result.catch === "function") {
      result.catch(() => {
        console.warn(`[PREFETCH] A ${eventName} subscriber failed.`);
      });
    }
  } catch {
    console.warn(`[PREFETCH] A ${eventName} subscriber failed.`);
  }
}

function registerSubscribers(operation, onPlan, onProgress) {
  if (typeof onPlan === "function") {
    operation.planSubscribers.add(onPlan);
    if (operation.planPayload) {
      invokeSubscriber(onPlan, operation.planPayload, "plan");
    }
  }
  if (typeof onProgress === "function") {
    operation.progressSubscribers.add(onProgress);
  }
}

function publishPlan(operation, payload) {
  operation.planPayload = payload;
  for (const subscriber of operation.planSubscribers) {
    invokeSubscriber(subscriber, payload, "plan");
  }
}

function publishProgress(operation, payload) {
  for (const subscriber of operation.progressSubscribers) {
    invokeSubscriber(subscriber, payload, "progress");
  }
}

function drainFfmpegQueue() {
  while (
    activeFfmpegCount < config.prefetch.maxConcurrent &&
    ffmpegQueue.length > 0
  ) {
    const queued = ffmpegQueue.shift();
    if (queued.cancelled || queued.signal?.aborted) {
      queued.reject(
        queued.signal?.reason ?? new Error("Prefetch was cancelled."),
      );
      continue;
    }
    queued.started = true;
    queued.signal?.removeEventListener("abort", queued.onAbort);
    activeFfmpegCount += 1;
    void (async () => {
      try {
        queued.resolve(await queued.task());
      } catch (error) {
        queued.reject(error);
      } finally {
        activeFfmpegCount -= 1;
        drainFfmpegQueue();
      }
    })();
  }
}

function withFfmpegPermit(task, signal) {
  return new Promise((resolve, reject) => {
    const queued = {
      task,
      resolve,
      reject,
      signal,
      started: false,
      cancelled: false,
      onAbort: null,
    };
    queued.onAbort = () => {
      if (queued.started || queued.cancelled) return;
      queued.cancelled = true;
      const index = ffmpegQueue.indexOf(queued);
      if (index >= 0) ffmpegQueue.splice(index, 1);
      reject(signal.reason ?? new Error("Prefetch was cancelled."));
      drainFfmpegQueue();
    };
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Prefetch was cancelled."));
      return;
    }
    signal?.addEventListener("abort", queued.onAbort, { once: true });
    ffmpegQueue.push(queued);
    drainFfmpegQueue();
  });
}

async function prepareOperation({ key, resolved, operation }) {
  const existing = cachedFile(key);
  if (existing) {
    console.log(`[PREFETCH] Using cached ${key}`);
    if (operation.label) {
      try {
        recordCacheEntry(key, operation.label);
      } catch {
        console.warn(`[CACHE] Could not update metadata for ${key}.`);
      }
    }
    return { file: existing, cached: true, plan: null, durationSeconds: 0 };
  }

  operation.signal.throwIfAborted();
  const url = await validateRemoteMediaUrl(resolved?.url);
  const spool = await spoolProgressiveMedia(url, resolved?.headers, {
    signal: operation.signal,
  });
  let result;
  let plan;
  let durationSeconds;

  try {
    const probe = await probeSource(
      spool.file,
      config.probeTimeoutMs,
      2,
      operation.signal,
    );
    plan = planEncoding(probe, {
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

    durationSeconds = probe.durationSeconds ?? 0;
    if (durationSeconds < config.prefetch.minDurationSeconds) {
      throw new Error(
        `Resolved media is only ${durationSeconds.toFixed(1)}s; refusing to cache a likely segment.`,
      );
    }
    publishPlan(operation, { plan, durationSeconds });

    const ready = cachedFile(key);
    if (ready) {
      result = { file: ready, cached: true };
    } else {
      const file = await runPrefetch({
        source: spool.file,
        plan,
        key,
        durationLimit: config.prefetch.durationLimit,
        expectedDuration: durationSeconds,
        signal: operation.signal,
        onProgress: (progress) =>
          publishProgress(operation, { ...progress, durationSeconds }),
      });
      result = { file, cached: false };
    }
  } finally {
    await spool.dispose().catch(() => {
      console.warn(`[PREFETCH] Could not remove the source spool for ${key}.`);
    });
  }

  if (operation.label) {
    try {
      recordCacheEntry(key, operation.label);
    } catch {
      console.warn(`[CACHE] Could not update metadata for ${key}.`);
    }
  }

  try {
    pruneCache(result.file);
  } catch {
    console.warn("[CACHE] Cache pruning failed after preparation.");
  }
  invalidateListSnapshot();

  return {
    file: result.file,
    cached: result.cached,
    plan: result.cached ? null : plan,
    durationSeconds: result.cached ? 0 : durationSeconds,
  };
}

export function ensureLocalCopy({
  media,
  resolved,
  onPlan,
  onProgress,
  signal,
} = {}) {
  const key = cacheKey(media);
  const label = normalizeLabel(media?.label);
  signal?.throwIfAborted();
  const existing = cachedFile(key);
  if (existing) {
    console.log(`[PREFETCH] Using cached ${key}`);
    if (label) {
      try {
        recordCacheEntry(key, label);
      } catch {
        console.warn(`[CACHE] Could not update metadata for ${key}.`);
      }
    }
    return Promise.resolve({
      file: existing,
      cached: true,
      plan: null,
      durationSeconds: 0,
    });
  }

  const current = inFlight.get(key);
  if (current) {
    if (!current.label && label) current.label = label;
    registerSubscribers(current, onPlan, onProgress);
    const forwardCurrentAbort = () => current.controller.abort(signal.reason);
    if (signal?.aborted && !current.controller.signal.aborted) {
      forwardCurrentAbort();
    } else {
      signal?.addEventListener("abort", forwardCurrentAbort, { once: true });
    }
    console.log(`[PREFETCH] ${key} is already being prepared; waiting for it.`);
    return current.promise.finally(() =>
      signal?.removeEventListener("abort", forwardCurrentAbort),
    );
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });

  const operation = {
    key,
    label,
    controller,
    signal: controller.signal,
    planPayload: null,
    planSubscribers: new Set(),
    progressSubscribers: new Set(),
    promise: null,
  };
  registerSubscribers(operation, onPlan, onProgress);

  const pending = withFfmpegPermit(
    () => prepareOperation({ key, resolved, operation }),
    operation.signal,
  );
  operation.promise = pending.finally(() => {
    signal?.removeEventListener("abort", forwardAbort);
    if (inFlight.get(key) === operation) inFlight.delete(key);
  });
  inFlight.set(key, operation);
  return operation.promise;
}

export async function cancelPrefetchOperations(
  reason = new Error("Prefetch cancelled."),
) {
  const operations = [...inFlight.values()];
  for (const operation of operations) {
    if (!operation.controller.signal.aborted) {
      operation.controller.abort(reason);
    }
  }
  await Promise.allSettled(operations.map((operation) => operation.promise));
}

function appendBoundedBuffer(current, chunk, maximumBytes) {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (incoming.length >= maximumBytes) {
    return incoming.subarray(incoming.length - maximumBytes);
  }
  const combined = Buffer.concat([current, incoming]);
  return combined.length > maximumBytes
    ? combined.subarray(combined.length - maximumBytes)
    : combined;
}

function sanitizeDiagnostic(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => redactUrl(url))
    .replace(/\s+/g, " ")
    .trim()
    .slice(-1000);
}

function runPrefetch({
  source,
  plan,
  key,
  durationLimit = 0,
  expectedDuration = 0,
  onProgress,
  signal,
}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = cacheTarget(key);
  const partial = `${target}.${process.pid}.${crypto.randomUUID()}.part`;
  const partialKey = partialIdentity(partial);
  const windowsPath = /^[A-Za-z]:[\\/]/.test(source);
  if (!windowsPath && /^[A-Za-z][A-Za-z\d+.-]*:/.test(source)) {
    return Promise.reject(new Error("Prefetch requires a local media file."));
  }

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

  args.push("-protocol_whitelist", "file,pipe", "-i", source);

  const selectedVideoStreamIndex = plan?.selectedVideoStreamIndex;
  args.push(
    "-map",
    Number.isInteger(selectedVideoStreamIndex) && selectedVideoStreamIndex >= 0
      ? `0:${selectedVideoStreamIndex}`
      : "0:v:0",
  );

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

  activePartials.add(partialKey);
  return new Promise((resolve, reject) => {
    let child;
    let spawned = false;
    let settling = false;
    let aborted = signal?.aborted === true;
    let processError = null;
    let stderrTail = Buffer.alloc(0);
    let stdoutRemainder = "";
    let lastReport = 0;
    const startedAt = Date.now();

    const onAbort = () => {
      aborted = true;
      if (child && !child.killed) child.kill("SIGKILL");
    };

    const settle = async (code) => {
      if (settling) return;
      settling = true;
      signal?.removeEventListener("abort", onAbort);
      let finalized = false;

      try {
        if (aborted) {
          throw signal?.reason ?? new Error("Prefetch cancelled.");
        }
        if (processError) {
          const codeText = processError.code ? ` (${processError.code})` : "";
          throw new Error(`Could not run ffmpeg${codeText}.`);
        }
        if (code !== 0) {
          const lines = stderrTail
            .toString("utf8")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          const detail = sanitizeDiagnostic(lines.at(-1) || `exit ${code}`);
          throw new Error(`Prefetch failed: ${detail}`);
        }

        const outputProbe = await probeSource(
          partial,
          config.probeTimeoutMs,
          1,
          signal,
        );
        const plannedDuration =
          durationLimit > 0
            ? Math.min(expectedDuration, durationLimit)
            : expectedDuration;
        const minimumDuration = Math.max(1, plannedDuration * 0.9);
        if (outputProbe.durationSeconds < minimumDuration) {
          throw new Error(
            `Prefetch output is incomplete (${outputProbe.durationSeconds.toFixed(1)}s of ${plannedDuration.toFixed(1)}s).`,
          );
        }

        const ready = cachedFile(key);
        if (ready) {
          await discardPartial(partial);
          resolve(ready);
          return;
        }

        if (fs.existsSync(target)) fs.rmSync(target, { force: true });
        try {
          await withFileRetry(() => fs.renameSync(partial, target));
          finalized = true;
        } catch (error) {
          const codeText = error.code ? ` (${error.code})` : "";
          throw new Error(`Could not finalise the cache file${codeText}.`);
        }

        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.size <= 0) {
          throw new Error("The completed cache file is invalid.");
        }

        const seconds = (Date.now() - startedAt) / 1000;
        console.log(
          `[PREFETCH] Done: ${humanBytes(stat.size)} in ${seconds.toFixed(0)}s`,
        );
        resolve(target);
      } catch (error) {
        if (finalized) {
          try {
            await withFileRetry(() => fs.rmSync(target, { force: true }));
          } catch {
            console.warn(
              `[PREFETCH] Could not remove invalid ${path.basename(target)}.`,
            );
          }
        }
        await discardPartial(partial);
        reject(error);
      } finally {
        activePartials.delete(partialKey);
      }
    };

    if (aborted) {
      void settle(null);
      return;
    }

    try {
      child = spawn("ffmpeg", args, { windowsHide: true });
    } catch (error) {
      processError = error;
      void settle(null);
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("spawn", () => {
      spawned = true;
      if (aborted && !child.killed) child.kill("SIGKILL");
    });

    child.stdout.on("data", (chunk) => {
      stdoutRemainder += chunk.toString("utf8");
      if (stdoutRemainder.length > 16384) {
        stdoutRemainder = stdoutRemainder.slice(-16384);
      }

      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)$/);
        if (!match) continue;
        const now = Date.now();
        if (now - lastReport < PROGRESS_INTERVAL_MS) continue;
        lastReport = now;
        const mediaSeconds = Number(match[1]) / 1_000_000;
        const wallSeconds = (now - startedAt) / 1000;
        const speed = wallSeconds > 0 ? mediaSeconds / wallSeconds : 0;
        const bytes =
          fs.statSync(partial, { throwIfNoEntry: false })?.size ?? 0;
        try {
          onProgress?.({ mediaSeconds, wallSeconds, speed, bytes });
        } catch {
          console.warn("[PREFETCH] Progress reporting failed.");
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrTail = appendBoundedBuffer(stderrTail, chunk, STDERR_LIMIT_BYTES);
    });

    child.once("error", (error) => {
      processError = error;
      if (!spawned) {
        void settle(null);
      } else if (!child.killed) {
        child.kill("SIGKILL");
      }
    });

    child.once("close", (code) => {
      void settle(code);
    });
  });
}
