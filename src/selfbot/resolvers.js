import { config } from "./config.js";

export const SERVERS = [
  {
    name: "VidLink",
    movie: (id) => `https://vidlink.pro/movie/${id}`,
    tv: (id, season, episode) =>
      `https://vidlink.pro/tv/${id}/${season}/${episode}`,
  },
  {
    name: "VidEasy",
    movie: (id) => `https://player.videasy.to/movie/${id}`,
    tv: (id, season, episode) =>
      `https://player.videasy.to/tv/${id}/${season}/${episode}`,
  },
  {
    name: "AutoEmbed",
    movie: (id) => `https://autoembed.co/movie/tmdb/${id}`,
    tv: (id, season, episode) =>
      `https://autoembed.co/tv/tmdb/${id}-${season}-${episode}`,
  },
  {
    name: "VidSrc",
    movie: (id) => `https://vidsrc.me/embed/movie?tmdb=${id}`,
    tv: (id, season, episode) =>
      `https://vidsrc.me/embed/tv?tmdb=${id}&season=${season}&episode=${episode}`,
  },
];

export function clampServerIndex(serverIndex) {
  const parsed = Number.parseInt(serverIndex, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(parsed, SERVERS.length - 1));
}

export function getStreamSource({
  tmdbId,
  type = "movie",
  season = 1,
  episode = 1,
  serverIndex = 0,
}) {
  if (!tmdbId) throw new Error("getStreamSource requires a tmdbId.");

  const index = clampServerIndex(serverIndex);
  const server = SERVERS[index];
  const embedUrl =
    type === "tv" ? server.tv(tmdbId, season, episode) : server.movie(tmdbId);

  console.log(`[RESOLVER] ${server.name} → ${embedUrl}`);

  return { serverName: server.name, serverIndex: index, embedUrl };
}

function providerOrder(preferredIndex) {
  const start = clampServerIndex(preferredIndex);
  return SERVERS.map((_, index) => (start + index) % SERVERS.length);
}

export async function resolvePlayableStream(media, extractor, options = {}) {
  try {
    return await walkProviders(media, extractor, options);
  } finally {
    await extractor.close().catch(() => {});
  }
}

async function walkProviders(media, extractor, options) {
  const { tmdbId, type = "movie", season = 1, episode = 1 } = media;
  const order = providerOrder(
    options.preferredServerIndex ?? config.defaultServerIndex,
  );
  const timeout = options.timeout ?? config.extractorTimeoutMs;
  const attempts = [];

  for (const serverIndex of order) {
    const source = getStreamSource({
      tmdbId,
      type,
      season,
      episode,
      serverIndex,
    });

    let extracted = null;
    try {
      extracted = await extractor.extractStreamUrl(source.embedUrl, {
        timeout,
      });
    } catch (err) {
      console.warn(`[RESOLVER] ${source.serverName} threw: ${err.message}`);
      attempts.push(`${source.serverName} (error)`);
      continue;
    }

    if (!extracted) {
      attempts.push(`${source.serverName} (no stream)`);
      continue;
    }

    if (attempts.length > 0) {
      console.log(`[RESOLVER] Fell back past ${attempts.join(", ")}`);
    }
    console.log(`[RESOLVER] Playable via ${source.serverName}`);

    return {
      serverName: source.serverName,
      serverIndex: source.serverIndex,
      embedUrl: source.embedUrl,
      url: extracted.url,
      width: extracted.width,
      height: extracted.height,
      headers: {
        Referer: extracted.referer,
        Origin: extracted.origin,
        "User-Agent": extracted.userAgent,
      },
    };
  }

  throw new Error(
    `No provider returned a playable stream. Tried: ${attempts.join(", ")}.`,
  );
}
