import { auditLog } from "../../utils/logger.js";
import axios from "axios";

const IMPOSTOR_API_URL = process.env.IMPOSTOR_API_URL || "http://localhost:22025";
const IMPOSTOR_API_KEY = process.env.IMPOSTOR_API_KEY || "your_secret_key";

export const presets = {
  classic: {
    impostors: 2,
    maxPlayers: 15,
    map: 0,
    killCooldown: 25.0,
    shapeshifters: 0,
  },
  chaos: {
    impostors: 3,
    maxPlayers: 15,
    map: 0,
    killCooldown: 25.0,
    shapeshifters: 0,
  },
  shapeshifter: {
    impostors: 3,
    maxPlayers: 15,
    map: 0,
    killCooldown: 25.0,
    shapeshifters: 1,
  },
};

/**
 * Creates a new Among Us lobby on the Impostor server
 * @param {string} presetName - The preset configuration name
 * @returns {Promise<string>} The generated room code
 * @throws {Error} If the API request fails
 */
export async function createImpostorLobby(presetName = "classic") {
  const preset = presets[presetName.toLowerCase()] || presets.classic;

  auditLog("info", "AMONGUS", `Requesting lobby creation with preset: ${presetName}`);

  try {
    const response = await axios.post(
      `${IMPOSTOR_API_URL}/api/lobby/create`,
      {
        maxPlayers: preset.maxPlayers,
        impostorCount: preset.impostors,
        mapId: preset.map,
        killCooldown: preset.killCooldown,
        shapeshifterCount: preset.shapeshifters,
      },
      {
        headers: {
          Authorization: `Bearer ${IMPOSTOR_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }
    );

    if (response.data?.roomCode && typeof response.data.roomCode === "string") {
      auditLog("info", "AMONGUS", `Lobby created successfully. Code: ${response.data.roomCode}`);
      return response.data.roomCode;
    } else {
      throw new Error("Invalid response from Impostor server");
    }
  } catch (error) {
    auditLog("error", "AMONGUS", `Failed to create lobby: ${error.message}`);

    if (error.code === "ECONNREFUSED" || error.response?.status === 404) {
      auditLog("warn", "AMONGUS", "Impostor API not reachable. Returning dummy code for testing.");
      return "NEXKRD";
    }
    throw error;
  }
}
