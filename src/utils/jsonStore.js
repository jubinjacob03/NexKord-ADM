import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const unsupportedDirectorySyncCodes = new Set([
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
  "EPERM",
]);

function fallbackValue(fallback) {
  return typeof fallback === "function"
    ? fallback()
    : structuredClone(fallback);
}

function syncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!unsupportedDirectorySyncCodes.has(error.code)) throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function readJsonFileSync(
  filePath,
  { fallback, validate = () => true, label = path.basename(filePath) },
) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallbackValue(fallback);
    throw new Error(`[STORE] ${label} could not be read: ${error.message}`, {
      cause: error,
    });
  }

  try {
    const value = JSON.parse(content);
    if (!validate(value)) throw new Error("stored data failed validation");
    return value;
  } catch (error) {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
    try {
      fs.renameSync(filePath, quarantinePath);
      syncDirectory(path.dirname(filePath));
    } catch (quarantineError) {
      throw new AggregateError(
        [error, quarantineError],
        `[STORE] ${label} was invalid and could not be quarantined.`,
      );
    }
    console.error(
      `[STORE] ${label} was invalid and moved to ${path.basename(quarantinePath)}: ${error.message}`,
    );
    return fallbackValue(fallback);
  }
}

export function writeJsonFileAtomicSync(
  filePath,
  value,
  { pretty = false } = {},
) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const content = JSON.stringify(value, null, pretty ? 2 : 0);

  try {
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(directory);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}
