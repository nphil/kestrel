#!/usr/bin/env python3
"""Render Home Assistant's eight Kestrel brand PNGs from the source icon."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "kestrel-icon-source.png"
OUTPUT = ROOT / "custom_components" / "kestrel" / "brand"

# A fixed glyph set keeps the logo reproducible without system-font dependencies.
_GLYPHS = {
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
}


def _trim_transparent(image: Image.Image) -> Image.Image:
    """Crop near-transparent edges and retain antialiased mark pixels."""
    visible = image.getchannel("A").point(lambda value: 255 if value > 8 else 0)
    bbox = visible.getbbox()
    return image.crop(bbox) if bbox else image


def _plate(size: tuple[int, int], dark_mode: bool) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    width, height = size
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    background = (241, 239, 250, 255) if dark_mode else (35, 31, 58, 255)
    margin = max(1, round(min(size) * 0.025))
    draw.rounded_rectangle(
        (margin, margin, width - margin - 1, height - margin - 1),
        radius=round(min(size) * 0.16),
        fill=background,
    )
    return image, draw


def _composite_mark(canvas: Image.Image, source: Image.Image, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    source = _trim_transparent(source)
    source.thumbnail((x1 - x0, y1 - y0), Image.Resampling.LANCZOS)
    x = x0 + (x1 - x0 - source.width) // 2
    y = y0 + (y1 - y0 - source.height) // 2
    canvas.alpha_composite(source, (x, y))


def _render_icon(source: Image.Image, size: int, dark_mode: bool) -> Image.Image:
    image, draw = _plate((size, size), dark_mode)
    inset = round(size * 0.13)
    draw.rounded_rectangle(
        (inset, inset, size - inset - 1, size - inset - 1),
        radius=round(size * 0.11),
        fill=(255, 255, 255, 255) if dark_mode else (239, 235, 255, 255),
    )
    mark_inset = round(size * 0.19)
    _composite_mark(image, source, (mark_inset, mark_inset, size - mark_inset, size - mark_inset))
    return image


def _draw_wordmark(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    color: tuple[int, int, int, int],
) -> None:
    scale = max(1, round(height / 48))
    gap = scale * 2
    total_width = (5 * scale) * len("KESTREL") + gap * (len("KESTREL") - 1)
    x = round(height * 0.95)
    y = (height - 7 * scale) // 2
    for letter in "KESTREL":
        for row, line in enumerate(_GLYPHS[letter]):
            for column, pixel in enumerate(line):
                if pixel == "1":
                    left, top = x + column * scale, y + row * scale
                    draw.rectangle((left, top, left + scale - 1, top + scale - 1), fill=color)
        x += 5 * scale + gap
    assert x - gap == round(height * 0.95) + total_width
    assert x - gap <= width - round(width * 0.02), f"Wordmark does not fit {width}px canvas"


def _render_logo(source: Image.Image, size: tuple[int, int], dark_mode: bool) -> Image.Image:
    width, height = size
    image, draw = _plate(size, dark_mode)
    side = round(height * 0.78)
    x, y = round(height * 0.08), (height - side) // 2
    draw.rounded_rectangle(
        (x, y, x + side, y + side),
        radius=round(side * 0.18),
        fill=(255, 255, 255, 255) if dark_mode else (239, 235, 255, 255),
    )
    inset = round(side * 0.18)
    _composite_mark(image, source, (x + inset, y + inset, x + side - inset, y + side - inset))
    text_color = (35, 31, 58, 255) if dark_mode else (246, 244, 255, 255)
    _draw_wordmark(draw, width, height, text_color)
    return image


def render(source_path: Path = SOURCE, output_dir: Path = OUTPUT) -> list[Path]:
    """Write the eight required icon/logo variants and return their paths."""
    source = Image.open(source_path).convert("RGBA")
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for dark_mode, prefix in ((False, ""), (True, "dark_")):
        outputs.extend(
            (
                (f"{prefix}icon.png", _render_icon(source, 256, dark_mode)),
                (f"{prefix}icon@2x.png", _render_icon(source, 512, dark_mode)),
                (f"{prefix}logo.png", _render_logo(source, (512, 256), dark_mode)),
                (f"{prefix}logo@2x.png", _render_logo(source, (1024, 512), dark_mode)),
            )
        )
    paths = []
    for name, image in outputs:
        path = output_dir / name
        image.save(path, format="PNG", optimize=True)
        paths.append(path)
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT)
    args = parser.parse_args()
    for path in render(args.source, args.output_dir):
        print(path)


if __name__ == "__main__":
    main()
