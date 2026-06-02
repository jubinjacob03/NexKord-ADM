import http from "http";
import { auditLog } from "../../utils/logger.js";
import { handleGameEvent } from "./voiceManager.js";

const EVENT_PORT = parseInt(process.env.BOT_EVENT_PORT || "22026", 10);
const API_KEY = process.env.IMPOSTOR_API_KEY || "your_secret_key";
const MAX_BODY_BYTES = 64 * 1024;

let server = null;

/**
 * Validates the bearer token on an incoming request.
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function isAuthorized(req) {
  const auth = req.headers["authorization"];
  return auth === `Bearer ${API_KEY}`;
}

/**
 * Reads and JSON-parses a request body with a hard size cap.
 * @param {http.IncomingMessage} req
 * @returns {Promise<Object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Starts the internal HTTP server that receives game events from the Impostor plugin.
 * Only intended to be reachable on the docker network, never published to the host.
 */
export function startEventServer() {
  if (server) return;

  server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/events") {
      res.writeHead(404).end();
      return;
    }
    if (!isAuthorized(req)) {
      res.writeHead(401).end();
      return;
    }

    try {
      const event = await readJsonBody(req);
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      // Process after acknowledging so the game thread is never blocked.
      handleGameEvent(event).catch((err) =>
        auditLog("error", "EVENT_SERVER", `Event handling failed: ${err.message}`),
      );
    } catch (error) {
      res.writeHead(400).end();
      auditLog("warn", "EVENT_SERVER", `Bad event request: ${error.message}`);
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      auditLog("error", "EVENT_SERVER", `Port ${EVENT_PORT} already in use; event server disabled`);
      server = null;
      return;
    }
    auditLog("error", "EVENT_SERVER", `Server error: ${err.message}`);
  });

  server.listen(EVENT_PORT, () => {
    auditLog("info", "EVENT_SERVER", `Listening for game events on port ${EVENT_PORT}`);
  });
}

/**
 * Stops the event server (used on graceful shutdown).
 */
export function stopEventServer() {
  if (server) {
    server.close();
    server = null;
  }
}
