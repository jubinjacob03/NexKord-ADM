import iconMap from "./icon-map.json" with { type: "json" };

/**
 * Resolved custom emoji strings, populated by initIcons().
 * Falls back to unicode if the server emoji isn't found.
 * @type {Record<string, string>}
 */
const resolved = {};

/**
 * Resolved custom emoji objects for use in select menus/buttons
 * @type {Record<string, {name: string, id: string} | string>}
 */
const resolvedObjects = {};

/**
 * Call once in the ready event after the client is logged in.
 * Walks all guilds the bot is in and resolves every icon-map entry
 * to a Discord custom emoji string (e.g. <:si_success:1234567890>).
 * @param {import('discord.js').Client} client
 */
export function initIcons(client) {
  const emojiByName = new Map();
  for (const guild of client.guilds.cache.values()) {
    for (const emoji of guild.emojis.cache.values()) {
      if (emoji.name) emojiByName.set(emoji.name, emoji);
    }
  }

  let loaded = 0;
  for (const [key, entry] of Object.entries(iconMap)) {
    if (key.startsWith("_")) continue;
    const emoji = emojiByName.get(entry.serverEmojiName);
    if (emoji) {
      resolved[key] =
        `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
      resolvedObjects[key] = {
        name: emoji.name,
        id: emoji.id,
        animated: emoji.animated || false
      };
      loaded++;
    } else {
      resolved[key] = entry.fallback;
      resolvedObjects[key] = entry.fallback;
    }
  }

  const total = Object.keys(iconMap).filter((k) => !k.startsWith("_")).length;
  console.log(
    `[ICONS] Loaded ${loaded}/${total} custom icons (${total - loaded} using unicode fallback)`,
  );
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

/**
 * Convenience: icon(key) + " " — handy for embed titles.
 * e.g.  `${i("SUCCESS")}Done` → "✅ Done"
 * @param {string} key
 * @returns {string}
 */
export const i = (key) => `${icon(key)} `;
