// Small caps: q, s, x have no widely supported form—kept lowercase.
const SMALL_CAPS = {
  a: "ᴀ",
  b: "ʙ",
  c: "ᴄ",
  d: "ᴅ",
  e: "ᴇ",
  f: "ꜰ",
  g: "ɢ",
  h: "ʜ",
  i: "ɪ",
  j: "ᴊ",
  k: "ᴋ",
  l: "ʟ",
  m: "ᴍ",
  n: "ɴ",
  o: "ᴏ",
  p: "ᴘ",
  q: "q",
  r: "ʀ",
  s: "s",
  t: "ᴛ",
  u: "ᴜ",
  v: "ᴠ",
  w: "ᴡ",
  x: "x",
  y: "ʏ",
  z: "ᴢ",
};

export function smallCaps(text) {
  return String(text)
    .toLowerCase()
    .replace(/[a-z]/g, (letter) => SMALL_CAPS[letter] ?? letter);
}

export function heading(text, emoji = "") {
  return `## ${emoji ? `${emoji} ` : ""}${smallCaps(text)}`;
}

export function label(text) {
  return `**${smallCaps(text)}**`;
}

export function subtext(...parts) {
  const body = parts.filter(Boolean).join(" · ");
  return body ? `-# ${body}` : "";
}

export function stack(...blocks) {
  return blocks
    .flat()
    .filter((b) => b != null && String(b).trim() !== "")
    .join("\n\n")
    .replace(/[ \t]+$/gm, "");
}

export function lines(...items) {
  return items
    .flat()
    .filter((i) => i != null && i !== "")
    .join("\n");
}

export function progressBar(fraction, width = 20) {
  const clamped = Math.max(
    0,
    Math.min(1, Number.isFinite(fraction) ? fraction : 0),
  );
  const filled = Math.round(clamped * width);
  return `\`${"█".repeat(filled)}${"░".repeat(width - filled)}\` ${Math.round(clamped * 100)}%`;
}

export function gigabytes(bytes) {
  if (!bytes || bytes <= 0) return null;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function minutes(seconds) {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}

export function resolution(width, height) {
  return width && height ? `${width}×${height}` : null;
}

export function title(name, year) {
  return year ? `**${name}** · ${year}` : `**${name}**`;
}

export function channelMention(channelId) {
  return channelId ? `<#${channelId}>` : null;
}

export function relativeTime(unixSeconds) {
  return `<t:${unixSeconds}:R>`;
}

export function fullTime(unixSeconds) {
  return `<t:${unixSeconds}:F>`;
}
