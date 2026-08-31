import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "transfer-encoding",
]);
const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

function normalizeAddress(address) {
  let value = String(address || "")
    .trim()
    .toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  return value;
}

function parseIpv4(address) {
  const value = normalizeAddress(address);
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function parseIpv6(address) {
  let value = normalizeAddress(address);
  if (!value || value.includes(":::")) return null;

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(value.slice(lastColon + 1));
    if (ipv4 === null) return null;
    value = `${value.slice(0, lastColon)}:${(ipv4 >> 16n).toString(16)}:${(
      ipv4 & 0xffffn
    ).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (
    parts.length !== 8 ||
    parts.some((part) => !/^[\da-f]{1,4}$/i.test(part))
  ) {
    return null;
  }

  return parts.reduce(
    (result, part) => (result << 16n) | BigInt(`0x${part}`),
    0n,
  );
}

function containsPrefix(value, network, prefixLength, width) {
  const shift = BigInt(width - prefixLength);
  return value >> shift === network >> shift;
}

function ipv4Range(address, prefixLength) {
  return [parseIpv4(address), prefixLength];
}

function ipv6Range(address, prefixLength) {
  return [parseIpv6(address), prefixLength];
}

const NON_GLOBAL_IPV4_RANGES = [
  ipv4Range("0.0.0.0", 8),
  ipv4Range("10.0.0.0", 8),
  ipv4Range("100.64.0.0", 10),
  ipv4Range("127.0.0.0", 8),
  ipv4Range("169.254.0.0", 16),
  ipv4Range("172.16.0.0", 12),
  ipv4Range("192.0.0.0", 24),
  ipv4Range("192.0.2.0", 24),
  ipv4Range("192.31.196.0", 24),
  ipv4Range("192.52.193.0", 24),
  ipv4Range("192.88.99.0", 24),
  ipv4Range("192.168.0.0", 16),
  ipv4Range("192.175.48.0", 24),
  ipv4Range("198.18.0.0", 15),
  ipv4Range("198.51.100.0", 24),
  ipv4Range("203.0.113.0", 24),
  ipv4Range("224.0.0.0", 4),
  ipv4Range("240.0.0.0", 4),
];

const NON_GLOBAL_IPV6_RANGES = [
  ipv6Range("2001::", 23),
  ipv6Range("2001:db8::", 32),
  ipv6Range("2002::", 16),
  ipv6Range("2620:4f:8000::", 48),
  ipv6Range("3fff::", 20),
];

function isNonGlobalIpv4Value(value) {
  return NON_GLOBAL_IPV4_RANGES.some(([network, prefixLength]) =>
    containsPrefix(value, network, prefixLength, 32),
  );
}

function mappedIpv4Value(value) {
  return value >> 32n === 0xffffn ? value & 0xffffffffn : null;
}

function isNonGlobalIpv6Value(value) {
  const mapped = mappedIpv4Value(value);
  if (mapped !== null) return isNonGlobalIpv4Value(mapped);

  const globalUnicast = containsPrefix(value, parseIpv6("2000::"), 3, 128);
  if (!globalUnicast) return true;
  return NON_GLOBAL_IPV6_RANGES.some(([network, prefixLength]) =>
    containsPrefix(value, network, prefixLength, 128),
  );
}

export function isPrivateAddress(address) {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return isNonGlobalIpv4Value(ipv4);
  const ipv6 = parseIpv6(address);
  if (ipv6 !== null) return isNonGlobalIpv6Value(ipv6);
  return true;
}

function normalizeHostname(hostname) {
  return normalizeAddress(hostname).replace(/\.$/, "");
}

function hostAllowed(hostname, allowedHosts) {
  if (allowedHosts.length === 0) return true;
  const host = normalizeHostname(hostname);
  return allowedHosts.some((allowed) => {
    const candidate = normalizeHostname(allowed);
    return candidate && (host === candidate || host.endsWith(`.${candidate}`));
  });
}

function validatePort(url, allowedPorts) {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const ports =
    allowedPorts ??
    (url.protocol === "https:" ? [443] : url.protocol === "http:" ? [80] : []);
  if (!ports.map(Number).includes(port)) {
    throw new Error("The remote URL uses a disallowed port.");
  }
}

export async function resolvePublicEndpoint(
  input,
  { protocols = ["https:"], allowedHosts = [], allowedPorts = null } = {},
) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error("Enter a valid URL.");
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(`Only ${protocols.join(", ")} URLs are allowed.`);
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }
  validatePort(url, allowedPorts);

  const hostname = normalizeHostname(url.hostname);
  if (!hostAllowed(hostname, allowedHosts)) {
    throw new Error(`Downloads from ${hostname} are not allowed.`);
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Local network destinations are not allowed.");
  }

  const literalVersion = net.isIP(hostname);
  let resolved;
  try {
    resolved = literalVersion
      ? [{ address: hostname, family: literalVersion }]
      : await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("The remote hostname could not be resolved.");
  }

  const addresses = [];
  const seen = new Set();
  for (const entry of resolved) {
    const address = normalizeAddress(entry.address);
    const family = net.isIP(address);
    if (!family || isPrivateAddress(address)) {
      throw new Error(
        "Private, local, and reserved network destinations are not allowed.",
      );
    }
    const key = `${family}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      addresses.push({ address, family });
    }
  }

  if (addresses.length === 0) {
    throw new Error("The remote hostname did not resolve to a public address.");
  }

  return { url, hostname, addresses };
}

export async function validatePublicUrl(input, options = {}) {
  return (await resolvePublicEndpoint(input, options)).url;
}

function normalizeRequestHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }
  const normalized = {};
  let totalBytes = 0;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined || rawValue === null || rawValue === "")
      continue;
    const name = String(rawName).toLowerCase();
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      FORBIDDEN_REQUEST_HEADERS.has(name)
    ) {
      throw new Error("The remote request contains a disallowed header.");
    }
    const value = String(rawValue);
    if (/[\r\n\0]/.test(value)) {
      throw new Error("The remote request contains an invalid header value.");
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (totalBytes > 32768) {
      throw new Error("The remote request headers are too large.");
    }
    normalized[name] = value;
  }
  if (!normalized["accept-encoding"])
    normalized["accept-encoding"] = "identity";
  return normalized;
}

function addressKey(address) {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return `4:${ipv4}`;
  const ipv6 = parseIpv6(address);
  if (ipv6 === null) return null;
  const mapped = mappedIpv4Value(ipv6);
  return mapped === null ? `6:${ipv6}` : `4:${mapped}`;
}

function pinnedLookup(address) {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function requestEndpoint(endpoint, headers, signal, timeoutMs, address) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = https.request(
      endpoint.url,
      {
        agent: false,
        family: address.family,
        headers,
        lookup: pinnedLookup(address),
        method: "GET",
        servername: net.isIP(endpoint.hostname) ? undefined : endpoint.hostname,
        signal,
      },
      (response) => {
        settled = true;
        resolve(response);
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("The remote server stopped responding."));
    });
    request.once("socket", (socket) => {
      socket.once("secureConnect", () => {
        if (addressKey(socket.remoteAddress) !== addressKey(address.address)) {
          request.destroy(
            new Error(
              "The remote connection did not use the approved address.",
            ),
          );
        }
      });
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

async function requestApprovedEndpoint(endpoint, headers, signal, timeoutMs) {
  let lastError = null;
  for (const address of endpoint.addresses) {
    try {
      return await requestEndpoint(
        endpoint,
        headers,
        signal,
        timeoutMs,
        address,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("Could not connect to the approved endpoint.");
}

function stripSensitiveHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !SENSITIVE_REQUEST_HEADERS.has(name),
    ),
  );
}

export async function openPublicHttpsResponse(
  input,
  {
    allowedHosts = [],
    allowedPorts = [443],
    headers = {},
    maxRedirects = 5,
    signal,
    timeoutMs = 30000,
  } = {},
) {
  let current = new URL(String(input));
  let requestHeaders = normalizeRequestHeaders(headers);

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const endpoint = await resolvePublicEndpoint(current, {
      protocols: ["https:"],
      allowedHosts,
      allowedPorts,
    });
    const response = await requestApprovedEndpoint(
      endpoint,
      requestHeaders,
      signal,
      timeoutMs,
    );
    const status = response.statusCode ?? 0;
    if (!REDIRECT_STATUSES.has(status)) {
      return { response, url: endpoint.url, addresses: endpoint.addresses };
    }

    let next;
    try {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Redirect ${status} had no location.`);
      }
      if (redirects === maxRedirects) {
        throw new Error("Download exceeded the redirect limit.");
      }
      next = new URL(location, endpoint.url);
    } finally {
      response.destroy();
    }

    if (next.origin !== endpoint.url.origin) {
      requestHeaders = stripSensitiveHeaders(requestHeaders);
    }
    current = next;
  }

  throw new Error("Download exceeded the redirect limit.");
}

export function redactUrl(input) {
  try {
    const url = new URL(String(input));
    return `${url.origin}/<redacted>`;
  } catch {
    return "<invalid-url>";
  }
}
