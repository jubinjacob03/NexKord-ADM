import path from "path";
import { fileURLToPath } from "url";
import { AttachmentBuilder } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSET_DIR = path.join(__dirname, "..", "..", "..", "assets", "akinator");

/**
 * Named Akinator poses ("akitudes") mapped to their asset file names.
 * @type {Record<string, string>}
 */
const AKITUDE_FILES = {
  serene: "serene.png",
  confident: "confident.png",
  thinking: "thinking.png",
  focused: "focused.png",
  mindreading: "mindreading.png",
  stumped: "stumped.png",
  sleeping: "sleeping.png",
};

/**
 * Selects the question-time pose by how deep the game is: the genie grows more
 * intensely focused as it closes in on the answer.
 * @param {string|number|null} step The current question number.
 * @returns {string} An akitude name.
 */
export function questionAkitude(step) {
  const n = Number.parseInt(step, 10);
  if (Number.isNaN(n)) return "thinking";
  if (n >= 15) return "mindreading";
  if (n >= 8) return "focused";
  return "thinking";
}

/**
 * Builds the attachment and thumbnail reference for a named akitude, falling
 * back to the serene pose for unknown names.
 * @param {string} name An akitude name from {@link AKITUDE_FILES}.
 * @returns {{ attachment: AttachmentBuilder, url: string }}
 */
export function akitude(name) {
  const file = AKITUDE_FILES[name] || AKITUDE_FILES.serene;
  const attachment = new AttachmentBuilder(path.join(ASSET_DIR, file), {
    name: file,
  });
  return { attachment, url: `attachment://${file}` };
}
