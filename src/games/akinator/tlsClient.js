import initCycleTLS from "cycletls";
import { auditLog } from "../../utils/logger.js";

/**
 * Shared CycleTLS instance. CycleTLS spawns a small Go subprocess that performs
 * TLS/HTTP2 fingerprint impersonation (JA3), letting plain HTTP requests clear
 * Akinator's Cloudflare without a full browser. One instance is reused across
 * games and closed on idle.
 * @type {import('cycletls').CycleTLSClient | null}
 */
let client = null;
/** @type {Promise<any> | null} */
let initing = null;

/**
 * Returns the shared CycleTLS client, launching its subprocess lazily on first
 * use. Concurrent callers share one in-flight init.
 * @returns {Promise<import('cycletls').CycleTLSClient>}
 */
export async function getClient() {
  if (client) return client;
  if (initing) return initing;

  initing = (async () => {
    const c = await initCycleTLS({ timeout: 60000 });
    client = c;
    auditLog("info", "AKINATOR", "TLS client (cycletls) started.");
    return c;
  })();

  try {
    return await initing;
  } finally {
    initing = null;
  }
}

/**
 * Stops the shared CycleTLS subprocess if running. Called on idle to free
 * memory; the next game relaunches it.
 * @returns {Promise<void>}
 */
export async function closeClient() {
  if (!client) return;
  const c = client;
  client = null;
  try {
    await c.exit();
    auditLog("info", "AKINATOR", "TLS client closed (idle).");
  } catch (e) {
    auditLog("warn", "AKINATOR", `TLS client close failed: ${e.message}`);
  }
}
