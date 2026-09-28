#!/usr/bin/env python3
"""Render the README banner and GitHub social preview from the Kestrel icon.

    python tools/render_banner.py   ->  assets/banner.png (1600x640), assets/social-preview.png (1280x640)

Colours are the Rosé Pine roles used by the Lucent design language (dark).
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from render_brand import FONT, tile

ROOT = Path(__file__).resolve().parents[1]
CANVAS = (25, 23, 36)        # Rosé Pine base
CANVAS_HI = (38, 35, 58)     # Rosé Pine overlay
ACCENT = (167, 155, 245)     # Lucent accent (lavender)
INK = (242, 239, 246)
INK2 = (144, 140, 170)       # Rosé Pine subtle


def banner(width: int, height: int, subtitle: str) -> Image.Image:
    img = Image.new("RGB", (width, height), CANVAS)
    # Soft vertical gradient toward the overlay colour.
    grad = Image.linear_gradient("L").resize((width, height))
    img = Image.composite(Image.new("RGB", (width, height), CANVAS_HI), img, grad.point(lambda v: v // 3))
    size = int(height * 0.56)
    x0 = int(width * 0.09)
    y0 = (height - size) // 2
    # Lavender glow behind the tile (the one ambient light, per Lucent).
    glow = Image.new("L", (width, height), 0)
    ImageDraw.Draw(glow).ellipse((x0 - size * 0.25, y0 - size * 0.25, x0 + size * 1.25, y0 + size * 1.25), fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.22))
    img = Image.composite(Image.new("RGB", (width, height), ACCENT), img, glow)
    img = img.convert("RGBA")
    img.alpha_composite(tile().resize((size, size), Image.LANCZOS), (x0, y0))

    draw = ImageDraw.Draw(img)
    title = ImageFont.truetype(str(FONT), int(height * 0.19))
    sub = ImageFont.truetype(str(FONT), int(height * 0.062))
    tx = x0 + size + int(width * 0.05)
    _, t_top, _, t_bottom = title.getbbox("Kestrel")
    _, s_top, _, s_bottom = sub.getbbox(subtitle)
    gap = int(height * 0.05)
    block = (t_bottom - t_top) + gap + (s_bottom - s_top)
    ty = (height - block) // 2 - t_top
    draw.text((tx, ty), "Kestrel", font=title, fill=INK)
    draw.text((tx, ty + t_bottom + gap - s_top), subtitle, font=sub, fill=INK2)
    return img.convert("RGB")


def main() -> None:
    subtitle = "Cameras & wildlife AI for Home Assistant"
    banner(1600, 640, subtitle).save(ROOT / "assets" / "banner.png", optimize=True)
    banner(1280, 640, subtitle).save(ROOT / "assets" / "social-preview.png", optimize=True)
    print("wrote assets/banner.png and assets/social-preview.png")


if __name__ == "__main__":
    main()
