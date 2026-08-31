import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPublicHttpsResponse } from "../utils/network.js";
import { config } from "./config.js";

const spoolDirectory = path.join(process.cwd(), "data", "spool");
const HEADER_NAMES = new Map([
  ["origin", "Origin"],
  ["referer", "Referer"],
  ["user-agent", "User-Agent"],
]);
const ADAPTIVE_TYPES = new Set([
  "application/dash+xml",
  "application/mpegurl",
  "application/vnd.apple.mpegurl",
  "application/vnd.ms-sstr+xml",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);
const BINARY_TYPES = new Set([
  "application/octet-stream",
  "application/x-binary",
  "application/x-matroska",
  "binary/octet-stream",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeWithRetry(file, attempts = 20) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.promises.rm(file, { force: true });
      return;
    } catch (error) {
      const retryable = error.code === "EBUSY" || error.code === "EPERM";
      if (!retryable || attempt === attempts) throw error;
      await sleep(250);
    }
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function clearStaleMediaSpools() {
  if (!fs.existsSync(spoolDirectory)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(spoolDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:part|media)$/.test(entry.name)) continue;
    const ownerPid = Number.parseInt(entry.name.split("-", 1)[0], 10);
    if (
      Number.isSafeInteger(ownerPid) &&
      ownerPid > 0 &&
      (ownerPid === process.pid || processAlive(ownerPid))
    ) {
      continue;
    }
    await removeWithRetry(path.join(spoolDirectory, entry.name));
    removed += 1;
  }
  return removed;
}

function normalizeHeaders(headers) {
  if (headers === undefined || headers === null) return {};
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("Source headers must be an object.");
  }

  const normalized = {};
  let totalBytes = 0;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined || rawValue === null || rawValue === "")
      continue;
    const name = HEADER_NAMES.get(String(rawName).toLowerCase());
    if (!name) throw new Error("Source headers contain a disallowed name.");
    const value = String(rawValue);
    if (/[\r\n\0]/.test(value)) {
      throw new Error("Source headers contain an invalid value.");
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (totalBytes > 32768) throw new Error("Source headers are too large.");
    normalized[name] = value;
  }
  return normalized;
}

function mediaType(headers) {
  return String(headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

export function isAdaptiveMediaUrl(url) {
  const value = `${url.pathname}${url.search}`.toLowerCase();
  const query = url.search.toLowerCase();
  return (
    /(?:^|[/.])[^/?#]*\.(?:m3u8|mpd|m4s|cmfv|cmfa|ts)(?:$|[?#])/.test(value) ||
    /\.(?:m3u8|mpd|m4s|cmfv|cmfa|ts)(?:$|[&#])/.test(query) ||
    /\/manifest(?:\([^/]*\))?(?:$|[/?#])/.test(value) ||
    /(?:^|\/)segment[-_.\d]/.test(value)
  );
}

function rejectsByUrl(url) {
  return isAdaptiveMediaUrl(url);
}

function manifestSignature(prefix) {
  let value = prefix;
  if (value.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    value = value.subarray(3);
  }
  const text = value.toString("utf8").trimStart().toLowerCase();
  return (
    text.startsWith("#extm3u") ||
    text.startsWith("<mpd") ||
    text.startsWith("<?xml") ||
    text.startsWith("<smoothstreamingmedia")
  );
}

function recognizedMediaSignature(prefix) {
  if (
    prefix.length >= 8 &&
    prefix.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return true;
  }
  if (
    prefix.length >= 4 &&
    prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  ) {
    return true;
  }
  if (
    prefix.length >= 12 &&
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "AVI "
  ) {
    return true;
  }
  if (prefix.length >= 3 && prefix.subarray(0, 3).toString("ascii") === "FLV") {
    return true;
  }
  if (
    prefix.length >= 4 &&
    prefix[0] === 0x00 &&
    prefix[1] === 0x00 &&
    prefix[2] === 0x01 &&
    prefix[3] === 0xba
  ) {
    return true;
  }
  return false;
}

function validateResponseMetadata(url, response) {
  if (rejectsByUrl(url)) {
    throw new Error("Adaptive media manifests are not supported.");
  }
  if (response.headers["content-range"]) {
    throw new Error("Partial remote media responses are not supported.");
  }

  const type = mediaType(response.headers);
  if (ADAPTIVE_TYPES.has(type) || type === "video/mp2t") {
    throw new Error("Adaptive media manifests and segments are not supported.");
  }
  if (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml")
  ) {
    throw new Error("The remote server did not return progressive media.");
  }
  if (type && !type.startsWith("video/") && !BINARY_TYPES.has(type)) {
    throw new Error(`Unsupported remote media type: ${type}.`);
  }

  const encoding = String(response.headers["content-encoding"] || "identity")
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") {
    throw new Error("Compressed remote media responses are not supported.");
  }

  return {
    requireSignature: true,
    type,
  };
}

function validatingTransform(limit, requireSignature) {
  let bytes = 0;
  let prefix = Buffer.alloc(0);
  let validated = false;

  const validatePrefix = () => {
    if (validated) return;
    if (prefix.length === 0) throw new Error("The remote media file is empty.");
    if (manifestSignature(prefix)) {
      throw new Error("Adaptive media manifests are not supported.");
    }
    if (requireSignature && !recognizedMediaSignature(prefix)) {
      throw new Error("The remote media container could not be verified.");
    }
    validated = true;
  };

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(
          new Error(
            `Remote media exceeded the ${(limit / 1024 / 1024).toFixed(0)} MB limit.`,
          ),
        );
        return;
      }

      if (!validated) {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length < 4096) {
          callback();
          return;
        }
        try {
          validatePrefix();
          callback(null, prefix);
          prefix = Buffer.alloc(0);
        } catch (error) {
          callback(error);
        }
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      try {
        validatePrefix();
        if (prefix.length > 0) this.push(prefix);
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });

  return { transform, bytes: () => bytes };
}

function overallSignal(signal, timeoutMs) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(
      new Error(`Remote media download timed out after ${timeoutMs}ms.`),
    );
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal,
    cancellationReason: () => {
      if (signal?.aborted) return signal.reason;
      if (timeoutController.signal.aborted)
        return timeoutController.signal.reason;
      return null;
    },
    stop: () => clearTimeout(timer),
  };
}

export async function spoolProgressiveMedia(
  input,
  headers = {},
  { signal } = {},
) {
  fs.mkdirSync(spoolDirectory, { recursive: true });
  const id = `${process.pid}-${crypto.randomUUID()}`;
  const partialPath = path.join(spoolDirectory, `${id}.part`);
  const filePath = path.join(spoolDirectory, `${id}.media`);
  const timeout = overallSignal(signal, config.sourceDownloadTimeoutMs);
  let response = null;

  try {
    const opened = await openPublicHttpsResponse(input, {
      allowedHosts: config.playAllowedHosts,
      headers: normalizeHeaders(headers),
      signal: timeout.signal,
      timeoutMs: config.sourceReadTimeoutMs,
    });
    response = opened.response;
    const status = response.statusCode ?? 0;
    if (status !== 200) {
      response.destroy();
      throw new Error(`Remote media returned HTTP ${status}.`);
    }

    const metadata = validateResponseMetadata(opened.url, response);
    const declaredBytes = Number.parseInt(
      String(response.headers["content-length"] || "0"),
      10,
    );
    if (
      Number.isFinite(declaredBytes) &&
      declaredBytes > config.sourceMaximumBytes
    ) {
      response.destroy();
      throw new Error(
        `Remote media exceeds the ${(config.sourceMaximumBytes / 1024 / 1024).toFixed(0)} MB limit.`,
      );
    }

    const validator = validatingTransform(
      config.sourceMaximumBytes,
      metadata.requireSignature,
    );
    await pipeline(
      response,
      validator.transform,
      fs.createWriteStream(partialPath, { flags: "wx" }),
      { signal: timeout.signal },
    );
    if (validator.bytes() <= 0)
      throw new Error("The remote media file is empty.");
    await fs.promises.rename(partialPath, filePath);

    let disposed = false;
    return {
      bytes: validator.bytes(),
      contentType: metadata.type,
      file: filePath,
      finalUrl: opened.url,
      async dispose() {
        if (disposed) return;
        await removeWithRetry(filePath);
        disposed = true;
      },
    };
  } catch (error) {
    response?.destroy();
    const cancellation =
      error?.name === "AbortError" || error?.code === "ABORT_ERR"
        ? timeout.cancellationReason()
        : null;
    const surfaced = cancellation ?? error;
    const cleanup = await Promise.allSettled([
      removeWithRetry(partialPath),
      removeWithRetry(filePath),
    ]);
    const cleanupErrors = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [surfaced, ...cleanupErrors],
        "Remote media failed and its spool could not be cleaned up.",
      );
    }
    throw surfaced;
  } finally {
    timeout.stop();
  }
}
