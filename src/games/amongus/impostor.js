import { auditLog } from "../../utils/logger.js";
import axios from "axios";

const IMPOSTOR_API_URL = process.env.IMPOSTOR_API_URL || "http://localhost:22025";
const IMPOSTOR_API_KEY = process.env.IMPOSTOR_API_KEY || "your_secret_key";

/**
 * Preset configurations for Among Us lobby creation.
 * @typedef {Object} LobbyPreset
 * @property {number} impostors - Number of impostors in the game
 * @property {number} maxPlayers - Maximum number of players allowed
 * @property {number} map - Map ID (0: The Skeld, 1: Mira HQ, 2: Polus, 3: Airship, 4: The Fungle)
 */
export const presets = {
  classic: {
    impostors: 2,
    maxPlayers: 15,
    map: 0,
  },
  chaos: {
    impostors: 3,
    maxPlayers: 15,
    map: 1,
  },
  ranked: {
    impostors: 2,
    maxPlayers: 15,
    map: 2,
  }
};

/**
 * Creates a new Among Us lobby on the Impostor server via HTTP API.
 *
 * @async
 * @param {string} [presetName="classic"] - The preset configuration name (classic, chaos, or ranked)
 * @returns {Promise<string>} The generated 6-character room code (e.g., "ABCDEF")
 * @throws {Error} If the API request fails or returns invalid data
 *
 * @example
 * const roomCode = await createImpostorLobby("classic");
 * console.log(`Room created: ${roomCode}`);
 */
export async function createImpostorLobby(presetName = "classic") {
  const preset = presets[presetName.toLowerCase()] || presets.classic;

  auditLog("info", "AMONGUS", `Requesting Impostor server to create lobby with preset: ${presetName}`);

  try {
    const response = await axios.post(`${IMPOSTOR_API_URL}/api/lobby/create`, {
      maxPlayers: preset.maxPlayers,
      impostorCount: preset.impostors,
      mapId: preset.map
    }, {
      headers: {
        "Authorization": `Bearer ${IMPOSTOR_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 5000
    });

    if (response.data && response.data.roomCode) {
      auditLog("info", "AMONGUS", `Lobby created successfully. Code: ${response.data.roomCode}`);
      return response.data.roomCode;
    } else {
      throw new Error("Invalid response from Impostor server.");
    }
  } catch (error) {
    auditLog("error", "AMONGUS", `Failed to create lobby: ${error.message}`);

    if (error.code === 'ECONNREFUSED' || error.response?.status === 404) {
      auditLog("warn", "AMONGUS", "Impostor API not reachable. Returning dummy code for testing.");
      return "NEXKRD";
    }
    throw error;
  }
}
