#!/usr/bin/env bash
#
# Generates a free Cloudflare WARP WireGuard profile (via wgcf) and converts it
# into a userspace wireproxy config exposing a SOCKS5 proxy on :1080.
#
# Why: Akinator's Cloudflare hard-blocks datacenter IPs (403). WARP provides a
# non-datacenter egress. Using raw WireGuard to WARP's anycast endpoint
# (162.159.192.1:2408 -> nearest Cloudflare edge) instead of the MASQUE-based
# warp-cli container cuts per-request latency dramatically (~5% overhead vs.
# seconds), with no privileged container, no TUN device, and no cost.
#
# Run once on the host, from the repo root:  bash scripts/setup-warp-wireproxy.sh
# Idempotent: an existing WARP account is reused; the wireproxy config is rebuilt.

set -euo pipefail
cd "$(dirname "$0")/.."

WARP_DIR="data/warp"
WGCF="$WARP_DIR/wgcf"
PROFILE="$WARP_DIR/wgcf-profile.conf"
OUT="$WARP_DIR/wireproxy.conf"

# Cloudflare WARP's well-known peer public key and nearest-edge anycast endpoint.
WARP_PUBKEY="bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo="
WARP_ENDPOINT="162.159.192.1:2408"

mkdir -p "$WARP_DIR"

if [ ! -x "$WGCF" ]; then
  echo "[setup] Downloading wgcf..."
  URL="$(curl -fsSL https://api.github.com/repos/ViRb3/wgcf/releases/latest \
    | grep -o 'https://[^"]*_linux_amd64' | head -1)"
  if [ -z "$URL" ]; then
    echo "[setup] ERROR: could not resolve wgcf download URL." >&2
    exit 1
  fi
  curl -fsSL "$URL" -o "$WGCF"
  chmod +x "$WGCF"
fi

cd "$WARP_DIR"

if [ ! -f wgcf-account.toml ]; then
  echo "[setup] Registering a new (free) WARP account..."
  ./wgcf register --accept-tos
fi

echo "[setup] Generating WireGuard profile..."
./wgcf generate

PRIV="$(grep -m1 'PrivateKey' wgcf-profile.conf | awk '{print $3}')"
ADDR="$(grep -m1 -E 'Address = 172' wgcf-profile.conf | awk '{print $3}')"

if [ -z "$PRIV" ] || [ -z "$ADDR" ]; then
  echo "[setup] ERROR: failed to parse keys from wgcf-profile.conf." >&2
  exit 1
fi

# IPv4-only on purpose: the host/container IPv6 path has proven flaky, and IPv4
# egress is sufficient for Akinator.
cat > wireproxy.conf <<EOF
[Interface]
PrivateKey = $PRIV
Address = $ADDR
DNS = 1.1.1.1
MTU = 1280

[Peer]
PublicKey = $WARP_PUBKEY
Endpoint = $WARP_ENDPOINT
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25

[Socks5]
BindAddress = 0.0.0.0:1080
EOF

echo "[setup] Wrote $OUT"
echo "[setup] Done. Next: docker compose up -d --build"
