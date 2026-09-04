#!/usr/bin/env python3
"""Generate a 1024×1024 macOS app icon source (Apple HIG safe area, no manual rounding)."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src-tauri/icons/rtl_radio.png"
OUT = ROOT / "src-tauri/icons/app-icon.png"

SIZE = 1024
# Apple icon grid: keep artwork inside ~80% safe zone; system applies squircle mask.
SAFE_RATIO = 0.78
BG = (29, 29, 31, 255)  # macOS dark icon plate


def key_black(px: tuple[int, ...], threshold: int = 28) -> bool:
    return px[0] <= threshold and px[1] <= threshold and px[2] <= threshold


def strip_black_bg(img: Image.Image) -> Image.Image:
    rgba = img.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            if key_black(px[x, y][:3]):
                px[x, y] = (0, 0, 0, 0)
    return rgba


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    w, h = src.size
    # Symbol only — dock icons should not include wordmarks (Apple HIG).
    symbol = src.crop((0, 0, w, int(h * 0.68)))
    symbol = strip_black_bg(symbol)

    canvas = Image.new("RGBA", (SIZE, SIZE), BG)

    safe = int(SIZE * SAFE_RATIO)
    symbol.thumbnail((safe, safe), Image.Resampling.LANCZOS)
    x = (SIZE - symbol.width) // 2
    y = (SIZE - symbol.height) // 2 - 12
    canvas.alpha_composite(symbol, (x, y))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT, "PNG")
    print(f"Wrote {OUT} ({SIZE}×{SIZE})")


if __name__ == "__main__":
    main()
