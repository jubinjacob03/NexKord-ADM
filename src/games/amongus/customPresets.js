import fs from "fs/promises";
import path from "path";
import { auditLog } from "../../utils/logger.js";

const PRESETS_FILE = path.join(process.cwd(), "data", "au_presets.json");

/**
 * Validates preset data structure
 * @param {Object} preset - Preset data to validate
 * @returns {boolean} True if valid
 */
function validatePreset(preset) {
  if (!preset || typeof preset !== "object") return false;

  const requiredFields = ["impostors", "maxPlayers", "map", "killCooldown"];
  return requiredFields.every(
    (field) => preset.hasOwnProperty(field) && typeof preset[field] === "number"
  );
}

/**
 * Retrieves all saved custom presets
 * @returns {Promise<Object>} Dictionary of custom presets
 */
export async function getCustomPresets() {
  try {
    const data = await fs.readFile(PRESETS_FILE, "utf-8");
    const presets = JSON.parse(data);

    if (typeof presets !== "object" || Array.isArray(presets)) {
      auditLog("warn", "PRESETS", "Invalid presets file structure, returning empty object");
      return {};
    }

    const validPresets = {};
    for (const [key, value] of Object.entries(presets)) {
      if (validatePreset(value)) {
        validPresets[key] = value;
      } else {
        auditLog("warn", "PRESETS", `Skipping invalid preset: ${key}`);
      }
    }

    return validPresets;
  } catch (error) {
    if (error.code !== "ENOENT") {
      auditLog("error", "PRESETS", `Failed to read presets: ${error.message}`);
    }
    return {};
  }
}

/**
 * Saves a new custom preset
 * @param {string} name - The unique name of the preset
 * @param {Object} presetData - The preset configuration data
 * @returns {Promise<boolean>} True if saved successfully
 */
export async function saveCustomPreset(name, presetData) {
  if (!name || typeof name !== "string") {
    auditLog("error", "PRESETS", "Invalid preset name");
    return false;
  }

  if (!validatePreset(presetData)) {
    auditLog("error", "PRESETS", "Invalid preset data");
    return false;
  }

  try {
    const presets = await getCustomPresets();
    presets[name] = presetData;

    await fs.mkdir(path.dirname(PRESETS_FILE), { recursive: true });
    await fs.writeFile(PRESETS_FILE, JSON.stringify(presets, null, 2), "utf-8");

    auditLog("info", "PRESETS", `Saved preset: ${name}`);
    return true;
  } catch (error) {
    auditLog("error", "PRESETS", `Failed to save preset ${name}: ${error.message}`);
    return false;
  }
}

/**
 * Deletes a custom preset
 * @param {string} name - The unique name of the preset to delete
 * @returns {Promise<boolean>} True if deleted successfully
 */
export async function deleteCustomPreset(name) {
  if (!name || typeof name !== "string") {
    auditLog("error", "PRESETS", "Invalid preset name");
    return false;
  }

  try {
    const presets = await getCustomPresets();

    if (!presets[name]) {
      auditLog("warn", "PRESETS", `Preset not found: ${name}`);
      return false;
    }

    delete presets[name];

    await fs.writeFile(PRESETS_FILE, JSON.stringify(presets, null, 2), "utf-8");

    auditLog("info", "PRESETS", `Deleted preset: ${name}`);
    return true;
  } catch (error) {
    auditLog("error", "PRESETS", `Failed to delete preset ${name}: ${error.message}`);
    return false;
  }
}
