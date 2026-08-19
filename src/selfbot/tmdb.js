import { config } from "./config.js";

const API_BASE = "https://api.themoviedb.org/3";
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 10000;

const cache = new Map();
const inFlightSearches = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err) {
  if (!err) return "unknown error";
  const code = err.cause?.code || err.code;
  return code ? `${err.message} (${code})` : err.message;
}

function requireApiKey() {
  if (!config.tmdbApiKey) {
    throw new Error(
      "TMDB_API_KEY is missing in .env. Get a free key at https://www.themoviedb.org/settings/api",
    );
  }
  return config.tmdbApiKey;
}

async function tmdbRequest(pathname, params = {}) {
  const url = new URL(`${API_BASE}${pathname}`);
  url.searchParams.set("api_key", requireApiKey());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 401) {
        throw new Error(
          "TMDB rejected the API key (401). Check TMDB_API_KEY in .env.",
        );
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`TMDB responded ${res.status}`);
      } else if (!res.ok) {
        throw new Error(`TMDB responded ${res.status}`);
      } else {
        return await res.json();
      }
    } catch (err) {
      if (err.message.startsWith("TMDB rejected")) throw err;
      lastError = err;
    }

    if (attempt < MAX_ATTEMPTS) {
      const backoff = Math.min(300 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      console.warn(
        `[TMDB RETRY] Attempt ${attempt}/${MAX_ATTEMPTS} failed (${describeError(lastError)}). Retrying in ${backoff}ms.`,
      );
      await sleep(backoff);
    }
  }

  throw new Error(
    `TMDB request failed after ${MAX_ATTEMPTS} attempts: ${describeError(lastError)}`,
  );
}

function simplify(title) {
  return (title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

function normalize(raw, type) {
  const date = raw.release_date || raw.first_air_date || "";
  return {
    id: raw.id,
    type,
    title: raw.title || raw.name || "Unknown Title",
    year: date.slice(0, 4),
    popularity: raw.popularity ?? 0,
    overview: raw.overview || "",
  };
}

function queryVariants(query) {
  const variants = [query];
  if (!/\s/.test(query)) {
    const collapsed = query.replace(/[^\p{L}\p{N}]+/gu, "");
    if (
      collapsed.length >= 3 &&
      collapsed.toLowerCase() !== query.toLowerCase()
    ) {
      variants.push(collapsed);
    }
  }
  return variants;
}

function relevance(item, simplifiedQuery) {
  const title = simplify(item.title);
  let score = item.popularity;
  if (title === simplifiedQuery) score += 10000;
  else if (title.startsWith(simplifiedQuery)) score += 1000;
  else if (title.includes(simplifiedQuery)) score += 100;
  return score;
}

export async function searchTMDB(query) {
  const trimmed = (query || "").trim();
  if (!trimmed) return [];

  const cacheKey = `search:${trimmed.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(
      `[TMDB SEARCH] Cache hit for "${trimmed}" (${cached.length} results)`,
    );
    return cached;
  }

  const inFlight = inFlightSearches.get(cacheKey);
  if (inFlight) {
    console.log(`[TMDB SEARCH] Reusing in-flight lookup for "${trimmed}"`);
    return inFlight;
  }

  const task = (async () => {
    console.log(`[TMDB SEARCH] Searching for: "${trimmed}"`);

    const lookups = queryVariants(trimmed).flatMap((variant) => [
      {
        type: "movie",
        promise: tmdbRequest("/search/movie", {
          query: variant,
          include_adult: "false",
        }),
      },
      {
        type: "tv",
        promise: tmdbRequest("/search/tv", {
          query: variant,
          include_adult: "false",
        }),
      },
    ]);

    const settled = await Promise.allSettled(
      lookups.map((lookup) => lookup.promise),
    );

    if (settled.every((result) => result.status === "rejected")) {
      throw settled[0].reason;
    }

    const merged = new Map();
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        console.warn(`[TMDB SEARCH] Partial failure: ${result.reason.message}`);
        return;
      }
      const { type } = lookups[index];
      for (const raw of result.value.results || []) {
        const key = `${type}:${raw.id}`;
        if (!merged.has(key)) merged.set(key, normalize(raw, type));
      }
    });

    const simplifiedQuery = simplify(trimmed);
    const results = [...merged.values()].sort(
      (a, b) => relevance(b, simplifiedQuery) - relevance(a, simplifiedQuery),
    );

    cacheSet(cacheKey, results);

    console.log(
      `[TMDB SEARCH] Found ${results.length} results for "${trimmed}"`,
    );
    if (results.length > 0) {
      const top = results[0];
      console.log(
        `[TMDB TOP MATCH] "${top.title}" (${top.type.toUpperCase()} ${top.year}, ID: ${top.id})`,
      );
    }

    return results;
  })().finally(() => {
    inFlightSearches.delete(cacheKey);
  });

  inFlightSearches.set(cacheKey, task);
  return task;
}

export async function findMedia(query, preferredType = null) {
  const results = await searchTMDB(query);
  if (results.length === 0) return null;
  if (!preferredType) return results[0];
  return results.find((item) => item.type === preferredType) || null;
}
