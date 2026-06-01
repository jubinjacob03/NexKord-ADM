import fs from "fs/promises";
import path from "path";
import { PermissionsBitField } from "discord.js";
import { auditLog } from "../../utils/logger.js";
import { resolveDiscordId } from "./playerMap.js";

const VOICE_STATE_FILE = path.join(process.cwd(), "data", "au_voice_state.json");
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
 * Persists the applied-overwrites map to disk (crash-safe source of truth).
 */
async function persistApplied() {
  try {
    const obj = Object.fromEntries(applied);
    await fs.mkdir(path.dirname(VOICE_STATE_FILE), { recursive: true });
    await fs.writeFile(VOICE_STATE_FILE, JSON.stringify(obj, null, 2), "utf-8");
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
 * Applies a per-member push-to-talk deny (UseVAD) on the given VC.
 * No-op if the member is not currently connected to that VC. Idempotent.
 * @param {string} userId - Discord user ID
 * @param {string} vcId - Voice channel ID
 */
async function enforceUser(userId, vcId) {
  const channel = await fetchVoiceChannel(vcId);
  if (!channel) return;
  if (!channel.members.has(userId)) return;

  try {
    await channel.permissionOverwrites.edit(userId, { UseVAD: false });
    applied.set(userId, vcId);
    await persistApplied();
    auditLog("info", "VOICE_ENFORCE", `Push-to-talk enforced for ${userId} in ${vcId}`);
  } catch (error) {
    auditLog("error", "VOICE_ENFORCE", `Failed for ${userId}: ${error.message}`);
  }
}

/**
 * Removes the push-to-talk deny for a user, restoring free voice activity.
 * Idempotent: a missing overwrite is treated as success.
 * @param {string} userId - Discord user ID
 * @param {string} [vcIdOverride] - VC to clear (defaults to the recorded one)
 */
async function restoreUser(userId, vcIdOverride) {
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

  for (const userId of session.dead) {
    await restoreUser(userId, session.vcId);
  }
  auditLog("info", "VOICE_SESSION", `Ended session ${gameCode} (${reason}); restored ${session.dead.size} player(s)`);
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
  const gameCode = event.gameCode || "UNKNOWN";

  switch (event.type) {
    case "game_start": {
      if (!GAME_VC_ID) {
        auditLog("warn", "VOICE_MANAGER", "AMONGUS_GAME_VC_ID not set; voice enforcement disabled");
        return;
      }
      const existing = sessions.get(gameCode);
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => endSession(gameCode, "auto-expiry"), SESSION_MAX_MS);
      if (typeof timer.unref === "function") timer.unref();
      sessions.set(gameCode, { vcId: GAME_VC_ID, dead: new Set(), startedAt: Date.now(), timer });
      auditLog("info", "VOICE_SESSION", `Started session ${gameCode} bound to VC ${GAME_VC_ID}`);
      break;
    }

    case "kill":
    case "exile":
      if (event.playerName) await markDead(gameCode, event.playerName, event.type);
      break;

    case "leave": {
      const session = sessions.get(gameCode);
      if (session && event.playerName) {
        const userId = await resolveDiscordId(event.playerName);
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

  const deadSession = [...sessions.values()].find((s) => s.dead.has(userId));

  // Left or moved out of the game VC -> restore.
  if (applied.has(userId)) {
    const vcId = applied.get(userId);
    if (newState.channelId !== vcId) {
      await restoreUser(userId, vcId);
    }
  }

  // Rejoined the game VC while still dead in an active session -> re-apply.
  if (deadSession && newState.channelId === deadSession.vcId && !applied.has(userId)) {
    await enforceUser(userId, deadSession.vcId);
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
  for (const [userId, vcId] of entries) {
    await restoreUser(userId, vcId);
  }
  applied.clear();
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
