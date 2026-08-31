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
let closing = null;

/**
 * Returns the shared CycleTLS client, launching its subprocess lazily on first
 * use. Concurrent callers share one in-flight init.
 * @returns {Promise<import('cycletls').CycleTLSClient>}
 */
export async function getClient() {
  if (closing) await closing;
  if (client) return client;
  if (initing) return initing;

  const initialization = (async () => {
    const created = await initCycleTLS({ timeout: 60000 });
    client = created;
    auditLog("info", "AKINATOR", "TLS client (cycletls) started.");
    return created;
  })();
  initing = initialization;

  try {
    return await initialization;
  } finally {
    if (initing === initialization) initing = null;
  }
}

/**
 * Stops the shared CycleTLS subprocess if running. Called on idle to free
 * memory; the next game relaunches it.
 * @returns {Promise<void>}
 */
export async function closeClient() {
  if (closing) return closing;
  const operation = (async () => {
    const initialized = initing ? await initing.catch(() => null) : null;
    const active = client || initialized;
    client = null;
    if (!active) return;
    try {
      await active.exit();
      auditLog("info", "AKINATOR", "TLS client closed (idle).");
    } catch (error) {
      auditLog("warn", "AKINATOR", `TLS client close failed: ${error.message}`);
    }
  })();
  closing = operation;
  try {
    await operation;
  } finally {
    if (closing === operation) closing = null;
  }
}
