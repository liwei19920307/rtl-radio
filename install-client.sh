#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

cd "$ROOT"
npm run build
npm run tauri build -- --bundles app

APP_NAME="RTL Radio.app"
BUILT="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"
BIN_SRC="$ROOT/src-tauri/target/release/rtl-radio"
DESTS=(
  "$HOME/Applications/$APP_NAME"
  "/Applications/$APP_NAME"
)

pkill -x rtl-radio 2>/dev/null || true

for DEST in "${DESTS[@]}"; do
  mkdir -p "$(dirname "$DEST")"
  rm -rf "$DEST"
  cp -R "$BUILT" "$DEST"
  cp "$BIN_SRC" "$DEST/Contents/MacOS/rtl-radio"
  xattr -cr "$DEST" 2>/dev/null || true
  echo "Installed: $DEST"
done

md5 "$BIN_SRC" "${DESTS[0]}/Contents/MacOS/rtl-radio" "${DESTS[1]}/Contents/MacOS/rtl-radio"
open "${DESTS[0]}"
