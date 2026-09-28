#!/usr/bin/env python3
"""Render Home Assistant's eight Kestrel brand PNGs from the source icon.

Home Assistant serves `custom_components/kestrel/brand/*.png` for a custom integration
(see skill notes: core's `brands` component, `_serve_from_custom_integration`).

- icon: the Kestrel tile itself, cut to a crisp rounded square (the source's soft outer
  glow is dropped so it stays sharp at 48 px), transparent corners.
- logo: the tile + the "Kestrel" wordmark in Inter SemiBold (tools/fonts, SIL OFL).
  `logo*` uses dark ink for HA's light theme, `dark_logo*` light ink for the dark theme.
  The tile carries its own dark plate and lavender rim, so the icon reads on both.

    python tools/render_brand.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "kestrel-icon-source.png"
FONT = ROOT / "tools" / "fonts" / "Inter-SemiBold.ttf"
OUTPUT = ROOT / "custom_components" / "kestrel" / "brand"

INK_LIGHT_THEME = (23, 19, 31, 255)   # Rosé Pine role "ink" (light)
INK_DARK_THEME = (242, 239, 246, 255)  # Rosé Pine role "ink" (dark)
CORNER = 0.215  # corner radius as a share of the tile width (matches the artwork)


def tile() -> Image.Image:
    """The solid tile, cropped to its edges, with a clean rounded-square alpha mask."""
    src = Image.open(SOURCE).convert("RGBA")
    solid = src.getchannel("A").point(lambda a: 255 if a > 235 else 0)
    box = solid.getbbox()
    if box is None:
        raise SystemExit(f"{SOURCE} has no opaque tile")
    left, top, right, bottom = box
    side = max(right - left, bottom - top)
    cx, cy = (left + right) // 2, (top + bottom) // 2
    crop = src.crop((cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side))
    scale = 4  # supersample the mask so the corners are smooth
    mask = Image.new("L", (side * scale, side * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, side * scale - 1, side * scale - 1),
                                           radius=int(side * scale * CORNER), fill=255)
    mask = mask.resize((side, side), Image.LANCZOS)
    crop.putalpha(ImageChops.multiply(crop.getchannel("A"), mask))
    return crop


def icon(base: Image.Image, size: int) -> Image.Image:
    pad = round(size * 0.04)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(base.resize((size - 2 * pad, size - 2 * pad), Image.LANCZOS), (pad, pad))
    return canvas


def logo(base: Image.Image, height: int, ink: tuple[int, int, int, int]) -> Image.Image:
    font = ImageFont.truetype(str(FONT), round(height * 0.50))
    word = "Kestrel"
    l, t, r, b = font.getbbox(word)
    gap = round(height * 0.22)
    width = height + gap + (r - l) + round(height * 0.06)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.alpha_composite(icon(base, height), (0, 0))
    draw = ImageDraw.Draw(canvas)
    # Optical centre: centre the cap height, not the full glyph box.
    cap_top, _, _, cap_bottom = font.getbbox("K")
    y = (height - (cap_bottom - cap_top)) // 2 - cap_top
    draw.text((height + gap - l, y), word, font=font, fill=ink)
    return canvas


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    base = tile()
    for suffix, scale in (("", 1), ("@2x", 2)):
        mark = icon(base, 256 * scale)
        mark.save(OUTPUT / f"icon{suffix}.png", optimize=True)
        mark.save(OUTPUT / f"dark_icon{suffix}.png", optimize=True)
        logo(base, 128 * scale, INK_LIGHT_THEME).save(OUTPUT / f"logo{suffix}.png", optimize=True)
        logo(base, 128 * scale, INK_DARK_THEME).save(OUTPUT / f"dark_logo{suffix}.png", optimize=True)
    print(f"wrote 8 brand images to {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
