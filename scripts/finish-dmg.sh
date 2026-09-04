#!/usr/bin/env bash
# macOS mounts DMG volume icons as square tiles — unlike .app squircle icons.
# Remove the custom volume icon so Finder shows the standard disk badge instead.
set -euo pipefail

DMG="${1:-}"
if [[ -z "$DMG" || ! -f "$DMG" ]]; then
  echo "Usage: $0 path/to/RTL-Radio.dmg" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
RW="$WORKDIR/rw.dmg"
OUT="$WORKDIR/finished.dmg"

hdiutil convert "$DMG" -format UDRW -o "$RW" -quiet
ATTACH=$(hdiutil attach -readwrite -noverify -nobrowse "$RW")
MOUNT=$(echo "$ATTACH" | grep -o '/Volumes/.*' | tail -1)

if [[ -f "$MOUNT/.VolumeIcon.icns" ]]; then
  rm "$MOUNT/.VolumeIcon.icns"
  # Clear custom volume icon flag (lowercase c).
  if command -v SetFile >/dev/null 2>&1; then
    SetFile -a c "$MOUNT" 2>/dev/null || true
  fi
fi

hdiutil detach "$MOUNT" -quiet
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT" -quiet
mv "$OUT" "$DMG"
echo "OK: cleared DMG volume icon -> $DMG"
