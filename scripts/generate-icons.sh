#!/usr/bin/env bash
# Regenerate all platform icons (icns, ico, png, android, ios) from rtl_radio.png.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 scripts/generate-app-icon.py
npm run tauri icon src-tauri/icons/app-icon.png

echo "Icons updated under src-tauri/icons/"
