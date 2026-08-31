import {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { icon, emojiObj } from "../../utils/icons.js";
import { getScreens } from "./screens.js";
import { qualityRank, getBestVariant } from "./library.js";

export const BTN = {
  SEARCH: "cinema:search",
  SCHEDULE: "cinema:schedule",
  DOWNLOAD: "cinema:download",
  CANCEL: "cinema:cancel",
  ADD_MOVIE: "cinema:add_movie",
  LIBRARY: "cinema:library",
  REFRESH: "cinema:refresh",
};

function boundedText(value, maximum, fallback = "") {
  const text = String(value || fallback).trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function buttonLabel(value, fallback = "Screen") {
  return boundedText(value, 80, fallback) || fallback;
}

function sectionContent(title, year, overview) {
  const safeTitle = boundedText(title, 180, "Untitled");
  const titleLine = year
    ? `**${safeTitle}** (${boundedText(year, 4)})`
    : `**${safeTitle}**`;
  const heading = `${icon("CINEMA_FILM")} ${titleLine}`;
  const safeOverview = boundedText(overview, 3900 - heading.length);
  return safeOverview ? `${heading}\n\n${safeOverview}` : heading;
}

function formatAmPm(unix) {
  const d = new Date(unix * 1000);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function formatDate(unix) {
  return new Date(unix * 1000).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function buildModDashboard(shows) {
  const screens = getScreens();
  const container = new ContainerBuilder().setAccentColor(0x00aaaa);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `${icon("CINEMA_FILM")} **NexKord Cinema** — Control Panel`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Large),
  );

  if (screens.length > 0) {
    const screenRow = new ActionRowBuilder().addComponents(
      ...screens
        .slice(0, 5)
        .map((s) =>
          new ButtonBuilder()
            .setCustomId(`cinema:screen_join_${s.id}`)
            .setEmoji(emojiObj("CINEMA_SCREEN"))
            .setLabel(buttonLabel(s.name))
            .setStyle(ButtonStyle.Secondary),
        ),
    );
    container.addActionRowComponents(screenRow);
  }

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Large),
  );

  if (shows.length > 0) {
    const list = shows
      .slice(0, 8)
      .map((s, i) => {
        const screen = screens.find((sc) => sc.id === s.screenId);
        const title = boundedText(s.title, 140, "Untitled");
        const screenName = boundedText(screen?.name, 50, "?");
        return `**${i + 1}.** ${title} — ${formatAmPm(s.showtimeUnix)} · ${screenName}`;
      })
      .join("\n");
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Upcoming**\n${list}`),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**Upcoming**\n-# Nothing scheduled"),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Large),
  );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN.SEARCH)
      .setEmoji(emojiObj("CINEMA_STAR"))
      .setLabel("Search")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN.SCHEDULE)
      .setEmoji(emojiObj("CINEMA_CALENDAR"))
      .setLabel("Schedule")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN.DOWNLOAD)
      .setEmoji(emojiObj("CINEMA_CLAPPER"))
      .setLabel("Progress")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN.CANCEL)
      .setEmoji(emojiObj("STOP"))
      .setLabel("Cancel DL")
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN.ADD_MOVIE)
      .setEmoji(emojiObj("CINEMA_TICKET"))
      .setLabel("Add Movie")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN.LIBRARY)
      .setEmoji(emojiObj("QUEUE"))
      .setLabel("Library")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN.REFRESH)
      .setEmoji(emojiObj("REFRESH"))
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
  );

  container.addActionRowComponents(row1);
  container.addActionRowComponents(row2);

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  const ts = Math.floor(Date.now() / 1000);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# NexKord · <t:${ts}:f>`),
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export function buildSearchResults(results) {
  const container = new ContainerBuilder().setAccentColor(0xff0033);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `${icon("CINEMA_STAR")} **Search Results**`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  const rows = [];
  for (let i = 0; i < Math.min(results.length, 4); i++) {
    const r = results[i];
    const label = r.year ? `${r.title} (${r.year})` : r.title;
    const truncated = label.length > 80 ? `${label.slice(0, 77)}...` : label;

    if (r.posterThumb) {
      try {
        const section = new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**${i + 1}.** ${truncated}\n-# ${r.type}`,
            ),
          )
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(r.posterThumb));
        container.addSectionComponents(section);
      } catch {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**${i + 1}.** ${truncated} — -# ${r.type}`,
          ),
        );
      }
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${i + 1}.** ${truncated} — -# ${r.type}`,
        ),
      );
    }

    rows.push(
      new ButtonBuilder()
        .setCustomId(`cinema:pick_${r.id}_${r.type}`)
        .setLabel(`${i + 1}`)
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (rows.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    );
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(...rows),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );
  const ts = Math.floor(Date.now() / 1000);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# Pick a result to add · <t:${ts}:f>`,
    ),
  );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

export function buildShowtimePoster({
  title,
  year,
  overview,
  posterUrl,
  showtimeUnix,
  screenName,
}) {
  const container = new ContainerBuilder().setAccentColor(0xff0033);

  const sectionText = sectionContent(title, year, overview);

  if (posterUrl) {
    try {
      const section = new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(sectionText),
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(posterUrl));
      container.addSectionComponents(section);
    } catch {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(sectionText),
      );
    }
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(sectionText),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  const dateLabel = formatDate(showtimeUnix);
  const timeLabel = formatAmPm(showtimeUnix);

  const infoRow1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cinema:poster_date_${Date.now()}`)
      .setEmoji(emojiObj("CINEMA_CALENDAR"))
      .setLabel(dateLabel)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cinema:poster_time_${Date.now()}`)
      .setEmoji(emojiObj("CINEMA_CLOCK"))
      .setLabel(timeLabel)
      .setStyle(ButtonStyle.Secondary),
  );

  const infoRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cinema:poster_screen_${Date.now()}`)
      .setEmoji(emojiObj("CINEMA_SCREEN"))
      .setLabel(buttonLabel(screenName))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cinema:poster_brand_${Date.now()}`)
      .setEmoji(emojiObj("CINEMA_TICKET"))
      .setLabel("NexKord Cinema")
      .setStyle(ButtonStyle.Secondary),
  );

  container.addActionRowComponents(infoRow1);
  container.addActionRowComponents(infoRow2);

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  const ts = Math.floor(Date.now() / 1000);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# NexKord Cinema · <t:${ts}:f>`),
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export function buildMovieCard(movie) {
  const container = new ContainerBuilder().setAccentColor(0xff0033);

  const sectionText = sectionContent(movie.title, movie.year, movie.overview);

  if (movie.posterUrl) {
    try {
      const section = new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(sectionText),
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(movie.posterUrl));
      container.addSectionComponents(section);
    } catch {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(sectionText),
      );
    }
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(sectionText),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  if (movie.variants.length > 0) {
    const variantLines = [...movie.variants]
      .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
      .slice(0, 20)
      .map((v) => {
        const statusIcon =
          v.status === "offline"
            ? "🟢"
            : v.status === "downloaded"
              ? "🟡"
              : v.status === "downloading"
                ? "🔵"
                : "⚫";
        return `${statusIcon} **${boundedText(v.quality, 30, "unknown")}** · ${boundedText(v.source, 50, "Unknown")} · ${boundedText(v.status, 30, "available")}`;
      })
      .join("\n");
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Variants**\n${variantLines}`),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**Variants**\n-# None added yet"),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  const uploadId = `cinema:card_upload_${movie.id}`;
  const scheduleId = `cinema:card_schedule_${movie.id}`;
  if (uploadId.length <= 100 && scheduleId.length <= 100) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(uploadId)
        .setEmoji(emojiObj("CINEMA_TICKET"))
        .setLabel("Upload Link")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(scheduleId)
        .setEmoji(emojiObj("CINEMA_CALENDAR"))
        .setLabel("Schedule")
        .setDisabled(!getBestVariant(movie.id))
        .setStyle(ButtonStyle.Secondary),
    );
    container.addActionRowComponents(row);
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# Controls unavailable for this legacy library entry.",
      ),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  const cardTs = Math.floor(Date.now() / 1000);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# NexKord Cinema · <t:${cardTs}:f>`),
  );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

export function buildShowtimesBoard(shows) {
  const screens = getScreens();
  const container = new ContainerBuilder().setAccentColor(0xff0033);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `${icon("CINEMA_FILM")} **NexKord Cinema** — Showtimes`,
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Large),
  );

  if (shows.length > 0) {
    const visibleShows = shows.slice(0, 10);
    const list = visibleShows
      .map((s, i) => {
        const screen = screens.find((sc) => sc.id === s.screenId);
        const title = boundedText(s.title, 180, "Untitled");
        const titleLine = s.year
          ? `${title} (${boundedText(s.year, 4)})`
          : title;
        const screenName = boundedText(screen?.name, 60, "Screen");
        return (
          `**${i + 1}. ${titleLine}**\n` +
          `-# ${icon("CINEMA_CLOCK")} <t:${s.showtimeUnix}:f> · <t:${s.showtimeUnix}:R> · ${screenName}`
        );
      })
      .join("\n\n");
    const omitted = shows.length - visibleShows.length;
    const boardText =
      omitted > 0 ? `${list}\n\n-# +${omitted} more showtimes` : list;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(boundedText(boardText, 3900)),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# No showtimes scheduled yet — check back soon!",
      ),
    );
  }

  if (screens.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small),
    );
    for (let index = 0; index < Math.min(screens.length, 10); index += 5) {
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          ...screens.slice(index, index + 5).map((s) =>
            new ButtonBuilder()
              .setCustomId(`cinema:screen_join_${s.id}`)
              .setEmoji(emojiObj("CINEMA_SCREEN"))
              .setLabel(buttonLabel(`Join ${s.name}`))
              .setStyle(ButtonStyle.Secondary),
          ),
        ),
      );
    }
  }

  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );

  const ts = Math.floor(Date.now() / 1000);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# NexKord Cinema · updated <t:${ts}:R>`,
    ),
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
