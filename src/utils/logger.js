import fs from "fs";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOGS_DIR = path.join(__dirname, "..", "..", "logs");
const MINECRAFT_LOGS_DIR = path.join(LOGS_DIR, "minecraft");
const BOT_LOGS_DIR = path.join(LOGS_DIR, "bot");

[LOGS_DIR, MINECRAFT_LOGS_DIR, BOT_LOGS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  bold: "\x1b[1m",
};

const getLevelColor = (level) => {
  switch (level.toLowerCase()) {
    case "info":
      return COLORS.cyan;
    case "warn":
      return COLORS.yellow;
    case "error":
      return COLORS.red;
    case "debug":
      return COLORS.gray;
    default:
      return COLORS.reset;
  }
};

const pad = (value, size) => String(value).padEnd(size, " ");
const fullTimestamp = () =>
  new Date().toISOString().replace("T", " ").replace("Z", "");
const shortTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

let auditStream = fs.createWriteStream(path.join(BOT_LOGS_DIR, "audit.log"), {
  flags: "a",
});

/**
 * Writes a structured entry to the bot audit log file and mirrors it to the colored standard output.
 *
 * @param {string} level - The severity level of the log entry (e.g., 'info', 'warn', 'error').
 * @param {string} action - The programmatic category or action identifier.
 * @param {string} message - The raw message content or format template.
 * @returns {void}
 */
export const auditLog = (level, action, message) => {
  const formattedMessage = util.format(message);
  const upLevel = level.toUpperCase();

  const fileLine = `${fullTimestamp()} ${pad(upLevel, 5)} [${action}] ${formattedMessage}`;
  if (auditStream) auditStream.write(fileLine + "\n");

  const lColor = getLevelColor(level);
  const consoleLine = `${COLORS.gray}[${shortTime()}]${COLORS.reset} ${lColor}${pad(upLevel, 5)}${COLORS.reset} ${COLORS.magenta}[${action}]${COLORS.reset} ${formattedMessage}`;

  process.stdout.write(consoleLine + "\n");
};

const MAX_LINES = 1500;
const ROTATION_HOURS = 12;
let mcStream = null;
let currentMcLogFile = null;
let currentMcLogLines = 0;
let currentMcLogStartTime = 0;

/**
 * Generates a timestamped file name for the Minecraft console log rotation.
 *
 * @returns {string} The fully qualified path to the new log file.
 */
const getNewMcLogFileName = () => {
  const dateStr = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .split(".")[0];
  return path.join(MINECRAFT_LOGS_DIR, `console_${dateStr}.txt`);
};

/**
 * Rotates the Minecraft console log file if it exceeds the maximum lines or maximum age duration.
 *
 * @returns {void}
 */
const rotateMcLogIfNeeded = () => {
  const timeSinceStart = Date.now() - currentMcLogStartTime;
  const isOverTime = timeSinceStart > ROTATION_HOURS * 60 * 60 * 1000;
  const isOverLines = currentMcLogLines >= MAX_LINES;

  if (!mcStream || isOverTime || isOverLines) {
    if (mcStream) {
      mcStream.end();
    }
    currentMcLogFile = getNewMcLogFileName();
    mcStream = fs.createWriteStream(currentMcLogFile, { flags: "a" });
    currentMcLogLines = 0;
    currentMcLogStartTime = Date.now();
    auditLog(
      "info",
      "LOG_ROTATE",
      `Rotated Minecraft log to ${path.basename(currentMcLogFile)}`,
    );
  }
};

/**
 * Logs clean, unformatted console output from the Minecraft server to a rotated text file.
 *
 * @param {string} cleanLogLine - The clean string representation of the console line.
 * @returns {void}
 */
export const logMinecraftConsole = (cleanLogLine) => {
  if (!cleanLogLine || cleanLogLine.trim() === "") return;
  rotateMcLogIfNeeded();

  const fileLine = cleanLogLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  if (mcStream) {
    mcStream.write(fileLine + "\n");
    currentMcLogLines++;
  }
};

/**
 * Initializes the global bot logger interceptor to mirror console calls to both stdout and standard logs.
 *
 * @returns {void}
 */
export const initBotLogger = () => {
  if (global.__botLoggerReady) return;
  global.__botLoggerReady = true;

  const write = (level, args, original) => {
    let message = util.format(...args);
    const upLevel = level.toUpperCase();

    let scope = "APP";
    const tagMatch = message.match(/^\[(.*?)\]\s+/);
    if (tagMatch) {
      scope = tagMatch[1];
      message = message.substring(tagMatch[0].length);
    }

    const fileLine = `${fullTimestamp()} ${pad(upLevel, 5)} [${scope}] ${message}`;
    if (auditStream) {
      auditStream.write(fileLine + "\n");
    }

    const lColor = getLevelColor(level);
    const consoleLine = `${COLORS.gray}[${shortTime()}]${COLORS.reset} ${lColor}${pad(upLevel, 5)}${COLORS.reset} ${COLORS.green}[${scope}]${COLORS.reset} ${message}`;

    process.stdout.write(consoleLine + "\n");
  };

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args) => write("info", args, originalLog);
  console.warn = (...args) => write("warn", args, originalWarn);
  console.error = (...args) => write("error", args, originalError);

  process.on("exit", () => {
    if (auditStream) auditStream.end();
    if (mcStream) mcStream.end();
  });
};
