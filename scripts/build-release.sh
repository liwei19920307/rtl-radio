#!/usr/bin/env bash
# Build RTL Radio release bundles. Run from repo root on macOS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"

PLATFORM="${1:-all}"
OUT="$ROOT/dist/release"
mkdir -p "$OUT"

npm run build

build_macos() {
  echo "==> macOS DMG (aarch64)"
  npm run tauri build -- --bundles dmg
  DMG=(src-tauri/target/release/bundle/dmg/*.dmg)
  if [[ -f ${DMG[0]} ]]; then
    cp "${DMG[0]}" "$OUT/RTL-Radio-macos.dmg"
    echo "OK: $OUT/RTL-Radio-macos.dmg"
  fi
}

build_windows() {
  echo "==> Windows x64 (exe, cross-compile from macOS)"
  rustup target add x86_64-pc-windows-msvc 2>/dev/null || true
  if ! command -v cargo-xwin >/dev/null 2>&1; then
    echo "Installing cargo-xwin..."
    cargo install cargo-xwin --locked
  fi
  # macOS 上 Tauri 不能打 .msi，只产出可执行文件
  npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle
  EXE="src-tauri/target/x86_64-pc-windows-msvc/release/rtl-radio.exe"
  if [[ -f "$EXE" ]]; then
    cp "$EXE" "$OUT/RTL-Radio-windows-x64.exe"
    (cd "$OUT" && zip -q "RTL-Radio-windows-x64.zip" "RTL-Radio-windows-x64.exe")
    echo "OK: $OUT/RTL-Radio-windows-x64.zip (未含安装器，需本机 VC 运行库)"
  else
    echo "Windows exe not found" >&2
    exit 1
  fi
}

build_linux() {
  echo "==> Linux x64 (Docker)"
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker required for Linux builds on macOS. Install Docker Desktop." >&2
    exit 1
  fi
  docker run --rm --platform linux/amd64 \
    -v "$ROOT:/app" -w /app \
    -e CI=true \
    node:22-bookworm bash -lc '
      set -e
      apt-get update -qq
      apt-get install -y -qq curl build-essential libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev pkg-config
      curl -fsSL https://sh.rustup.rs | sh -s -- -y -q
      . "$HOME/.cargo/env"
      npm ci
      npm run tauri build -- --bundles deb,appimage
    '
  for f in src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/appimage/*.AppImage; do
    [[ -f "$f" ]] || continue
    case "$f" in
      *.deb) cp "$f" "$OUT/RTL-Radio-linux-x64.deb" ;;
      *.AppImage) cp "$f" "$OUT/RTL-Radio-linux-x64.AppImage" ;;
    esac
  done
  if [[ -f "$OUT/RTL-Radio-linux-x64.deb" ]] || [[ -f "$OUT/RTL-Radio-linux-x64.AppImage" ]]; then
    echo "OK: Linux bundles in $OUT/"
  else
    echo "Linux build finished but bundles not found" >&2
    exit 1
  fi
}

case "$PLATFORM" in
  macos) build_macos ;;
  windows|win) build_windows ;;
  linux) build_linux ;;
  all)
    build_macos
    build_windows || echo "WARN: Windows build failed" >&2
    build_linux || echo "WARN: Linux build failed" >&2
    ;;
  *) echo "Usage: $0 [macos|windows|linux|all]" >&2; exit 1 ;;
esac

echo "Done. Artifacts: $OUT/"
