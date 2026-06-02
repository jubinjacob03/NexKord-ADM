import fs from "fs/promises";
import path from "path";
import { auditLog } from "../../utils/logger.js";
import { resolveDiscordId } from "./playerMap.js";

const VOICE_STATE_FILE = path.join(process.cwd(), "data", "au_voice_state.json");
const VOICE_STATE_TMP = `${VOICE_STATE_FILE}.tmp`;
const GAME_VC_ID = process.env.AMONGUS_GAME_VC_ID;
const SESSION_MAX_MS = 60 * 60 * 1000;

let client = null;

/**
 * Active game sessions keyed by lobby code.
 * @type {Map<string, {vcId: string, dead: Set<string>, startedAt: number, timer: NodeJS.Timeout}>}
 */
const sessions = new Map();

/**
 * Persisted record of currently-applied UseVAD denies: userId -> vcId.
 * Mirrored to disk so a crash/restart can always undo them.
 * @type {Map<string, string>}
 */
const applied = new Map();

/**
 * Per-user serialization queue. Guarantees enforce/restore for one user never
 * interleave (e.g. a kill event racing a voice-move event).
 * @type {Map<string, Promise<void>>}
 */
const userLocks = new Map();

/**
 * Runs a task with exclusive access per user, serializing concurrent calls so
 * enforce/restore for one user never interleave. Cleans up the lock entry once
 * the queue drains to avoid unbounded growth.
 * @param {string} userId
 * @param {() => Promise<void>} task
 * @returns {Promise<void>}
 */
function withUserLock(userId, task) {
  const prev = userLocks.get(userId) || Promise.resolve();
  const run = prev.then(task, task);
  const chain = run.catch(() => {});
  userLocks.set(userId, chain);
  chain.then(() => {
    if (userLocks.get(userId) === chain) {
      userLocks.delete(userId);
    }
  });
  return run;
}

/**
 * Confirms a VC id matches the single configured game VC (defense-in-depth so a
 * stale persisted entry can never touch an arbitrary channel).
 * @param {string} vcId
 * @returns {boolean}
 */
function isConfiguredVc(vcId) {
  return Boolean(GAME_VC_ID) && vcId === GAME_VC_ID;
}

/**
 * Atomically persists the applied-overwrites map to disk (temp file + rename).
 */
async function persistApplied() {
  try {
    const obj = Object.fromEntries(applied);
    await fs.mkdir(path.dirname(VOICE_STATE_FILE), { recursive: true });
    await fs.writeFile(VOICE_STATE_TMP, JSON.stringify(obj, null, 2), "utf-8");
    await fs.rename(VOICE_STATE_TMP, VOICE_STATE_FILE);
  } catch (error) {
    auditLog("error", "VOICE_STATE", `Failed to persist voice state: ${error.message}`);
  }
}

/**
 * Reads the persisted applied-overwrites map from disk.
 * @returns {Promise<Object<string, string>>}
 */
async function readPersisted() {
  try {
    const data = await fs.readFile(VOICE_STATE_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code !== "ENOENT") {
      auditLog("error", "VOICE_STATE", `Failed to read voice state: ${error.message}`);
    }
    return {};
  }
}

/**
 * Fetches the configured game voice channel, or null if misconfigured/unavailable.
 * @param {string} vcId - Voice channel ID
 * @returns {Promise<import('discord.js').VoiceChannel|null>}
 */
async function fetchVoiceChannel(vcId) {
  if (!client || !vcId) return null;
  try {
    const channel = await client.channels.fetch(vcId);
    return channel?.isVoiceBased() ? channel : null;
  } catch (error) {
    auditLog("error", "VOICE_MANAGER", `Cannot fetch VC ${vcId}: ${error.message}`);
    return null;
  }
}

/**
 * Applies a per-member push-to-talk deny (UseVAD) on the configured VC.
 * No-op if the member is not connected to that VC. Serialized per user, idempotent.
 * @param {string} userId - Discord user ID
 * @param {string} vcId - Voice channel ID
 */
async function enforceUser(userId, vcId) {
  if (!isConfiguredVc(vcId)) return;
  return withUserLock(userId, async () => {
    if (applied.get(userId) === vcId) return;
    const channel = await fetchVoiceChannel(vcId);
    if (!channel || !channel.members.has(userId)) return;

    try {
      await channel.permissionOverwrites.edit(userId, { UseVAD: false });
      applied.set(userId, vcId);
      await persistApplied();
      auditLog("info", "VOICE_ENFORCE", `Push-to-talk enforced for ${userId} in ${vcId}`);
    } catch (error) {
      auditLog("error", "VOICE_ENFORCE", `Failed for ${userId}: ${error.message}`);
    }
  });
}

/**
 * Removes the push-to-talk deny for a user, restoring free voice activity.
 * Serialized per user. Idempotent: a missing overwrite is treated as success.
 * @param {string} userId - Discord user ID
 * @param {string} [vcIdOverride] - VC to clear (defaults to the recorded one)
 */
async function restoreUser(userId, vcIdOverride) {
  return withUserLock(userId, async () => {
    const vcId = vcIdOverride || applied.get(userId);
    if (vcId) {
      const channel = await fetchVoiceChannel(vcId);
      if (channel) {
        try {
          await channel.permissionOverwrites.delete(userId);
          auditLog("info", "VOICE_RESTORE", `Push-to-talk restored for ${userId} in ${vcId}`);
        } catch (error) {
          auditLog("warn", "VOICE_RESTORE", `Delete overwrite failed for ${userId}: ${error.message}`);
        }
      }
    }
    if (applied.delete(userId)) {
      await persistApplied();
    }
  });
}

/**
 * Ends a session and restores every player it touched. Master safety path.
 * @param {string} gameCode - Lobby code
 * @param {string} reason - Why the session ended (for logs)
 */
async function endSession(gameCode, reason) {
  const session = sessions.get(gameCode);
  if (!session) return;

  clearTimeout(session.timer);
  sessions.delete(gameCode);

  let restored = 0;
  for (const userId of session.dead) {
    await restoreUser(userId, session.vcId);
    restored++;
  }
  auditLog("info", "VOICE_SESSION", `Ended session ${gameCode} (${reason}); restored ${restored} player(s)`);
}

/**
 * Marks an in-game player dead and enforces PTT if they are in the game VC.
 * @param {string} gameCode - Lobby code
 * @param {string} playerName - In-game player name
 * @param {string} cause - "kill" or "exile" (for logs)
 */
async function markDead(gameCode, playerName, cause) {
  const session = sessions.get(gameCode);
  if (!session) return;

  const userId = await resolveDiscordId(playerName);
  if (!userId) {
    auditLog("warn", "VOICE_MANAGER", `No mapping for in-game name '${playerName}' (${cause})`);
    return;
  }

  session.dead.add(userId);
  await enforceUser(userId, session.vcId);
}

/**
 * Dispatches a game event pushed from the Impostor plugin.
 * @param {{type: string, gameCode: string, playerName?: string}} event
 */
export async function handleGameEvent(event) {
  if (!event || typeof event.type !== "string") return;
  const gameCode = typeof event.gameCode === "string" && event.gameCode ? event.gameCode : "UNKNOWN";
  const playerName = typeof event.playerName === "string" ? event.playerName : null;

  switch (event.type) {
    case "game_start": {
      if (!GAME_VC_ID) {
        auditLog("warn", "VOICE_MANAGER", "AMONGUS_GAME_VC_ID not set; voice enforcement disabled");
        return;
      }
      // If this code was already active, fully restore it before re-opening so a
      // re-used lobby code can never strand a previously-enforced player.
      await endSession(gameCode, "restart");
      const timer = setTimeout(() => {
        endSession(gameCode, "auto-expiry").catch(() => {});
      }, SESSION_MAX_MS);
      if (typeof timer.unref === "function") timer.unref();
      sessions.set(gameCode, { vcId: GAME_VC_ID, dead: new Set(), startedAt: Date.now(), timer });
      auditLog("info", "VOICE_SESSION", `Started session ${gameCode} bound to VC ${GAME_VC_ID}`);
      break;
    }

    case "kill":
    case "exile":
      if (playerName) await markDead(gameCode, playerName, event.type);
      break;

    case "leave": {
      const session = sessions.get(gameCode);
      if (session && playerName) {
        const userId = await resolveDiscordId(playerName);
        if (userId && session.dead.delete(userId)) {
          await restoreUser(userId, session.vcId);
        }
      }
      break;
    }

    case "game_end":
      await endSession(gameCode, "game_end");
      break;

    default:
      auditLog("warn", "VOICE_MANAGER", `Unknown event type: ${event.type}`);
  }
}

/**
 * Reacts to voice movement so PTT applies only while a dead user is in the game VC.
 * @param {import('discord.js').VoiceState} oldState
 * @param {import('discord.js').VoiceState} newState
 */
export async function handleVoiceStateUpdate(oldState, newState) {
  const userId = newState.id;

  // Left or moved out of the VC we enforced on -> restore.
  const enforcedVc = applied.get(userId);
  if (enforcedVc && newState.channelId !== enforcedVc) {
    await restoreUser(userId, enforcedVc);
  }

  // Rejoined the game VC while still dead in an active session -> re-apply.
  if (newState.channelId && newState.channelId === GAME_VC_ID && !applied.has(userId)) {
    const deadSession = [...sessions.values()].find(
      (s) => s.vcId === newState.channelId && s.dead.has(userId),
    );
    if (deadSession) {
      await enforceUser(userId, deadSession.vcId);
    }
  }
}

/**
 * Startup self-heal: undo any overwrites left applied before a crash/restart.
 * Guarantees no user is stranded in push-to-talk.
 */
export async function reconcile() {
  const persisted = await readPersisted();
  const entries = Object.entries(persisted);
  if (entries.length === 0) return;

  auditLog("info", "VOICE_RECONCILE", `Reconciling ${entries.length} stale overwrite(s) from previous run`);
  // Seed the in-memory map so restoreUser can locate and clear each entry.
  for (const [userId, vcId] of entries) {
    applied.set(userId, vcId);
  }
  for (const [userId, vcId] of entries) {
    await restoreUser(userId, vcId);
  }
  await persistApplied();
}

/**
 * Initializes the voice manager and runs startup reconciliation.
 * @param {import('discord.js').Client} discordClient
 */
export async function initVoiceManager(discordClient) {
  client = discordClient;
  if (!GAME_VC_ID) {
    auditLog("warn", "VOICE_MANAGER", "AMONGUS_GAME_VC_ID not configured; dead-player PTT disabled");
  }
  await reconcile();
  auditLog("info", "VOICE_MANAGER", "Voice manager initialized");
}

