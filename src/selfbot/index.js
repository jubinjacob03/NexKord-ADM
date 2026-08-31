import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "discord.js-selfbot-v13";
import { handleCommand } from "./commands.js";
import { config } from "./config.js";
import { PanelManager } from "./panelManager.js";
import { TheaterScheduler } from "./scheduler.js";
import { MovieStreamer } from "./streamer.js";
import { clearStaleMediaSpools } from "./progressiveMedia.js";
import { initBotLogger } from "../utils/logger.js";

initBotLogger();

const dataDir = path.join(process.cwd(), "data");
const lockFile = path.join(dataDir, "instance.lock");

let ownedLock = null;
let client = null;
let streamer = null;
let scheduler = null;
let idleVoiceTimer = null;
let idleVoiceRunning = false;
let idleVoicePending = false;
let idleVoiceStarted = false;
let shutdownPromise = null;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLock() {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function acquireInstanceLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (process.env.ALLOW_MULTIPLE_INSTANCES === "true") {
    console.warn("[LOCK] Single-instance protection is disabled.");
    return;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = {
      pid: process.pid,
      nonce: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
    };
    try {
      const descriptor = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(record), "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      ownedLock = record;
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readLock();
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(
          `Another NexKord selfbot instance is running with pid ${existing.pid}.`,
        );
      }
      const current = readLock();
      if (
        (!existing && !current) ||
        (existing &&
          current?.pid === existing.pid &&
          current?.nonce === existing.nonce)
      ) {
        fs.rmSync(lockFile, { force: true });
      }
    }
  }
  throw new Error("Could not acquire the selfbot instance lock.");
}

function releaseInstanceLock() {
  if (!ownedLock) return;
  const current = readLock();
  if (current?.pid === ownedLock.pid && current?.nonce === ownedLock.nonce) {
    fs.rmSync(lockFile, { force: true });
  }
  ownedLock = null;
}

function validateRequiredConfiguration() {
  const missing = [];
  if (!config.defaultGuildId) missing.push("SELFBOT_GUILD_ID");
  if (!config.defaultChannelId) missing.push("SELFBOT_CHANNEL_ID");
  if (!config.defaultVoiceChannelId) missing.push("SELFBOT_VOICE_CHANNEL_ID");
  if (!config.controllerId) missing.push("SELFBOT_CONTROLLER_ID or CLIENT_ID");
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}.`);
  }
}

async function validateToken() {
  if (!config.token) {
    throw new Error(
      "SELFBOT_TOKEN is missing in .env. Run `npm run token:grab` to capture it.",
    );
  }

  let response;
  try {
    response = await fetch("https://discord.com/api/v9/users/@me", {
      headers: { Authorization: config.token },
      signal: AbortSignal.timeout(config.tokenValidationTimeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error("Discord token validation timed out.");
    }
    throw new Error(
      `Discord token validation could not connect: ${error.message}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "SELFBOT_TOKEN is invalid or expired. Run `npm run token:grab` again.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Discord token validation failed with HTTP ${response.status}.`,
    );
  }
  return config.token;
}

async function holdIdleVoice() {
  if (!config.stayInVoice || !streamer) return;
  try {
    await streamer.join(config.defaultGuildId, config.defaultVoiceChannelId);
    console.log(
      `[IDLE VC] Holding configured voice channel ${config.defaultVoiceChannelId}.`,
    );
  } catch (error) {
    console.warn(`[IDLE VC] Voice hold failed: ${error.message}`);
  }
}

function scheduleIdleVoice(delayMs) {
  if (!idleVoiceStarted || shutdownPromise) return;
  if (idleVoiceTimer) clearTimeout(idleVoiceTimer);
  idleVoiceTimer = setTimeout(() => {
    idleVoiceTimer = null;
    void runIdleVoiceCheck();
  }, delayMs);
  idleVoiceTimer.unref?.();
}

async function runIdleVoiceCheck() {
  if (idleVoiceRunning) {
    idleVoicePending = true;
    return;
  }
  idleVoiceRunning = true;
  try {
    await holdIdleVoice();
  } finally {
    idleVoiceRunning = false;
    const delay = idleVoicePending ? 0 : config.voiceKeepAliveMs;
    idleVoicePending = false;
    scheduleIdleVoice(delay);
  }
}

function startIdleVoiceLoop() {
  if (!config.stayInVoice || idleVoiceStarted) return;
  idleVoiceStarted = true;
  scheduleIdleVoice(0);
}

function requestImmediateVoiceCheck() {
  if (!idleVoiceStarted) return;
  if (idleVoiceRunning) {
    idleVoicePending = true;
    return;
  }
  scheduleIdleVoice(0);
}

async function shutdown(reason, exitCode = 0) {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      console.log(`[SHUTDOWN] ${reason}. Cleaning up…`);
      idleVoiceStarted = false;
      if (idleVoiceTimer) {
        clearTimeout(idleVoiceTimer);
        idleVoiceTimer = null;
      }
      scheduler?.stopTimerLoop();
      if (streamer) {
        try {
          await streamer.dispose();
        } catch (error) {
          console.warn(`[SHUTDOWN] Stream cleanup failed: ${error.message}`);
        }
      }
      client?.destroy();
      releaseInstanceLock();
    })();
  }
  await shutdownPromise;
  process.exit(exitCode);
}

acquireInstanceLock();
const removedSpools = await clearStaleMediaSpools();
if (removedSpools > 0) {
  console.log(
    `[STREAM] Removed ${removedSpools} stale media spool file${removedSpools === 1 ? "" : "s"}.`,
  );
}
process.on("exit", releaseInstanceLock);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(`Received ${signal}`, 0));
}
process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] Unhandled rejection:", reason);
  void shutdown("Unhandled rejection", 1);
});
process.on("uncaughtException", (error) => {
  console.error("[PROCESS] Uncaught exception:", error);
  void shutdown("Uncaught exception", 1);
});

try {
  validateRequiredConfiguration();
  const token = await validateToken();

  client = new Client({ checkUpdate: false });
  streamer = new MovieStreamer(client);
  scheduler = new TheaterScheduler();
  const panelManager = new PanelManager(client, streamer, scheduler);
  let readyInitialized = false;

  client.on("ready", () => {
    if (readyInitialized) return;
    readyInitialized = true;
    console.log(
      `[READY] Logged in as ${client.user.tag} (pid ${process.pid}).`,
    );
    scheduler.startTimerLoop(streamer, async (show, source) => {
      console.log(
        `[SHOWTIME] Starting "${show.title}" via ${source.serverName}.`,
      );
    });
    startIdleVoiceLoop();
  });

  client.on("voiceStateUpdate", (_oldState, newState) => {
    if (newState.id !== client.user?.id) return;
    if (newState.channelId !== config.defaultVoiceChannelId) {
      requestImmediateVoiceCheck();
    }
  });

  client.on("messageCreate", (message) => {
    handleCommand(message, streamer, scheduler, panelManager).catch((error) => {
      console.error(`[COMMAND] Unhandled failure: ${error.message}`);
    });
  });

  client.on("error", (error) => {
    console.error(`[CLIENT] ${error.message}`);
  });

  await client.login(token);
} catch (error) {
  console.error(`[STARTUP] ${error.message}`);
  await shutdown("Startup failed", 1);
}
