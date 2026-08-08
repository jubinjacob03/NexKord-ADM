import fs from "fs";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOGS_DIR = path.join(__dirname, "..", "..", "logs");
const BOT_LOGS_DIR = path.join(LOGS_DIR, "bot");

[LOGS_DIR, BOT_LOGS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const COLORS = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
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
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

let auditStream = fs.createWriteStream(path.join(BOT_LOGS_DIR, "audit.log"), {
  flags: "a",
});

export const auditLog = (level, action, message) => {
  const formattedMessage = util.format(message);
  const upLevel = level.toUpperCase();

  const fileLine = `${fullTimestamp()} ${pad(upLevel, 5)} [${action}] ${formattedMessage}`;
  if (auditStream) auditStream.write(fileLine + "\n");

  const lColor = getLevelColor(level);
  const consoleLine = `${COLORS.gray}[${shortTime()}]${COLORS.reset} ${lColor}${pad(upLevel, 5)}${COLORS.reset} ${COLORS.magenta}[${action}]${COLORS.reset} ${formattedMessage}`;

  process.stdout.write(consoleLine + "\n");
};

export const initBotLogger = () => {
  if (global.__botLoggerReady) return;
  global.__botLoggerReady = true;

  const write = (level, args) => {
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

  console.log = (...args) => write("info", args);
  console.warn = (...args) => write("warn", args);
  console.error = (...args) => write("error", args);

  process.on("exit", () => {
    if (auditStream) auditStream.end();
  });
};
