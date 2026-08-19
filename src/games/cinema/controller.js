import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";
import {
  buildModDashboard,
  buildSearchResults,
  buildShowtimePoster,
  buildMovieCard,
  BTN,
} from "./dashboard.js";
import { initScreens, getScreens, getScreen } from "./screens.js";
import {
  loadSchedule,
  addShow,
  cancelShow,
  getUpcoming,
  getShow,
  setShowMessageId,
} from "./schedule.js";
import {
  loadLibrary,
  addMovie,
  addVariant,
  findMovies,
  getMovie,
  getAllMovies,
  getMovieByTmdbId,
  formatVariantList,
} from "./library.js";
import { downloadFromUrl, getDownloadProgress } from "./downloader.js";
import { searchAll } from "./tmdb.js";
import { eReply } from "../../utils/embed.js";
import { auditLog } from "../../utils/logger.js";

function qualityRank(q) {
  const map = { "4k": 4, "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 };
  return map[q?.toLowerCase()] || 0;
}

let dashboardChannelId = null;
let announcementChannelId = null;
let dashboardChannel = null;
let announcementChannel = null;
let dashboardMessageId = null;
let admClient = null;

const searchCache = new Map();
const pickCache = new Map();

async function sendToScreen(screenId, command) {
  const screen = getScreen(screenId);
  if (!screen?.channelId) return;
  const ch = await admClient.channels.fetch(screen.channelId).catch(() => null);
  if (!ch) return;
  const msg = `${screen.prefix}${command}`;
  await ch.send(msg);
  auditLog("info", "CINEMA", `Screen ${screen.name}: ${msg}`);
}

async function refreshDashboard() {
  if (!dashboardChannel) return;
  const shows = getUpcoming();
  const payload = buildModDashboard(shows);

  try {
    if (dashboardMessageId) {
      const existing = await dashboardChannel.messages
        .fetch(dashboardMessageId)
        .catch(() => null);
      if (existing) {
        await existing.edit(payload);
        return;
      }
    }
    const msg = await dashboardChannel.send(payload);
    dashboardMessageId = msg.id;
  } catch (err) {
    console.error(`[CINEMA] Dashboard post failed: ${err.message}`);
  }
}

async function postAnnouncement(show) {
  if (!announcementChannel) return;
  const screen = getScreen(show.screenId);
  const payload = buildShowtimePoster({
    title: show.title,
    year: show.year,
    overview: show.overview,
    posterUrl: show.posterUrl,
    showtimeUnix: show.showtimeUnix,
    screenName: screen?.name || "Screen",
    voiceChannelId: screen?.voiceChannelId,
  });

  try {
    const msg = await announcementChannel.send(payload);
    setShowMessageId(show.id, msg.id);
    auditLog("info", "CINEMA", `Announced "${show.title}" (${msg.id})`);
  } catch (err) {
    console.error(`[CINEMA] Announcement failed: ${err.message}`);
  }
}

export async function initCinema(client) {
  admClient = client;
  initScreens();
  loadSchedule();
  loadLibrary();

  dashboardChannelId = process.env.CINEMA_DASHBOARD_CHANNEL_ID;
  announcementChannelId = process.env.CINEMA_ANNOUNCEMENT_CHANNEL_ID;

  if (!dashboardChannelId) {
    console.warn("[CINEMA] CINEMA_DASHBOARD_CHANNEL_ID not set.");
    return;
  }

  dashboardChannel = await client.channels
    .fetch(dashboardChannelId)
    .catch(() => null);
  announcementChannel = announcementChannelId
    ? await client.channels.fetch(announcementChannelId).catch(() => null)
    : null;

  if (!dashboardChannel) {
    console.warn(
      `[CINEMA] Could not fetch dashboard channel ${dashboardChannelId}.`,
    );
    return;
  }

  await refreshDashboard();
  console.log("[CINEMA] Cinema system initialised.");
}

export async function handleCinemaButton(interaction) {
  if (!interaction.isButton()) return false;
  const id = interaction.customId;
  if (!id.startsWith("cinema:")) return false;

  if (id.startsWith("cinema:poster_") || id.startsWith("cinema:noop")) {
    await interaction.deferUpdate();
    return true;
  }

  if (id.startsWith("cinema:screen_join_")) {
    const screenId = parseInt(id.replace("cinema:screen_join_", ""), 10);
    const screen = getScreen(screenId);
    if (!screen?.voiceChannelId) {
      await interaction.reply(
        eReply("No VC", "This screen has no voice channel configured."),
      );
      return true;
    }
    await interaction.reply({
      content: `🎬 Join the screen here: <#${screen.voiceChannelId}>`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (id.startsWith("cinema:pick_")) {
    await handlePick(interaction);
    return true;
  }

  if (id.startsWith("cinema:card_upload_")) {
    const movieId = id.replace("cinema:card_upload_", "");
    pickCache.set(interaction.user.id, { movieId });
    const modal = new ModalBuilder()
      .setCustomId("cinema:card_upload_modal")
      .setTitle("Upload Offline File")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cul_url")
            .setLabel("GDrive or direct download URL")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cul_quality")
            .setLabel("Quality (e.g. 1080p, 4K)")
            .setStyle(TextInputStyle.Short)
            .setValue("1080p")
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cul_filename")
            .setLabel("Filename (e.g. movie-1080p.mkv)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  if (id.startsWith("cinema:card_download_")) {
    const movieId = id.replace("cinema:card_download_", "");
    loadLibrary();
    const movie = getMovie(movieId);
    if (!movie) {
      await interaction.reply(eReply("Not Found", "Movie not in library."));
      return true;
    }
    const screens = getScreens();
    if (screens.length > 0)
      await sendToScreen(screens[0].id, `prepare ${movie.title}`);
    await interaction.reply(
      eReply(
        "Downloading",
        `Sent prefetch for **${movie.title}** to Screen 1.`,
      ),
    );
    return true;
  }

  if (id.startsWith("cinema:card_schedule_")) {
    const movieId = id.replace("cinema:card_schedule_", "");
    pickCache.set(interaction.user.id, { movieId });
    const screens = getScreens();
    const modal = new ModalBuilder()
      .setCustomId("cinema:card_schedule_modal")
      .setTitle("Schedule Showtime")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cs_time")
            .setLabel("Time (e.g. 8:30 PM or 20:30)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cs_screen")
            .setLabel(`Screen number (1-${screens.length || 3})`)
            .setStyle(TextInputStyle.Short)
            .setValue("1")
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  const screens = getScreens();

  switch (id) {
    case BTN.SEARCH: {
      const modal = new ModalBuilder()
        .setCustomId("cinema:search_modal")
        .setTitle("Search Movie / TV")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:search_input")
              .setLabel("Title")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("Interstellar")
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    case BTN.SCHEDULE: {
      loadLibrary();
      const movies = getAllMovies().filter((m) =>
        m.variants.some(
          (v) => v.status === "offline" || v.status === "downloaded",
        ),
      );
      if (movies.length === 0) {
        await interaction.reply(
          eReply(
            "No Movies Ready",
            "No offline movies available. Download one first.",
          ),
        );
        return true;
      }
      const options = movies.slice(0, 25).map((m) => ({
        label: `${m.title} ${m.year ? `(${m.year})` : ""}`.slice(0, 100),
        value: m.id,
      }));
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("cinema:schedule_select")
          .setPlaceholder("Pick a movie to schedule")
          .addOptions(options),
      );
      await interaction.reply({
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    case BTN.DOWNLOAD: {
      const progress = getDownloadProgress();
      if (!progress) {
        await interaction.reply(
          eReply("No Downloads", "Nothing is downloading right now."),
        );
        return true;
      }
      const pct =
        progress.totalBytes > 0
          ? `${Math.round((progress.bytes / progress.totalBytes) * 100)}%`
          : `${(progress.bytes / 1e6).toFixed(1)} MB`;
      const status = progress.done
        ? "✅ Complete"
        : progress.error
          ? `❌ ${progress.error}`
          : `⬇️ ${pct}`;
      await interaction.reply(
        eReply("Download Progress", `**${progress.filename}**\n${status}`),
      );
      return true;
    }

    case BTN.CANCEL: {
      const progress = getDownloadProgress();
      if (!progress || progress.done) {
        await interaction.reply(
          eReply("Nothing to Cancel", "No active download."),
        );
        return true;
      }
      await interaction.reply(
        eReply(
          "Cancel",
          `Current download: **${progress.filename}**\n-# Cancellation not yet implemented — stop the process manually.`,
        ),
      );
      return true;
    }

    case BTN.ADD_MOVIE: {
      const modal = new ModalBuilder()
        .setCustomId("cinema:add_movie_modal")
        .setTitle("Add External Movie")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:add_title")
              .setLabel("Movie title (searches TMDB)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:add_url")
              .setLabel("GDrive or direct download URL")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:add_quality")
              .setLabel("Quality (e.g. 1080p, 4K)")
              .setStyle(TextInputStyle.Short)
              .setValue("1080p")
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("cinema:add_filename")
              .setLabel("Filename (e.g. movie-1080p.mkv)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    case BTN.LIBRARY: {
      loadLibrary();
      const movies = getAllMovies();
      const offlineMovies = movies.filter((m) =>
        m.variants.some(
          (v) => v.status === "offline" || v.status === "downloaded",
        ),
      );
      if (offlineMovies.length === 0) {
        await interaction.reply(
          eReply(
            "Library Empty",
            "No offline files yet. Use **Add Movie** to add one.",
          ),
        );
        return true;
      }
      const list = offlineMovies
        .slice(0, 15)
        .map((m) => {
          const best = m.variants
            .filter((v) => v.status === "offline" || v.status === "downloaded")
            .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0];
          return `🟢 **${m.title}** ${m.year ? `(${m.year})` : ""} — ${best?.quality || "?"}`;
        })
        .join("\n");
      await interaction.reply(eReply("Offline Library", list));
      return true;
    }

    case BTN.REFRESH:
      await interaction.deferUpdate();
      await refreshDashboard();
      return true;

    default:
      return false;
  }
}

async function handlePick(interaction) {
  const parts = interaction.customId.split("_");
  const tmdbId = parts[1];
  const type = parts[2];
  const userId = interaction.user.id;

  const results = searchCache.get(userId);
  const picked = results?.find(
    (r) => String(r.id) === tmdbId && r.type === type,
  );
  if (!picked) {
    await interaction.reply(
      eReply("Expired", "Search results expired. Search again."),
    );
    return;
  }

  pickCache.set(userId, picked);

  loadLibrary();
  const movie = addMovie({
    title: picked.title,
    year: picked.year,
    tmdbId: picked.id,
    posterUrl: picked.poster,
    overview: picked.overview,
    mediaType: picked.type,
  });

  addVariant(movie.id, {
    quality: "1080p",
    source: "Provider",
    status: "available",
  });

  const card = buildMovieCard(movie);
  await interaction.reply(card);
}

function parseTime(input) {
  const str = input.trim().toLowerCase();

  const ampm = str.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    if (ampm[3].toLowerCase() === "pm" && h !== 12) h += 12;
    if (ampm[3].toLowerCase() === "am" && h === 12) h = 0;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  const h24 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const d = new Date();
    d.setHours(parseInt(h24[1], 10), parseInt(h24[2], 10), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  return null;
}

export async function handleCinemaModal(interaction) {
  if (!interaction.isModalSubmit()) return false;
  const id = interaction.customId;
  if (!id.startsWith("cinema:")) return false;

  switch (id) {
    case "cinema:search_modal": {
      const query = interaction.fields
        .getTextInputValue("cinema:search_input")
        .trim();
      if (!query) {
        await interaction.reply(eReply("Missing", "Enter a title to search."));
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const results = await searchAll(query);
        if (results.length === 0) {
          await interaction.editReply(
            eReply("No Results", `Nothing found for "${query}".`),
          );
          return true;
        }

        searchCache.set(interaction.user.id, results);
        setTimeout(() => searchCache.delete(interaction.user.id), 300000);

        const payload = buildSearchResults(results);
        await interaction.editReply(payload);
      } catch (err) {
        await interaction.editReply(eReply("Error", err.message));
      }
      return true;
    }

    case "cinema:schedule_modal": {
      const title = interaction.fields
        .getTextInputValue("cinema:sched_title")
        .trim();
      const timeStr = interaction.fields
        .getTextInputValue("cinema:sched_time")
        .trim();
      const screenNum = parseInt(
        interaction.fields.getTextInputValue("cinema:sched_screen").trim(),
        10,
      );

      const showtimeUnix = parseTime(timeStr);
      if (!showtimeUnix) {
        await interaction.reply(
          eReply("Invalid Time", "Use format like `8:30 PM` or `20:30`."),
        );
        return true;
      }

      const screen = getScreen(screenNum);
      if (!screen) {
        await interaction.reply(
          eReply("Invalid Screen", `Screen ${screenNum} not found.`),
        );
        return true;
      }

      const show = addShow({ title, showtimeUnix, screenId: screen.id });
      await interaction.reply(
        eReply(
          "Scheduled",
          `**${title}** scheduled for <t:${showtimeUnix}:F> on **${screen.name}**.`,
        ),
      );
      await postAnnouncement(show);
      await refreshDashboard();
      return true;
    }

    case "cinema:picked_schedule_modal": {
      const picked = pickCache.get(interaction.user.id);
      if (!picked) {
        await interaction.reply(
          eReply("Expired", "Selection expired. Search again."),
        );
        return true;
      }
      pickCache.delete(interaction.user.id);

      const timeStr = interaction.fields
        .getTextInputValue("cinema:picked_time")
        .trim();
      const screenNum = parseInt(
        interaction.fields.getTextInputValue("cinema:picked_screen").trim(),
        10,
      );

      const showtimeUnix = parseTime(timeStr);
      if (!showtimeUnix) {
        await interaction.reply(
          eReply("Invalid Time", "Use format like `8:30 PM` or `20:30`."),
        );
        return true;
      }

      const screen = getScreen(screenNum);
      if (!screen) {
        await interaction.reply(
          eReply("Invalid Screen", `Screen ${screenNum} not found.`),
        );
        return true;
      }

      const show = addShow({
        title: picked.title,
        year: picked.year,
        overview: picked.overview,
        posterUrl: picked.poster,
        showtimeUnix,
        screenId: screen.id,
        tmdbId: picked.id,
        mediaType: picked.type,
      });

      await interaction.reply(
        eReply(
          "Scheduled",
          `**${picked.title}** scheduled for <t:${showtimeUnix}:F> on **${screen.name}**.`,
        ),
      );
      await postAnnouncement(show);
      await refreshDashboard();
      return true;
    }

    case "cinema:download_modal": {
      const title = interaction.fields
        .getTextInputValue("cinema:dl_title")
        .trim();
      const screenNum = parseInt(
        interaction.fields.getTextInputValue("cinema:dl_screen").trim(),
        10,
      );

      const screen = getScreen(screenNum);
      if (!screen) {
        await interaction.reply(
          eReply("Invalid Screen", `Screen ${screenNum} not found.`),
        );
        return true;
      }

      await sendToScreen(screen.id, `prepare ${title}`);
      await interaction.reply(
        eReply(
          "Downloading",
          `Sent prefetch for **${title}** to **${screen.name}**.`,
        ),
      );
      return true;
    }

    case "cinema:play_modal": {
      const input = interaction.fields
        .getTextInputValue("cinema:play_input")
        .trim();
      const screenNum = parseInt(
        interaction.fields.getTextInputValue("cinema:play_screen").trim(),
        10,
      );

      const screen = getScreen(screenNum);
      if (!screen) {
        await interaction.reply(
          eReply("Invalid Screen", `Screen ${screenNum} not found.`),
        );
        return true;
      }

      const looksLikeUrl = /^(https?:\/\/|\/|[a-zA-Z]:\\)/.test(input);
      await sendToScreen(
        screen.id,
        looksLikeUrl ? `play ${input}` : `movie ${input}`,
      );
      await interaction.reply(
        eReply("Playing", `Sent to **${screen.name}**: ${input}`),
      );
      return true;
    }

    case "cinema:add_movie_modal": {
      const title = interaction.fields
        .getTextInputValue("cinema:add_title")
        .trim();
      const url = interaction.fields.getTextInputValue("cinema:add_url").trim();
      const quality = interaction.fields
        .getTextInputValue("cinema:add_quality")
        .trim();
      const filename = interaction.fields
        .getTextInputValue("cinema:add_filename")
        .trim();

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let movieData = null;
      try {
        const results = await searchAll(title);
        if (results.length > 0) movieData = results[0];
      } catch {}

      const movie = addMovie({
        title: movieData?.title || title,
        year: movieData?.year || "",
        tmdbId: movieData?.id || null,
        posterUrl: movieData?.poster || "",
        overview: movieData?.overview || "",
        mediaType: movieData?.type || "movie",
      });

      const variant = addVariant(movie.id, {
        quality,
        source: "External",
        sourceUrl: url,
        status: "available",
      });
      downloadFromUrl(url, movie.id, variant.id, filename);

      await interaction.editReply(
        eReply(
          "Adding & Downloading",
          `**${movie.title}** ${movie.year ? `(${movie.year})` : ""}\n${quality} · \`${filename}\`\nDownloading in background.`,
        ),
      );
      return true;
    }

    case "cinema:upload_link_modal": {
      const title = interaction.fields
        .getTextInputValue("cinema:ul_title")
        .trim();
      const url = interaction.fields.getTextInputValue("cinema:ul_url").trim();
      const quality = interaction.fields
        .getTextInputValue("cinema:ul_quality")
        .trim();
      const filename = interaction.fields
        .getTextInputValue("cinema:ul_filename")
        .trim();

      loadLibrary();
      const matches = findMovies(title);
      if (matches.length === 0) {
        await interaction.reply(
          eReply("Not Found", `"${title}" not in library. Add it first.`),
        );
        return true;
      }

      const movie = matches[0];
      const variant = addVariant(movie.id, {
        quality,
        source: "GDrive",
        sourceUrl: url,
        status: "available",
      });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      downloadFromUrl(url, movie.id, variant.id, filename);
      await interaction.editReply(
        eReply(
          "Downloading",
          `**${movie.title}** ${quality}\nFile: \`${filename}\`\nThis runs in the background.`,
        ),
      );
      return true;
    }

    case "cinema:card_upload_modal": {
      const ctx = pickCache.get(interaction.user.id);
      if (!ctx?.movieId) {
        await interaction.reply(eReply("Expired", "Try again."));
        return true;
      }
      pickCache.delete(interaction.user.id);

      const url = interaction.fields.getTextInputValue("cinema:cul_url").trim();
      const quality = interaction.fields
        .getTextInputValue("cinema:cul_quality")
        .trim();
      const filename = interaction.fields
        .getTextInputValue("cinema:cul_filename")
        .trim();

      loadLibrary();
      const movie = getMovie(ctx.movieId);
      if (!movie) {
        await interaction.reply(
          eReply("Not Found", "Movie removed from library."),
        );
        return true;
      }

      const variant = addVariant(movie.id, {
        quality,
        source: "External",
        sourceUrl: url,
        status: "available",
      });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      downloadFromUrl(url, movie.id, variant.id, filename);
      await interaction.editReply(
        eReply(
          "Downloading",
          `**${movie.title}** ${quality}\nFile: \`${filename}\`\nRunning in background.`,
        ),
      );
      return true;
    }

    case "cinema:card_schedule_modal": {
      const ctx = pickCache.get(interaction.user.id);
      if (!ctx?.movieId) {
        await interaction.reply(eReply("Expired", "Try again."));
        return true;
      }
      pickCache.delete(interaction.user.id);

      const timeStr = interaction.fields
        .getTextInputValue("cinema:cs_time")
        .trim();
      const screenNum = parseInt(
        interaction.fields.getTextInputValue("cinema:cs_screen").trim(),
        10,
      );

      const showtimeUnix = parseTime(timeStr);
      if (!showtimeUnix) {
        await interaction.reply(
          eReply("Invalid Time", "Use `8:30 PM` or `20:30`."),
        );
        return true;
      }
      const screen = getScreen(screenNum);
      if (!screen) {
        await interaction.reply(
          eReply("Invalid Screen", `Screen ${screenNum} not found.`),
        );
        return true;
      }

      loadLibrary();
      const movie = getMovie(ctx.movieId);
      if (!movie) {
        await interaction.reply(
          eReply("Not Found", "Movie removed from library."),
        );
        return true;
      }

      const show = addShow({
        title: movie.title,
        year: movie.year,
        overview: movie.overview,
        posterUrl: movie.posterUrl,
        showtimeUnix,
        screenId: screen.id,
        tmdbId: movie.tmdbId,
        mediaType: movie.mediaType,
      });

      await interaction.reply(
        eReply(
          "Scheduled",
          `**${movie.title}** at <t:${showtimeUnix}:F> on **${screen.name}**.`,
        ),
      );
      await postAnnouncement(show);
      await refreshDashboard();
      return true;
    }

    default:
      return false;
  }
}

export async function handleCinemaSelect(interaction) {
  if (!interaction.isStringSelectMenu()) return false;
  if (!interaction.customId.startsWith("cinema:")) return false;

  if (interaction.customId === "cinema:schedule_select") {
    const movieId = interaction.values[0];
    pickCache.set(interaction.user.id, { movieId });
    const screens = getScreens();
    const modal = new ModalBuilder()
      .setCustomId("cinema:card_schedule_modal")
      .setTitle("Schedule Showtime")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cs_time")
            .setLabel("Time (e.g. 8:30 PM or 20:30)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("cinema:cs_screen")
            .setLabel(`Screen (1-${screens.length || 3})`)
            .setStyle(TextInputStyle.Short)
            .setValue("1")
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  return false;
}
