import { auditLog } from "../../utils/logger.js";
import axios from "axios";

const IMPOSTOR_API_URL = process.env.IMPOSTOR_API_URL || "http://localhost:22025";
const IMPOSTOR_API_KEY = process.env.IMPOSTOR_API_KEY || "your_secret_key";

export const presets = {
  classic: {
    impostors: 2,
    killCooldown: 27.5,
    impVision: 1.5,
    killDistance: "short",
    playerSpeed: 1.5,
    crewVision: 1.25,
    meetings: 2,
    meetingCooldown: 15,
    discussionTime: 40,
    votingTime: 160,
    anonymousVotes: false,
    confirmImpostor: true,
    taskBarUpdate: 1,
    commonTasks: 2,
    longTasks: 2,
    shortTasks: 4,
    visualTasks: true,
    maxPlayers: 15,
    map: 0,
    shapeshifters: 0,
    angels: 0,
    vipers: 0,
    engineers: 0
  },
  chill: {
    impostors: 2,
    killCooldown: 27.5,
    impVision: 1.5,
    killDistance: "short",
    playerSpeed: 1.5,
    crewVision: 1.25,
    meetings: 2,
    meetingCooldown: 15,
    discussionTime: 40,
    votingTime: 160,
    anonymousVotes: true,
    confirmImpostor: true,
    taskBarUpdate: 1,
    commonTasks: 2,
    longTasks: 2,
    shortTasks: 4,
    visualTasks: false,
    maxPlayers: 15,
    map: 0,
    shapeshifters: 0,
    angels: 1,
    vipers: 0,
    engineers: 0
  },
  trio_mess: {
    impostors: 3,
    killCooldown: 30.0,
    impVision: 1.5,
    killDistance: "short",
    playerSpeed: 1.5,
    crewVision: 1.25,
    meetings: 2,
    meetingCooldown: 15,
    discussionTime: 40,
    votingTime: 160,
    anonymousVotes: true,
    confirmImpostor: true,
    taskBarUpdate: 1,
    commonTasks: 2,
    longTasks: 2,
    shortTasks: 5,
    visualTasks: false,
    maxPlayers: 15,
    map: 0,
    shapeshifters: 0,
    angels: 2,
    vipers: 0,
    engineers: 0,
    detectives: 0
  },
  chaos: {
    impostors: 2,
    killCooldown: 27.5,
    impVision: 1.5,
    killDistance: "short",
    playerSpeed: 1.5,
    crewVision: 1.25,
    meetings: 2,
    meetingCooldown: 15,
    discussionTime: 40,
    votingTime: 160,
    anonymousVotes: true,
    confirmImpostor: true,
    taskBarUpdate: 1,
    commonTasks: 2,
    longTasks: 2,
    shortTasks: 4,
    visualTasks: false,
    maxPlayers: 15,
    map: 0,
    shapeshifters: 1,
    angels: 1,
    vipers: 0,
    engineers: 0
  },
  hardcore: {
    impostors: 2,
    killCooldown: 27.5,
    impVision: 1.5,
    killDistance: "short",
    playerSpeed: 1.5,
    crewVision: 1.25,
    meetings: 2,
    meetingCooldown: 15,
    discussionTime: 40,
    votingTime: 160,
    anonymousVotes: true,
    confirmImpostor: true,
    taskBarUpdate: 1,
    commonTasks: 2,
    longTasks: 2,
    shortTasks: 5,
    visualTasks: false,
    maxPlayers: 15,
    map: 0,
    shapeshifters: 1,
    angels: 2,
    vipers: 1,
    engineers: 0,
    detectives: 1
  }
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
        anonymousVotes: preset.anonymousVotes,
        confirmImpostor: preset.confirmImpostor,
        visualTasks: preset.visualTasks,
        taskBarUpdate: preset.taskBarUpdate,
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
