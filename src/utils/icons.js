import { createRequire } from "module";

const require = createRequire(import.meta.url);
const iconMap = require("./icon-map.json");

const resolved = {};
const resolvedObjects = {};

for (const [key, entry] of Object.entries(iconMap)) {
  if (key.startsWith("_")) continue;
  if (entry.id) {
    const a = entry.animated ? "a" : "";
    resolved[key] = `<${a}:${entry.serverEmojiName}:${entry.id}>`;
    resolvedObjects[key] = {
      name: entry.serverEmojiName,
      id: entry.id,
      animated: entry.animated || false,
    };
  } else {
    resolved[key] = entry.fallback;
    resolvedObjects[key] = entry.fallback;
  }
}

export async function initIcons(client) {
  try {
    const appEmojis = await client.application.emojis.fetch();
    for (const [key, entry] of Object.entries(iconMap)) {
      if (key.startsWith("_")) continue;
      const emoji = appEmojis.find((e) => e.name === entry.serverEmojiName);
      if (emoji) {
        resolved[key] =
          `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
        resolvedObjects[key] = {
          name: emoji.name,
          id: emoji.id,
          animated: emoji.animated || false,
        };
      }
    }
    console.log(`[ICONS] Refreshed from ${appEmojis.size} app emojis`);
  } catch {
    console.log(`[ICONS] Using hardcoded IDs`);
  }

  const total = Object.keys(iconMap).filter((k) => !k.startsWith("_")).length;
  const loaded = Object.entries(resolved).filter(
    ([, v]) => typeof v === "string" && v.startsWith("<"),
  ).length;
  console.log(`[ICONS] ${loaded}/${total} custom icons ready`);
}

/**
 * Get an icon string by key.
 * Returns the resolved custom emoji if loaded, otherwise the unicode fallback.
 * @param {string} key - Icon key e.g. "SUCCESS", "ERROR", "TICKET"
 * @returns {string}
 */
export function icon(key) {
  if (resolved[key] !== undefined) return resolved[key];
  return iconMap[key]?.fallback ?? "";
}

/**
 * Get an emoji object for use in select menus and buttons
 * Returns {name, id} for custom emojis or the unicode string for fallbacks
 * @param {string} key - Icon key e.g. "SUCCESS", "ERROR", "TICKET"
 * @returns {{name: string, id: string, animated?: boolean} | string}
 */
export function emojiObj(key) {
  if (resolvedObjects[key] !== undefined) return resolvedObjects[key];
  return iconMap[key]?.fallback ?? "";
}
