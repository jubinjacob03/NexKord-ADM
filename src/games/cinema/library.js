import fs from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
const libraryDir = path.join(dataDir, "library");
const libraryFile = path.join(dataDir, "cinema-library.json");

let library = [];

export function loadLibrary() {
  fs.mkdirSync(libraryDir, { recursive: true });
  try {
    library = JSON.parse(fs.readFileSync(libraryFile, "utf8"));
    if (!Array.isArray(library)) library = [];
  } catch {
    library = [];
  }
}

function save() {
  fs.writeFileSync(libraryFile, JSON.stringify(library, null, 2), "utf8");
}

export function addMovie({
  title,
  year,
  tmdbId,
  posterUrl,
  overview,
  mediaType,
}) {
  const existing = library.find((m) => m.tmdbId === tmdbId);
  if (existing) return existing;

  const movie = {
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    title,
    year: year || "",
    tmdbId: tmdbId || null,
    posterUrl: posterUrl || "",
    overview: overview || "",
    mediaType: mediaType || "movie",
    variants: [],
    createdAt: Date.now(),
  };
  library.push(movie);
  save();
  return movie;
}

export function addVariant(
  movieId,
  { quality, source, sourceUrl, status, filePath },
) {
  const movie = library.find((m) => m.id === movieId);
  if (!movie) return null;

  const existing = movie.variants.find(
    (v) => v.quality === quality && v.source === source,
  );
  if (existing) {
    if (status) existing.status = status;
    if (filePath) existing.filePath = filePath;
    if (sourceUrl) existing.sourceUrl = sourceUrl;
    save();
    return existing;
  }

  const variant = {
    id: `v_${Date.now().toString(36)}`,
    quality,
    source,
    sourceUrl: sourceUrl || "",
    status: status || "available",
    filePath: filePath || "",
    addedAt: Date.now(),
  };
  movie.variants.push(variant);
  save();
  return variant;
}

export function setVariantStatus(movieId, variantId, status, filePath) {
  const movie = library.find((m) => m.id === movieId);
  if (!movie) return null;
  const variant = movie.variants.find((v) => v.id === variantId);
  if (!variant) return null;
  variant.status = status;
  if (filePath) variant.filePath = filePath;
  save();
  return variant;
}

export function findMovies(query) {
  const q = query.toLowerCase();
  return library.filter(
    (m) => m.title.toLowerCase().includes(q) || m.tmdbId === query,
  );
}

export function getMovie(id) {
  return library.find((m) => m.id === id) || null;
}

export function getMovieByTmdbId(tmdbId) {
  return library.find((m) => String(m.tmdbId) === String(tmdbId)) || null;
}

export function getAllMovies() {
  return library;
}

export function getBestVariant(movieId) {
  const movie = library.find((m) => m.id === movieId);
  if (!movie) return null;

  const offline = movie.variants
    .filter((v) => v.status === "offline" && v.filePath)
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  if (offline.length > 0) return offline[0];

  const downloaded = movie.variants
    .filter((v) => v.status === "downloaded" && v.filePath)
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  if (downloaded.length > 0) return downloaded[0];

  const available = movie.variants
    .filter((v) => v.status === "available")
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  return available[0] || null;
}

function qualityRank(q) {
  const map = { "4k": 4, "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 };
  return map[q?.toLowerCase()] || 0;
}

export function formatVariantList(movie) {
  if (!movie.variants.length) return "No variants available";
  return movie.variants
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
    .map((v) => {
      const tag =
        v.status === "offline"
          ? "offline"
          : v.status === "downloaded"
            ? "downloaded"
            : v.status === "downloading"
              ? "downloading..."
              : "not downloaded";
      return `${v.quality} — ${v.source} (${tag})`;
    })
    .join("\n");
}

export function getLibraryDir() {
  return libraryDir;
}
