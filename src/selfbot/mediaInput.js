import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { validatePublicUrl } from "../utils/network.js";
import { isAdaptiveMediaUrl } from "./progressiveMedia.js";

function containedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

async function validateLocalPlayInput(input) {
  const candidate = await fs.promises.realpath(path.resolve(input));
  const stat = await fs.promises.stat(candidate);
  if (!stat.isFile()) throw new Error("The play path must be a regular file.");

  const configuredRoots = [
    path.join(process.cwd(), "data", "library"),
    path.join(process.cwd(), "data", "cache"),
  ];
  const roots = [];
  for (const root of configuredRoots) {
    try {
      roots.push(await fs.promises.realpath(root));
    } catch {}
  }
  if (!roots.some((root) => containedBy(root, candidate))) {
    throw new Error(
      "Local playback is limited to the Cinema library and cache.",
    );
  }
  return { input: candidate, label: path.basename(candidate), remote: false };
}

export async function validateRemoteMediaUrl(input) {
  const url = await validatePublicUrl(input, {
    protocols: ["https:"],
    allowedHosts: config.playAllowedHosts,
  });
  if (isAdaptiveMediaUrl(url)) {
    throw new Error(
      "Adaptive media manifests and segments are not supported; use a progressive media URL.",
    );
  }
  return url.href;
}

export async function validatePlayInput(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("A media URL or file path is required.");

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
  if (hasScheme && !path.isAbsolute(value)) {
    const remote = await validateRemoteMediaUrl(value);
    return {
      input: remote,
      label: new URL(remote).hostname,
      remote: true,
    };
  }
  return validateLocalPlayInput(value);
}
