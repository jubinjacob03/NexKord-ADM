import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { getLibraryDir, setVariantStatus } from "./library.js";
import { auditLog } from "../../utils/logger.js";

const activeDownloads = new Map();

function extractGDriveFileId(url) {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /\/open\?id=([a-zA-Z0-9_-]+)/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function directDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
}

export function getDownloadProgress(movieId) {
  if (movieId) return activeDownloads.get(movieId) || null;
  for (const p of activeDownloads.values()) return p;
  return null;
}

export function cancelDownload(movieId) {
  const target = movieId
    ? activeDownloads.get(movieId)
    : [...activeDownloads.values()][0];

  if (!target || target.done || target.cancelled) return null;

  target.cancelled = true;
  target.controller?.abort();
  return target;
}

export async function downloadFromUrl(url, movieId, variantId, filename) {
  const libraryDir = getLibraryDir();
  const outPath = path.join(libraryDir, filename);

  let downloadUrl = url;
  const gdriveId = extractGDriveFileId(url);
  if (gdriveId) {
    downloadUrl = directDownloadUrl(gdriveId);
  }

  const controller = new AbortController();
  const progress = {
    movieId,
    variantId,
    filename,
    bytes: 0,
    done: false,
    error: null,
    cancelled: false,
    controller,
  };
  activeDownloads.set(movieId, progress);
  setVariantStatus(movieId, variantId, "downloading", "");

  try {
    const res = await fetch(downloadUrl, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
    progress.totalBytes = totalBytes || null;

    const fileStream = fs.createWriteStream(outPath);
    const body = Readable.fromWeb(res.body);

    body.on("data", (chunk) => {
      progress.bytes += chunk.length;
    });

    await pipeline(body, fileStream, { signal: controller.signal });

    progress.done = true;
    setVariantStatus(movieId, variantId, "offline", outPath);
    auditLog(
      "info",
      "CINEMA",
      `Downloaded ${filename} (${(progress.bytes / 1e6).toFixed(1)} MB)`,
    );
  } catch (err) {
    const wasCancelled = progress.cancelled || err.name === "AbortError";
    progress.error = wasCancelled ? "cancelled" : err.message;
    setVariantStatus(movieId, variantId, "available", "");
    await fs.promises.rm(outPath, { force: true }).catch(() => {});
    auditLog(
      wasCancelled ? "warn" : "error",
      "CINEMA",
      wasCancelled
        ? `Download cancelled for ${filename}`
        : `Download failed for ${filename}: ${err.message}`,
    );
  } finally {
    setTimeout(() => activeDownloads.delete(movieId), 30000);
  }

  return progress;
}
