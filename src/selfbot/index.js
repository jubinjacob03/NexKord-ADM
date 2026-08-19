import fs from "fs";
import path from "path";
import { Client } from "discord.js-selfbot-v13";
import { handleCommand } from "./commands.js";
import { config } from "./config.js";
import { PanelManager } from "./panelManager.js";
import { TheaterScheduler } from "./scheduler.js";
import { MovieStreamer } from "./streamer.js";

const dataDir = path.join(process.cwd(), "data");
const lockFile = path.join(dataDir, "instance.lock");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function readLock() {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return Number.isInteger(parsed.pid) ? parsed : null;
  } catch {
    return null;
  }
}

function acquireInstanceLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  const existing = readLock();
  if (
    existing &&
    existing.pid !== process.pid &&
    isProcessAlive(existing.pid)
  ) {
    if (process.env.ALLOW_MULTIPLE_INSTANCES === "true") {
      console.warn(
        `[LOCK] Another instance is running (pid ${existing.pid}). Continuing because ALLOW_MULTIPLE_INSTANCES=true.`,
      );
    } else {
      throw new Error(
        `Another NexKord instance is already running (pid ${existing.pid}, started ${existing.startedAt}).\n` +
          `Stop it first, or delete ${lockFile} if that process is gone.`,
      );
    }
  }
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );
}

function releaseInstanceLock() {
  if (readLock()?.pid === process.pid) fs.rmSync(lockFile, { force: true });
}

async function validateToken() {
  if (!config.token) {
    throw new Error(
      "DISCORD_TOKEN is missing in .env! Run `npm run token:grab` to capture your token.",
    );
  }
  try {
    const res = await fetch("https://discord.com/api/v9/users/@me", {
      headers: { Authorization: config.token },
    });
    if (res.status !== 200) throw new Error();
  } catch {
    throw new Error(
      "DISCORD_TOKEN in .env is invalid or expired! Run `npm run token:grab` to capture an active user token.",
    );
  }
  return config.token;
}

acquireInstanceLock();

const token = await validateToken();

const client = new Client({ checkUpdate: false });
const streamer = new MovieStreamer(client);
const scheduler = new TheaterScheduler();
const panelManager = new PanelManager(client, streamer, scheduler);

let shuttingDown = false;

client.on("ready", async () => {
  console.log(`[READY] Logged in as ${client.user.tag} (pid ${process.pid}).`);

  scheduler.startTimerLoop(streamer, async (show, source) => {
    console.log(
      `[SHOWTIME] Starting "${show.title}" via ${source.serverName}.`,
    );
  });
});

client.on("messageCreate", (message) => {
  handleCommand(message, streamer, scheduler, panelManager).catch((err) => {
    console.error(`[COMMAND] Unhandled failure: ${err.message}`);
  });
});

client.on("error", (error) => {
  console.error(`[CLIENT] ${error.message}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] Unhandled rejection:", reason);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] Received ${signal}. Cleaning up…`);

  scheduler.stopTimerLoop();
  await streamer.dispose().catch(() => {});
  client.destroy();
  releaseInstanceLock();

  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal).catch(() => process.exit(1));
  });
}

process.on("exit", releaseInstanceLock);

await client.login(token);
