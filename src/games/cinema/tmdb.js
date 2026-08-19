const API_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p";
const REQUEST_TIMEOUT_MS = 10000;

function apiKey() {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY is not set in .env");
  return key;
}

async function tmdbGet(pathname, params = {}) {
  const url = new URL(`${API_BASE}${pathname}`);
  url.searchParams.set("api_key", apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

export async function searchMovies(query) {
  const data = await tmdbGet("/search/movie", {
    query,
    include_adult: "false",
  });
  return (data.results || []).slice(0, 10).map((m) => ({
    id: m.id,
    title: m.title,
    year: (m.release_date || "").slice(0, 4),
    overview: m.overview || "",
    poster: m.poster_path ? `${IMG_BASE}/w780${m.poster_path}` : null,
    posterThumb: m.poster_path ? `${IMG_BASE}/w185${m.poster_path}` : null,
    popularity: m.popularity,
  }));
}

export async function searchTV(query) {
  const data = await tmdbGet("/search/tv", { query, include_adult: "false" });
  return (data.results || []).slice(0, 10).map((t) => ({
    id: t.id,
    title: t.name,
    year: (t.first_air_date || "").slice(0, 4),
    overview: t.overview || "",
    poster: t.poster_path ? `${IMG_BASE}/w780${t.poster_path}` : null,
    posterThumb: t.poster_path ? `${IMG_BASE}/w185${t.poster_path}` : null,
    popularity: t.popularity,
  }));
}

export async function searchAll(query) {
  const [movies, tv] = await Promise.allSettled([
    searchMovies(query),
    searchTV(query),
  ]);
  const results = [
    ...(movies.status === "fulfilled"
      ? movies.value.map((m) => ({ ...m, type: "movie" }))
      : []),
    ...(tv.status === "fulfilled"
      ? tv.value.map((t) => ({ ...t, type: "tv" }))
      : []),
  ];
  results.sort((a, b) => b.popularity - a.popularity);
  return results.slice(0, 10);
}

export function posterUrl(path, size = "w780") {
  return path ? `${IMG_BASE}/${size}${path}` : null;
}
