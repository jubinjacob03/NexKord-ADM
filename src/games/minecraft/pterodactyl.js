import axios from "axios";
import WebSocket from "ws";
import dotenv from "dotenv";
dotenv.config();

const PTERO_URL = process.env.PTERODACTYL_URL;
const SERVER_ID = process.env.PTERODACTYL_SERVER_ID;
const API_KEY = process.env.PTERODACTYL_API_KEY;

const apiClient = axios.create({
  baseURL: `${PTERO_URL}/api/client/servers/${SERVER_ID}`,
  timeout: 10000,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  },
});

let wsInstance = null;
let reconnectTimer = null;
let reconnectDelay = 5000;
let pingInterval = null;
let missedPings = 0;
const MAX_RECONNECT_DELAY = 60000;

const HIBERNATION_SIGNATURES = [
  "MINECRAFT SERVER IS OFFLINE!",
  "Status: Server is HIBERNATING",
];

export let intentionalShutdown = false;
export let isCurrentlyHibernating = false;
let isAutoWaking = false;

setInterval(() => {
  if (isCurrentlyHibernating && !intentionalShutdown) {
    console.log(
      "[Daemon] Watchdog enforcing anti-hibernation. Sending msh start...",
    );
    sendCommand("msh start").catch(() => {});
  }
}, 30000).unref();

/**
 * Establishes and manages a WebSocket connection to the Pterodactyl daemon.
 * Handles auto-reconnection and parses incoming stats and console messages.
 *
 * @param {Object} handlers - Event handlers for WebSocket messages.
 * @param {function(Object): void} handlers.onStatsUpdate - Triggered when server statistics are received.
 * @param {function(string): void} handlers.onConsoleUpdate - Triggered when a new console line is received.
 */
export async function connectWebSocket(handlers) {
  const { onStatsUpdate, onConsoleUpdate } = handlers;

  clearTimeout(reconnectTimer);
  clearInterval(pingInterval);

  if (wsInstance) {
    wsInstance.removeAllListeners();
    try {
      wsInstance.terminate();
    } catch (e) {}
    wsInstance = null;
  }

  try {
    const response = await apiClient.get("/websocket");
    const { token, socket } = response.data.data;

    wsInstance = new WebSocket(socket, {
      headers: { Origin: PTERO_URL },
    });

    wsInstance.on("open", () => {
      console.log(
        "[Pterodactyl WS] Connected to live stats stream. Authenticating...",
      );
      reconnectDelay = 5000;
      wsInstance.send(JSON.stringify({ event: "auth", args: [token] }));

      missedPings = 0;
      pingInterval = setInterval(() => {
        if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
          missedPings++;
          if (missedPings > 2) {
            console.warn(
              "[Pterodactyl WS] Connection appears dead (missed pings). Terminating...",
            );
            wsInstance.terminate();
            return;
          }
          wsInstance.send(JSON.stringify({ event: "ping" }));
        }
      }, 15000);
    });

    wsInstance.on("pong", () => {
      missedPings = 0;
    });

    wsInstance.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        if (message.event === "auth success") {
          console.log(
            "[Pterodactyl WS] Authenticated. Requesting historical logs and live stats...",
          );
          wsInstance.send(JSON.stringify({ event: "send logs", args: [null] }));
          wsInstance.send(JSON.stringify({ event: "send stats", args: [null] }));
        } else if (message.event === "pong") {
          missedPings = 0;
        } else if (message.event === "stats") {
          if (!onStatsUpdate) return;
          const stats = JSON.parse(message.args[0]);

          const standardizedStats = {
            current_state: stats.state,
            resources: {
              memory_bytes: stats.memory_bytes,
              memory_limit_bytes: stats.memory_limit_bytes,
              cpu_absolute: stats.cpu_absolute,
              uptime: stats.uptime,
            },
          };
          onStatsUpdate(standardizedStats);
        } else if (message.event === "console output") {
          if (!onConsoleUpdate) return;
          const logLine = message.args[0];
          onConsoleUpdate(logLine);

          const isHibernating = HIBERNATION_SIGNATURES.some((sig) =>
            logLine.includes(sig),
          );

          if (isHibernating) {
            isCurrentlyHibernating = true;
          } else if (logLine.includes("MINECRAFT SERVER IS STARTING!")) {
            isCurrentlyHibernating = false;
            intentionalShutdown = false;
          }

          if (!intentionalShutdown && !isAutoWaking) {
            if (isHibernating) {
              isAutoWaking = true;
              console.log(
                `[Daemon] MSH Hibernation log detected: "${logLine}". Initiating auto-wake in 15 seconds...`,
              );
              onConsoleUpdate(
                "\x1b[1;31m[SYS] HIBERNATION DETECTED! RESTARTING SERVER IN 15 SECONDS...\x1b[0m",
              );

              setTimeout(() => {
                sendCommand("msh start")
                  .then(() => {
                    isAutoWaking = false;
                  })
                  .catch((err) => {
                    console.error(
                      "[Daemon] Failed to send msh start:",
                      err.message,
                    );
                    isAutoWaking = false;
                  });
                if (onConsoleUpdate) {
                  onConsoleUpdate(
                    '\x1b[1;35m[SYS]\x1b[0m \x1b[1;32mAUTO-RESTARTER DAEMON: FIRING "msh start" WAKE COMMAND NOW!\x1b[0m',
                  );
                }
              }, 15000);
            }
          }
        } else if (message.event === "token expiring") {
          console.log("[Pterodactyl WS] Token expiring, reconnecting...");
          connectWebSocket(handlers);
        }
      } catch (err) {
        console.error("[Pterodactyl WS] Failed to parse message:", err.message);
      }
    });

    wsInstance.on("close", () => {
      console.log(
        `[Pterodactyl WS] Connection closed. Reconnecting in ${reconnectDelay}ms...`,
      );
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        connectWebSocket(handlers);
      }, reconnectDelay);
    });

    wsInstance.on("error", (error) => {
      console.error("[Pterodactyl WS] Error:", error.message);
    });
  } catch (error) {
    if (error.response?.status !== 409) {
      console.error(
        "[Pterodactyl WS] Failed to initialize connection:",
        error.message,
      );
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      connectWebSocket(handlers);
    }, reconnectDelay);
  }
}

/**
 * Retrieves the current status and resource utilization from the Pterodactyl API.
 *
 * @returns {Promise<Object>} An object containing the current server state and resource usage.
 */
export async function getServerStatus() {
  try {
    const response = await apiClient.get("/resources");
    return response.data.attributes;
  } catch (error) {
    if (error.response?.status === 409) {
      return {
        current_state: "suspended",
        resources: {
          memory_bytes: 0,
          memory_limit_bytes: 0,
          cpu_absolute: 0,
          uptime: 0,
        },
      };
    }
    console.error(
      "[Pterodactyl] Failed to fetch server status:",
      error.response?.data || error.message,
    );
    throw new Error("Failed to fetch server status");
  }
}

let cachedServerDetails = null;

/**
 * Retrieves the core server details including IP and Port.
 * Caches the result since it doesn't change unless the server is reinstalled.
 *
 * @returns {Promise<Object>} An object containing ip and port.
 */
export async function getServerDetails() {
  if (cachedServerDetails) return cachedServerDetails;

  try {
    const response = await apiClient.get("");
    const allocs = response.data.attributes.relationships?.allocations?.data;
    if (allocs && allocs.length > 0) {
      const defaultAlloc =
        allocs.find((a) => a.attributes.is_default) || allocs[0];
      const ip = defaultAlloc.attributes.ip_alias || defaultAlloc.attributes.ip;
      const port = defaultAlloc.attributes.port;
      cachedServerDetails = { ip, port };
      return cachedServerDetails;
    }
    return { ip: "Unknown", port: "0000" };
  } catch (error) {
    console.error(
      "[Pterodactyl] Failed to fetch server details:",
      error.message,
    );
    return { ip: "Unknown", port: "0000" };
  }
}

/**
 * Transmits a power action signal to the game server.
 *
 * @param {string} signal - The power action to perform ('start', 'stop', 'restart', or 'kill').
 * @returns {Promise<boolean>} True if the command was successfully dispatched.
 */
export async function setPowerState(signal) {
  try {
    if (signal === "stop" || signal === "kill") {
      intentionalShutdown = true;
    } else if (signal === "start" || signal === "restart") {
      intentionalShutdown = false;
    }

    await apiClient.post("/power", { signal });
    return true;
  } catch (error) {
    const errorDetail =
      error.response?.data?.errors?.[0]?.detail || error.message;
    console.error(
      `[Pterodactyl] Failed to send power signal ${signal}:`,
      errorDetail,
    );
    throw new Error(errorDetail);
  }
}

/**
 * Dispatches a console command directly to the game server process.
 *
 * @param {string} command - The raw command string to execute.
 * @returns {Promise<boolean>} True if the command was successfully dispatched.
 */
export async function sendCommand(command) {
  try {
    await apiClient.post("/command", { command });
    return true;
  } catch (error) {
    const errorDetail =
      error.response?.data?.errors?.[0]?.detail || error.message;
    console.error(`[Pterodactyl] Failed to send command:`, errorDetail);
    throw new Error(errorDetail);
  }
}
