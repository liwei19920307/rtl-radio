#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

cd "$ROOT"
npm run build
npm run tauri build -- --bundles app

APP_NAME="RTL Radio.app"
BUILT="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"
DEST="$HOME/Applications/$APP_NAME"
BIN_SRC="$ROOT/src-tauri/target/release/rtl-radio"
BIN_DST="$DEST/Contents/MacOS/rtl-radio"

pkill -x rtl-radio 2>/dev/null || true
rm -rf "$DEST"
cp -R "$BUILT" "$DEST"
cp "$BIN_SRC" "$BIN_DST"
xattr -cr "$DEST" 2>/dev/null || true

echo "Installed: $DEST"
md5 "$BIN_SRC" "$BIN_DST"
open "$DEST"
