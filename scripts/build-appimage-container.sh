#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UID_HOST="$(id -u)"
GID_HOST="$(id -g)"

if command -v podman >/dev/null 2>&1; then
  ENGINE=podman
elif command -v docker >/dev/null 2>&1; then
  ENGINE=docker
else
  echo "Install Podman or Docker to use the reproducible AppImage builder." >&2
  exit 1
fi

echo "Building IRIS AppImage in Debian 12 using $ENGINE..."

"$ENGINE" run --rm \
  -e HOST_UID="$UID_HOST" -e HOST_GID="$GID_HOST" \
  -v "$ROOT:/workspace" -w /workspace \
  node:22-bookworm bash -lc '
    set -euo pipefail
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
      libayatana-appindicator3-dev librsvg2-dev patchelf ca-certificates xdg-utils
    curl --proto "=https" --tlsv1.2 https://sh.rustup.rs -sSf | sh -s -- -y
    export PATH="$HOME/.cargo/bin:$PATH"
    corepack enable
    corepack prepare pnpm@10.15.0 --activate
    pnpm install --force
    pnpm build:appimage
    chown -R "$HOST_UID:$HOST_GID" apps/desktop/src-tauri/target/release/bundle/appimage || true
  '

echo
find "$ROOT/apps/desktop/src-tauri/target/release/bundle/appimage" -maxdepth 1 -name "*.AppImage" -print
