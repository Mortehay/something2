#!/usr/bin/env python3
"""How much of its own canvas does a generated sprite actually occupy?

SOMET-561. Written to settle one question with numbers instead of impressions:
entity art was rendering small and offset inside its footprint, and the two
available explanations -- "the generator draws the subject badly" and "the
generator leaves margin around a fine subject" -- call for completely
different fixes.

WHY THE ANSWER MATTERS MORE THAN IT LOOKS. RenderSystem.drawCreature blits with
the 5-argument drawImage(img, x, y, w, h), which stretches the WHOLE image --
transparent margin included -- into the entity's display box. So a subject
occupying 30% of its canvas width renders at 30% of the width it was authored
for. The margin is not cosmetic; it is a scale error.

WHAT IT MEASURES. The bounding box of pixels with alpha > 16, against the
canvas. The threshold is not decoration: a feathered cutout leaves alpha=1
speckles in the corners, and at alpha > 0 those speckles drag the bbox out to
the full canvas, so every image reads as perfectly tight and the measurement
silently answers "nothing to fix". 16 is the same cut
tools/cutout-entity-textures.py's border_opacity() already uses.

Two numbers per image, and they answer different questions:
  fill%  -- how much of the canvas the subject spans. Low = renders too small.
  asym   -- the gap between opposite margins. High = subject shoved to one side.
An image can be centred and still badly undersized (fill 12%, asym 0), which is
the common remote-provider case, so neither number alone is enough.

Usage:  python3 tools/measure-art-margin.py <file.png> [more.png ...]
"""
import sys
import os
from PIL import Image

ALPHA_THRESHOLD = 16
TIGHT_PCT = 97.0        # what counts as "already trimmed" on both axes


def measure(path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    mask = im.getchannel("A").point(lambda v: 255 if v > ALPHA_THRESHOLD else 0)
    box = mask.getbbox()
    if not box:
        return {"path": path, "w": w, "h": h, "empty": True}
    left, top, right, bottom = box
    return {
        "path": path, "w": w, "h": h, "empty": False,
        "cw": right - left, "ch": bottom - top,
        "ml": 100.0 * left / w, "mr": 100.0 * (w - right) / w,
        "mt": 100.0 * top / h, "mb": 100.0 * (h - bottom) / h,
        "fill_w": 100.0 * (right - left) / w,
        "fill_h": 100.0 * (bottom - top) / h,
    }


def main(paths):
    rows = []
    for p in paths:
        try:
            rows.append(measure(p))
        except Exception as exc:                      # noqa: BLE001 - report and continue
            print(f"ERR {p}: {exc}")

    header = (f"{'name':28} {'canvas':>10} {'content':>10} {'fillW%':>7} "
              f"{'fillH%':>7} {'L%':>6} {'R%':>6} {'T%':>6} {'B%':>6}")
    print(header)
    for r in rows:
        name = os.path.basename(r["path"])[:28]
        if r.get("empty"):
            print(f"{name:28} {r['w']}x{r['h']}  FULLY TRANSPARENT")
            continue
        canvas = f"{r['w']}x{r['h']}"
        content = f"{r['cw']}x{r['ch']}"
        print(f"{name:28} {canvas:>10} {content:>10} {r['fill_w']:7.1f} "
              f"{r['fill_h']:7.1f} {r['ml']:6.1f} {r['mr']:6.1f} "
              f"{r['mt']:6.1f} {r['mb']:6.1f}")

    good = [r for r in rows if not r.get("empty")]
    if not good:
        return
    n = len(good)
    tight = sum(1 for r in good
                if r["fill_w"] > TIGHT_PCT and r["fill_h"] > TIGHT_PCT)
    asym = [max(abs(r["ml"] - r["mr"]), abs(r["mt"] - r["mb"])) for r in good]
    print(f"\nN={n}")
    print(f"  mean fill  W={sum(r['fill_w'] for r in good) / n:.1f}%  "
          f"H={sum(r['fill_h'] for r in good) / n:.1f}%")
    print(f"  already tight (both fills >{TIGHT_PCT:.0f}%): {tight}/{n}")
    print(f"  mean off-centre asymmetry: {sum(asym) / n:.1f} pct-pts, "
          f"max {max(asym):.1f}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1:])
