import fs from "fs/promises";
import path from "path";
import { auditLog } from "../../utils/logger.js";

const PLAYER_MAP_FILE = path.join(process.cwd(), "data", "au_player_map.json");

/**
 * Normalizes an in-game name to use as a lookup key.
 * @param {string} name - Raw in-game player name
 * @returns {string} Lowercased, trimmed key
 */
function normalizeName(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/**
 * Reads the in-game name -> Discord user mapping.
 * @returns {Promise<Object<string, {name: string, userId: string}>>}
 */
export async function getPlayerMap() {
  try {
    const data = await fs.readFile(PLAYER_MAP_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
      return {};
    }
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") {
      auditLog("error", "PLAYER_MAP", `Failed to read player map: ${error.message}`);
    }
    return {};
  }
}

/**
 * Resolves an in-game player name to a Discord user ID.
 * @param {string} inGameName - The in-game player name
 * @returns {Promise<string|null>} Discord user ID or null if unmapped
 */
export async function resolveDiscordId(inGameName) {
  const key = normalizeName(inGameName);
  if (!key) return null;
  const map = await getPlayerMap();
  return map[key]?.userId ?? null;
}

/**
 * Adds or updates a mapping from an in-game name to a Discord user.
 * @param {string} inGameName - The in-game player name (display case preserved)
 * @param {string} userId - The Discord user ID
 * @returns {Promise<boolean>} True if saved
 */
export async function setMapping(inGameName, userId) {
  const key = normalizeName(inGameName);
  if (!key || !userId) {
    auditLog("error", "PLAYER_MAP", "Invalid mapping arguments");
    return false;
  }

  try {
    const map = await getPlayerMap();
    map[key] = { name: inGameName.trim(), userId };
    await fs.mkdir(path.dirname(PLAYER_MAP_FILE), { recursive: true });
    await fs.writeFile(PLAYER_MAP_FILE, JSON.stringify(map, null, 2), "utf-8");
    auditLog("info", "PLAYER_MAP", `Mapped '${inGameName.trim()}' -> ${userId}`);
    return true;
  } catch (error) {
    auditLog("error", "PLAYER_MAP", `Failed to save mapping: ${error.message}`);
    return false;
  }
}

/**
 * Removes a mapping by in-game name.
 * @param {string} inGameName - The in-game player name
 * @returns {Promise<boolean>} True if a mapping existed and was removed
 */
export async function removeMapping(inGameName) {
  const key = normalizeName(inGameName);
  if (!key) return false;

  try {
    const map = await getPlayerMap();
    if (!map[key]) return false;
    delete map[key];
    await fs.writeFile(PLAYER_MAP_FILE, JSON.stringify(map, null, 2), "utf-8");
    auditLog("info", "PLAYER_MAP", `Removed mapping for '${inGameName.trim()}'`);
    return true;
  } catch (error) {
    auditLog("error", "PLAYER_MAP", `Failed to remove mapping: ${error.message}`);
    return false;
  }
}
