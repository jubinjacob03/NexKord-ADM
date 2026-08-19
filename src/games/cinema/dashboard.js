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

export const BTN = {
  SEARCH: "cinema:search",
  SCHEDULE: "cinema:schedule",
  DOWNLOAD: "cinema:download",
  CANCEL: "cinema:cancel",
  ADD_MOVIE: "cinema:add_movie",
  LIBRARY: "cinema:library",
  REFRESH: "cinema:refresh",
};

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
            .setLabel(s.name)
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
        return `**${i + 1}.** ${s.title} — ${formatAmPm(s.showtimeUnix)} · ${screen?.name || "?"}`;
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
  for (let i = 0; i < Math.min(results.length, 5); i++) {
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
      `-# Pick a result to schedule · <t:${ts}:f>`,
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
  voiceChannelId,
}) {
  const container = new ContainerBuilder().setAccentColor(0xff0033);

  const titleLine = year ? `**${title}** (${year})` : `**${title}**`;
  const sectionText = overview
    ? `${icon("CINEMA_FILM")} ${titleLine}\n\n${overview}`
    : `${icon("CINEMA_FILM")} ${titleLine}`;

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

  const vcLabel = voiceChannelId ? "Lobby" : "TBA";
  const infoRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cinema:poster_screen_${Date.now()}`)
      .setEmoji(emojiObj("CINEMA_SCREEN"))
      .setLabel(screenName || "Screen")
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

function qualityRank(q) {
  const map = { "4k": 4, "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 };
  return map[q?.toLowerCase()] || 0;
}

export function buildMovieCard(movie) {
  const container = new ContainerBuilder().setAccentColor(0xff0033);

  const titleLine = movie.year
    ? `**${movie.title}** (${movie.year})`
    : `**${movie.title}**`;
  const sectionText = movie.overview
    ? `${icon("CINEMA_FILM")} ${titleLine}\n\n${movie.overview}`
    : `${icon("CINEMA_FILM")} ${titleLine}`;

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
    const variantLines = movie.variants
      .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
      .map((v) => {
        const statusIcon =
          v.status === "offline"
            ? "🟢"
            : v.status === "downloaded"
              ? "🟡"
              : v.status === "downloading"
                ? "🔵"
                : "⚫";
        return `${statusIcon} **${v.quality}** · ${v.source} · ${v.status}`;
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

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cinema:card_upload_${movie.id}`)
      .setEmoji(emojiObj("CINEMA_TICKET"))
      .setLabel("Upload Link")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cinema:card_download_${movie.id}`)
      .setEmoji(emojiObj("CINEMA_CLAPPER"))
      .setLabel("Download")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cinema:card_schedule_${movie.id}`)
      .setEmoji(emojiObj("CINEMA_CALENDAR"))
      .setLabel("Schedule")
      .setStyle(ButtonStyle.Secondary),
  );
  container.addActionRowComponents(row);

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
