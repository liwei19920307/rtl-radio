#!/usr/bin/env python3
"""Build the 1024×1024 master app icon used on all platforms."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src-tauri/icons/rtl_radio.png"
OUT = ROOT / "src-tauri/icons/app-icon.png"

SIZE = 1024
SAFE_RATIO = 0.84
BG = (10, 10, 10, 255)


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    canvas = Image.new("RGBA", (SIZE, SIZE), BG)

    safe = int(SIZE * SAFE_RATIO)
    art = src.copy()
    art.thumbnail((safe, safe), Image.Resampling.LANCZOS)
    x = (SIZE - art.width) // 2
    y = (SIZE - art.height) // 2
    canvas.alpha_composite(art, (x, y))

    # Fully opaque master — avoids white plates on macOS / adaptive Android icons.
    opaque = Image.new("RGB", (SIZE, SIZE), BG[:3])
    opaque.paste(canvas, mask=canvas.split()[3])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    opaque.save(OUT, "PNG")
    print(f"Wrote {OUT} ({SIZE}×{SIZE})")


if __name__ == "__main__":
    main()
