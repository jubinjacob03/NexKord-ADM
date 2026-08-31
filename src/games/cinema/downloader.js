import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getLibraryDir, getVariant, setVariantStatus } from "./library.js";
import { auditLog } from "../../utils/logger.js";
import {
  openPublicHttpsResponse,
  validatePublicUrl,
} from "../../utils/network.js";

const activeDownloads = new Map();
const reservedTargets = new Set();
const allowedExtensions = new Set([".mp4", ".mkv", ".webm", ".mov", ".avi"]);
const terminalStates = new Set([
  "completed",
  "cancelled",
  "timed_out",
  "failed",
]);
let acceptingDownloads = false;
let shutdownPromise = null;

function allowedHosts() {
  return String(process.env.CINEMA_DOWNLOAD_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function requestTimeoutMs() {
  const value = Number.parseInt(
    process.env.CINEMA_DOWNLOAD_TIMEOUT_MS || "3600000",
    10,
  );
  return Number.isFinite(value) && value >= 10_000 ? value : 3_600_000;
}

function maximumBytes() {
  const megabytes = Number.parseInt(
    process.env.CINEMA_MAX_DOWNLOAD_MB || "20480",
    10,
  );
  const safeMegabytes =
    Number.isFinite(megabytes) && megabytes >= 1 ? megabytes : 20_480;
  return safeMegabytes * 1024 * 1024;
}

export function normalizeDownloadFilename(filename) {
  const value = String(filename || "").trim();
  if (
    !value ||
    value !== path.basename(value) ||
    path.isAbsolute(value) ||
    /[<>:"/\\|?*]/.test(value) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(
      "Use a plain filename without folders or special characters.",
    );
  }

  const rawExtension = path.extname(value);
  const extension = rawExtension.toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(
      `File extension must be one of: ${[...allowedExtensions].join(", ")}.`,
    );
  }
  if (value.length <= 180) return value;
  const stem = value.slice(0, -rawExtension.length);
  return `${stem.slice(0, 180 - rawExtension.length)}${rawExtension}`;
}

function googleDriveFileId(url) {
  if (!new Set(["drive.google.com", "docs.google.com"]).has(url.hostname)) {
    return null;
  }
  return (
    url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/)?.[1] ||
    url.searchParams.get("id")
  );
}

async function normalizedDownloadUrl(input) {
  const parsed = await validatePublicUrl(input, {
    protocols: ["https:"],
    allowedHosts: allowedHosts(),
  });
  const fileId = googleDriveFileId(parsed);
  if (!fileId) return parsed;
  return new URL(
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=t`,
  );
}

export async function validateDownloadRequest(url, filename) {
  const safeFilename = normalizeDownloadFilename(filename);
  const safeUrl = await normalizedDownloadUrl(url);
  return { filename: safeFilename, url: safeUrl };
}

function byteLimiter(progress, limit) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      progress.bytes += chunk.length;
      if (progress.bytes > limit) {
        callback(
          new Error(
            `Download exceeded the ${(limit / 1024 / 1024).toFixed(0)} MB limit.`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeFileWithRetry(file, attempts = 20) {
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

function responseHeader(response, name) {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] || "" : String(value || "");
}

function validateDownloadResponse(response) {
  const contentType = responseHeader(response, "content-type")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("mpegurl") ||
    contentType.includes("dash")
  ) {
    throw new Error("The download endpoint did not return a media file.");
  }
  if (
    contentType &&
    !contentType.startsWith("video/") &&
    !new Set([
      "application/octet-stream",
      "application/x-binary",
      "application/x-matroska",
      "binary/octet-stream",
    ]).has(contentType)
  ) {
    throw new Error(`Unsupported download content type: ${contentType}.`);
  }

  const encoding = responseHeader(response, "content-encoding")
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") {
    throw new Error("Compressed download responses are not supported.");
  }
}

function isTerminal(progress) {
  return terminalStates.has(progress.state);
}

export function initializeDownloads() {
  acceptingDownloads = true;
  shutdownPromise = null;
}

export function getDownloadProgress(movieId) {
  const matches = [...activeDownloads.values()].filter(
    (progress) => !movieId || progress.movieId === movieId,
  );
  const active = matches
    .filter((progress) => !isTerminal(progress))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (active) return active;
  return (
    matches.sort(
      (a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt),
    )[0] || null
  );
}

export function cancelDownload(jobId) {
  const target = activeDownloads.get(jobId);
  if (!target || target.state !== "running") return null;
  target.state = "cancelling";
  target.cancellationReason = "user";
  target.controller.abort(new Error("Download cancelled."));
  return target;
}

export async function downloadFromUrl(url, movieId, variantId, filename) {
  if (!acceptingDownloads) {
    throw new Error("Cinema downloads are not accepting new work.");
  }
  const validated = await validateDownloadRequest(url, filename);
  if (!acceptingDownloads) {
    throw new Error("Cinema downloads are shutting down.");
  }

  const variant = getVariant(movieId, variantId);
  if (!variant)
    throw new Error("The selected library variant no longer exists.");

  const libraryDir = path.resolve(getLibraryDir());
  const outPath = path.resolve(libraryDir, validated.filename);
  const root = `${libraryDir}${path.sep}`;
  if (!outPath.startsWith(root)) {
    throw new Error("Invalid library destination.");
  }
  const storedPath = path
    .relative(process.cwd(), outPath)
    .split(path.sep)
    .join("/");
  if (!storedPath || storedPath.startsWith("../")) {
    throw new Error("Invalid shared library destination.");
  }
  if (fs.existsSync(outPath)) {
    throw new Error("A file with that name already exists.");
  }
  if (reservedTargets.has(outPath)) {
    throw new Error("That filename is already downloading.");
  }

  const previous = activeDownloads.get(variantId);
  if (previous && !isTerminal(previous)) {
    throw new Error("That variant is already downloading.");
  }
  if (previous) activeDownloads.delete(variantId);

  const partialPath = `${outPath}.${variantId}.${crypto.randomUUID()}.part`;
  const controller = new AbortController();
  const progress = {
    jobId: variantId,
    movieId,
    variantId,
    filename: validated.filename,
    bytes: 0,
    totalBytes: null,
    state: "running",
    error: null,
    cancellationReason: null,
    startedAt: Date.now(),
    finishedAt: null,
    controller,
    promise: null,
  };

  reservedTargets.add(outPath);
  activeDownloads.set(variantId, progress);
  try {
    setVariantStatus(movieId, variantId, "downloading", "");
  } catch (error) {
    reservedTargets.delete(outPath);
    activeDownloads.delete(variantId);
    throw error;
  }

  const task = (async () => {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(new Error("Download timed out."));
    }, requestTimeoutMs());
    timeout.unref?.();
    let response = null;
    let finalized = false;

    try {
      const signal = AbortSignal.any([
        controller.signal,
        timeoutController.signal,
      ]);
      const opened = await openPublicHttpsResponse(validated.url, {
        allowedHosts: allowedHosts(),
        signal,
        timeoutMs: Math.min(requestTimeoutMs(), 300_000),
      });
      response = opened.response;
      const status = response.statusCode ?? 0;
      if (status !== 200 || response.headers["content-range"]) {
        response.destroy();
        throw new Error(
          status === 206 || response.headers["content-range"]
            ? "Partial download responses are not supported."
            : `HTTP ${status}`,
        );
      }
      validateDownloadResponse(response);

      const declaredBytes = Number.parseInt(
        responseHeader(response, "content-length") || "0",
        10,
      );
      const limit = maximumBytes();
      if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
        response.destroy();
        throw new Error(
          `File is larger than the ${(limit / 1024 / 1024).toFixed(0)} MB limit.`,
        );
      }
      progress.totalBytes = declaredBytes > 0 ? declaredBytes : null;

      await pipeline(
        response,
        byteLimiter(progress, limit),
        fs.createWriteStream(partialPath, { flags: "wx" }),
        { signal },
      );
      if (progress.bytes <= 0)
        throw new Error("The downloaded file was empty.");
      if (fs.existsSync(outPath)) {
        throw new Error("A file with that name appeared during the download.");
      }
      setVariantStatus(movieId, variantId, "finalizing", storedPath);
      fs.renameSync(partialPath, outPath);
      finalized = true;

      setVariantStatus(movieId, variantId, "offline", storedPath);
      progress.state = "completed";
      auditLog(
        "info",
        "CINEMA",
        `Downloaded ${validated.filename} (${(progress.bytes / 1e6).toFixed(1)} MB)`,
      );
    } catch (error) {
      response?.destroy();
      const cancelled = controller.signal.aborted;
      const timedOut = !cancelled && timeoutController.signal.aborted;
      const terminalState = timedOut
        ? "timed_out"
        : cancelled
          ? "cancelled"
          : "failed";
      progress.error = timedOut
        ? "timed out"
        : cancelled
          ? "cancelled"
          : String(error.message || "download failed").slice(0, 500);
      if (finalized) {
        progress.state = "failed";
        auditLog(
          "error",
          "CINEMA",
          `Download finalization state could not be persisted for ${validated.filename}; the completed file was retained for recovery`,
        );
        throw error;
      }

      let cleanupError = null;
      try {
        await removeFileWithRetry(partialPath);
      } catch (failure) {
        cleanupError = failure;
      }
      let restorationError = null;
      if (!cleanupError) {
        try {
          setVariantStatus(movieId, variantId, "available", "");
        } catch (failure) {
          restorationError = failure;
        }
      }
      progress.state =
        restorationError || cleanupError ? "failed" : terminalState;
      auditLog(
        cancelled && !restorationError && !cleanupError ? "warn" : "error",
        "CINEMA",
        cancelled && !restorationError && !cleanupError
          ? `Download cancelled for ${validated.filename}`
          : `Download failed for ${validated.filename}: ${progress.error}`,
      );
      if (restorationError || cleanupError) {
        throw new AggregateError(
          [error, restorationError, cleanupError].filter(Boolean),
          "Download failed and cleanup could not be completed.",
        );
      }
      if (!cancelled) throw error;
    } finally {
      clearTimeout(timeout);
      progress.finishedAt = Date.now();
      reservedTargets.delete(outPath);
      setTimeout(() => {
        if (activeDownloads.get(variantId) === progress) {
          activeDownloads.delete(variantId);
        }
      }, 30_000).unref?.();
    }
    return progress;
  })();

  progress.promise = task;
  return progress;
}

export function shutdownDownloads() {
  acceptingDownloads = false;
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    const jobs = [...activeDownloads.values()];
    for (const job of jobs) {
      if (job.state === "running") {
        job.state = "cancelling";
        job.cancellationReason = "shutdown";
        job.controller.abort(new Error("Application shutting down."));
      }
    }
    await Promise.allSettled(jobs.map((job) => job.promise).filter(Boolean));
  })();
  return shutdownPromise;
}

export async function removeInterruptedPartials() {
  const directory = getLibraryDir();
  if (!fs.existsSync(directory)) return { removed: 0, failed: 0 };
  let removed = 0;
  let failed = 0;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".part")) continue;
    try {
      await removeFileWithRetry(path.join(directory, entry));
      removed += 1;
    } catch (error) {
      failed += 1;
      console.warn(
        `[CINEMA] Could not remove interrupted download ${entry}: ${error.message}`,
      );
    }
  }
  return { removed, failed };
}
