"""Assemble the workflow GIFs from the frames written by web/scripts/record-workflows.mjs.

Usage: make_gifs.py FRAMES_DIR OUTPUT_DIR [names]
Each frame gets a caption bar. All frames of a GIF share one adaptive palette. Consecutive identical frames merge.
A GIF over the size limit is rebuilt with fewer colours, and every state stays in the file.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WIDTH = 1100
MAX_BYTES = 6 * 1024 * 1024
COLOUR_STEPS = (256, 192, 128, 96, 64, 48, 32)
SURFACE = (0x15, 0x16, 0x1B)
BORDER = (0x24, 0x26, 0x2D)
TEXT = (0xEC, 0xED, 0xF0)
FONT_SIZE = 24
LINE_HEIGHT = 32
PAD_X = 28
PAD_Y = 16
LINES = 2
BAR = LINE_HEIGHT * LINES + PAD_Y * 2
# The interface tokens and colour scales, so small marks such as the orange ring keep their colour.
SWATCHES = ["#0B0C0F", "#0E0F13", "#111216", "#15161B", "#1B1D23", "#1D1F25", "#24262D", "#1E2026", "#2E3038", "#ECEDF0",
            "#C4C7CE", "#9A9EA8", "#8B8F99", "#5B7BF0", "#8EA4F7", "#1A2140", "#E07B39", "#F29A63", "#261A12", "#5FBF7A",
            "#20232E", "#4660C8", "#A8BAFF", "#F08C50", "#5A3A24"]


def load_font() -> ImageFont.FreeTypeFont:
    for path in (ROOT / "web/node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf", Path("/System/Library/Fonts/Helvetica.ttc")):
        if path.exists():
            return ImageFont.truetype(str(path), FONT_SIZE)
    raise SystemExit("Found neither Geist nor Helvetica.")


def wrap(text: str, font, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if font.getlength(trial) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    lines.append(line)
    return lines


def with_caption(path: Path, caption: str, font) -> Image.Image:
    src = Image.open(path).convert("RGB")
    height = round(src.height * WIDTH / src.width)
    out = Image.new("RGB", (WIDTH, height + BAR), SURFACE)
    out.paste(src.resize((WIDTH, height), Image.Resampling.LANCZOS), (0, 0))
    draw = ImageDraw.Draw(out)
    draw.line([(0, height), (WIDTH, height)], fill=BORDER)
    lines = wrap(caption, font, WIDTH - 2 * PAD_X)
    if len(lines) > LINES:
        raise SystemExit(f"This caption needs {len(lines)} lines, and the bar has room for {LINES}: {caption}")
    top = height + (BAR - LINE_HEIGHT * len(lines)) // 2
    for i, text in enumerate(lines):
        draw.text((PAD_X, top + i * LINE_HEIGHT), text, font=font, fill=TEXT)
    return out


def shared_palette(frames: list[Image.Image], colours: int) -> Image.Image:
    """Quantize a contact sheet of the frames, with the interface colours given enough weight to survive."""
    stride = max(1, len(frames) // 12)
    sample = frames[::stride]
    w, h = frames[0].size
    tile_w, tile_h = w // 2, h // 2
    swatch_h = 40
    sheet = Image.new("RGB", (tile_w * 4, tile_h * (len(sample) // 4 + 1) + swatch_h))
    for i, f in enumerate(sample):
        sheet.paste(f.resize((tile_w, tile_h), Image.Resampling.NEAREST), ((i % 4) * tile_w, (i // 4) * tile_h))
    step = sheet.width // len(SWATCHES)
    draw = ImageDraw.Draw(sheet)
    for i, hex_colour in enumerate(SWATCHES):
        draw.rectangle([i * step, sheet.height - swatch_h, (i + 1) * step, sheet.height], fill=hex_colour)
    return sheet.quantize(colors=colours, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)


def build(frames: list[Image.Image], holds: list[int], path: Path, colours: int) -> int:
    palette = shared_palette(frames, colours)
    out: list[Image.Image] = []
    durations: list[int] = []
    last = None
    for frame, hold in zip(frames, holds):
        q = frame.quantize(palette=palette, dither=Image.Dither.NONE)
        data = q.tobytes()
        if data == last:
            durations[-1] += hold
            continue
        out.append(q)
        durations.append(hold)
        last = data
    out[0].save(path, save_all=True, append_images=out[1:], duration=durations, loop=0, optimize=False, disposal=1)
    return path.stat().st_size


def main() -> int:
    frames_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    names = sys.argv[3:] or sorted(p.name for p in frames_dir.iterdir() if (p / "manifest.json").exists())
    out_dir.mkdir(parents=True, exist_ok=True)
    font = load_font()
    total = 0
    for name in names:
        manifest = json.loads((frames_dir / name / "manifest.json").read_text())
        frames = [with_caption(frames_dir / name / m["file"], m["caption"], font) for m in manifest]
        holds = [m["hold_ms"] for m in manifest]
        path = out_dir / f"{name}.gif"
        for colours in COLOUR_STEPS:
            size = build(frames, holds, path, colours)
            if size <= MAX_BYTES:
                break
        else:
            raise SystemExit(f"{name} is {size / 1e6:.1f} MB at {COLOUR_STEPS[-1]} colours, over the limit.")
        total += size
        print(f"{path.name}: {size / 1024 / 1024:.2f} MB, {len(frames)} frames, {colours} colours, {sum(holds) / 1000:.0f} s")
    print(f"total: {total / 1024 / 1024:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
