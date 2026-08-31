import fs from "node:fs";
import path from "node:path";
import {
  readJsonFileSync,
  writeJsonFileAtomicSync,
} from "../../utils/jsonStore.js";

const dataDir = path.join(process.cwd(), "data");
const libraryDir = path.join(dataDir, "library");
const libraryFile = path.join(dataDir, "cinema-library.json");

let library = [];

function validVariant(value) {
  return (
    value &&
    !Array.isArray(value) &&
    typeof value.id === "string" &&
    typeof value.quality === "string" &&
    typeof value.source === "string" &&
    typeof value.status === "string" &&
    typeof value.filePath === "string"
  );
}

function validLibrary(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (movie) =>
        movie &&
        !Array.isArray(movie) &&
        typeof movie.id === "string" &&
        typeof movie.title === "string" &&
        Array.isArray(movie.variants) &&
        movie.variants.every(validVariant),
    )
  );
}

function save() {
  writeJsonFileAtomicSync(libraryFile, library, { pretty: true });
}

function loadLibraryState({ recoverInterruptedDownloads, persistChanges }) {
  fs.mkdirSync(libraryDir, { recursive: true });
  library = readJsonFileSync(libraryFile, {
    fallback: [],
    validate: validLibrary,
    label: "cinema library",
  });

  let changed = false;
  for (const movie of library) {
    const normalizedType = movie.mediaType === "tv" ? "tv" : "movie";
    if (movie.mediaType !== normalizedType) {
      movie.mediaType = normalizedType;
      changed = true;
    }
    for (const variant of movie.variants) {
      if (Object.hasOwn(variant, "sourceUrl")) {
        delete variant.sourceUrl;
        changed = true;
      }
      if (variant.filePath) {
        const portablePath = portableLibraryPath(variant.filePath);
        if (
          portablePath &&
          portablePath !== variant.filePath &&
          playableFile(portablePath)
        ) {
          variant.filePath = portablePath;
          changed = true;
        }
      }
      if (!recoverInterruptedDownloads) continue;
      if (variant.status === "finalizing") {
        if (playableFile(variant.filePath)) {
          variant.status = "offline";
        } else {
          variant.status = "available";
          variant.filePath = "";
        }
        changed = true;
      } else if (variant.status === "downloading") {
        variant.status = "available";
        variant.filePath = "";
        changed = true;
      }
    }
  }
  if (changed && persistChanges) save();
}

export function initializeLibrary() {
  loadLibraryState({
    recoverInterruptedDownloads: true,
    persistChanges: true,
  });
}

export function loadLibraryReadOnly() {
  loadLibraryState({
    recoverInterruptedDownloads: false,
    persistChanges: false,
  });
}

export function addMovie({
  title,
  year,
  tmdbId,
  posterUrl,
  overview,
  mediaType,
}) {
  const normalizedType = mediaType === "tv" ? "tv" : "movie";
  const existing =
    tmdbId === null || tmdbId === undefined
      ? null
      : library.find(
          (movie) =>
            movie.mediaType === normalizedType &&
            String(movie.tmdbId) === String(tmdbId),
        );
  if (existing) return existing;

  const movie = {
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: String(title || "Untitled").slice(0, 200),
    year: String(year || "").slice(0, 4),
    tmdbId: tmdbId ?? null,
    posterUrl: String(posterUrl || ""),
    overview: String(overview || "").slice(0, 3000),
    mediaType: normalizedType,
    variants: [],
    createdAt: Date.now(),
  };
  library.push(movie);
  save();
  return movie;
}

export function addVariant(movieId, { quality, source, status, filePath }) {
  const movie = library.find((item) => item.id === movieId);
  if (!movie) return null;

  const variant = {
    id: `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    quality: String(quality || "unknown").slice(0, 30),
    source: String(source || "Unknown").slice(0, 50),
    status: status || "available",
    filePath: filePath || "",
    addedAt: Date.now(),
  };
  movie.variants.push(variant);
  try {
    save();
  } catch (error) {
    movie.variants = movie.variants.filter((item) => item !== variant);
    throw error;
  }
  return variant;
}

export function setVariantStatus(movieId, variantId, status, filePath) {
  const movie = library.find((item) => item.id === movieId);
  if (!movie) return null;
  const variant = movie.variants.find((item) => item.id === variantId);
  if (!variant) return null;
  const previousStatus = variant.status;
  const previousFilePath = variant.filePath;
  variant.status = status;
  if (filePath !== undefined) variant.filePath = filePath;
  try {
    save();
  } catch (error) {
    variant.status = previousStatus;
    variant.filePath = previousFilePath;
    throw error;
  }
  return variant;
}

export function findMovies(query) {
  const normalized = String(query || "").toLowerCase();
  return library.filter(
    (movie) =>
      movie.title.toLowerCase().includes(normalized) ||
      String(movie.tmdbId) === String(query),
  );
}

export function getMovie(id) {
  return library.find((movie) => movie.id === id) || null;
}

export function getMovieByTmdbId(tmdbId, mediaType = null) {
  return (
    library.find(
      (movie) =>
        String(movie.tmdbId) === String(tmdbId) &&
        (!mediaType || movie.mediaType === mediaType),
    ) || null
  );
}

export function getAllMovies() {
  return library;
}

function containedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function resolveLibraryFilePath(filePath) {
  const raw = String(filePath || "");
  if (!raw) return null;
  const root = path.resolve(libraryDir);
  const direct = path.resolve(raw);
  if (containedBy(root, direct)) return direct;

  const normalized = raw.replaceAll("\\", "/");
  const marker = "/data/library/";
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const suffix = normalized.slice(markerIndex + marker.length);
  const remapped = path.resolve(root, ...suffix.split("/"));
  return containedBy(root, remapped) ? remapped : null;
}

function portableLibraryPath(filePath) {
  const resolved = resolveLibraryFilePath(filePath);
  if (!resolved) return null;
  const relative = path.relative(process.cwd(), resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

function playableFile(filePath) {
  const resolved = resolveLibraryFilePath(filePath);
  if (!resolved) return false;
  try {
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

export function getVariant(movieId, variantId) {
  const movie = library.find((item) => item.id === movieId);
  return movie?.variants.find((variant) => variant.id === variantId) || null;
}

export function getPlayableVariant(movieId, variantId) {
  const variant = getVariant(movieId, variantId);
  if (!variant) return null;
  if (variant.status !== "offline" && variant.status !== "downloaded") {
    return null;
  }
  return playableFile(variant.filePath) ? variant : null;
}

export function getBestVariant(movieId) {
  const movie = library.find((item) => item.id === movieId);
  if (!movie) return null;

  return (
    [...movie.variants]
      .filter((variant) => getPlayableVariant(movieId, variant.id))
      .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0] ||
    null
  );
}

export function qualityRank(quality) {
  const map = { "4k": 4, "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 };
  return map[quality?.toLowerCase()] || 0;
}

export function formatVariantList(movie) {
  if (!movie.variants.length) return "No variants available";
  return [...movie.variants]
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
    .map((variant) => {
      const tag =
        variant.status === "offline"
          ? "offline"
          : variant.status === "downloaded"
            ? "downloaded"
            : variant.status === "downloading"
              ? "downloading..."
              : "not downloaded";
      return `${variant.quality} — ${variant.source} (${tag})`;
    })
    .join("\n");
}

export function getLibraryDir() {
  return libraryDir;
}
