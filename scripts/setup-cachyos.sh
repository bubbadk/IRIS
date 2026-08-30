#!/usr/bin/env bash
set -euo pipefail

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot identify the operating system." >&2
  exit 1
fi
source /etc/os-release
if [[ "${ID:-}" != "cachyos" && "${ID:-}" != "arch" && "${ID_LIKE:-}" != *arch* ]]; then
  echo "This helper is intended for CachyOS/Arch. Detected: ${ID:-unknown}." >&2
  exit 1
fi

sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool

if ! command -v rustup >/dev/null 2>&1; then
  echo "Installing Rust with rustup..."
  curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh -s -- -y
  export PATH="$HOME/.cargo/bin:$PATH"
fi
rustup default stable

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install an LTS Node package and rerun this script." >&2
  exit 1
fi

corepack enable
corepack prepare pnpm@10.15.0 --activate
pnpm install

echo
echo "IRIS development environment is ready."
echo "Start the desktop app with: pnpm desktop"
echo "Build an AppImage with: pnpm build:appimage"
echo "For the reproducible Debian 12 build: pnpm build:appimage:container"
