# Autotrim on the GPU box — handoff spec

**For:** the Claude session opened in Antigravity **on the desktop GPU box**
(the machine serving `192.168.0.217:8001`).
**From:** something2, SOMET-566 (parent SOMET-560).
**Status:** our half is done and merged-ready. This is the optional half at the source.

---

## The one-sentence change

After the cutout, crop the image to the bounding box of pixels with **alpha ≥ 16**,
then pad back out by **3% of each axis** (minimum 1px per side), keeping the
subject at its own resolution. Never upscale. Never do this to a tile.

---

## Why you are being asked

Generated entity art renders small and off-centre in the game.

The cause is not the model and not the prompt. `RenderSystem.drawCreature` blits with
the five-argument `drawImage(img, x, y, w, h)`, which stretches the **whole image** —
transparent margin included — into the entity's display box. So a subject occupying
30% of its canvas renders at 30% of the width it was authored for. **The margin is a
scale error, not a cosmetic one.**

Measured on 2026-09-10 (`tools/measure-art-margin.py`, alpha ≥ 16 bbox against canvas):

| source | mean fill W | mean fill H | already tight |
|---|---|---|---|
| **this box** (`sprites/objects/rmt_*`, 11 newest) | **30.4%** | 54.4% | **0 / 11** |
| local sprite-gen | 89.3% | 90.4% | — |
| checked-in seeds | 80.9% | 91.5% | 38 / 300 |
| tiles (control) | 100% | 100% | 50 / 50 |

Worst single case: `archmage_staff` spans **11.8%** of its canvas width — a 1024px
image carrying a 121px subject. Several are also genuinely off-centre rather than
merely padded: `darts` sits 11.3% from the top and 31.2% from the bottom.

So this box does not crop, and the local generator does. That gap is the whole defect.

## You are not a dependency

The something2 backend now trims **whatever arrives**, from any provider
(`backend/src/services/pngTrim.js`, wired in `remoteImageProvider.js`). The game is
already fixed without you.

Doing it here is still worth it for two reasons: you have the alpha mask at full
fidelity before any re-encode, and cropping at the source cuts the bytes on the wire.
But nothing breaks if this change is never made, and **nothing breaks if you make it
either** — our trim is idempotent and will simply report `ratio 1.0`.

---

## The rule, precisely

```python
CONTENT_ALPHA   = 16     # a pixel counts as content at alpha >= 16
TRIM_MARGIN_PCT = 3.0    # per axis, each side, minimum 1px

def trim_to_content(img):                     # img is RGBA, post-cutout
    alpha = img.getchannel("A")
    bbox = alpha.point(lambda v: 255 if v >= CONTENT_ALPHA else 0).getbbox()
    if not bbox:
        return img                            # nothing to centre on; leave it
    sub = img.crop(bbox)
    mx = max(1, round(sub.width  * TRIM_MARGIN_PCT / 100))
    my = max(1, round(sub.height * TRIM_MARGIN_PCT / 100))
    out = Image.new("RGBA", (sub.width + mx * 2, sub.height + my * 2), (0, 0, 0, 0))
    out.paste(sub, (mx, my))
    return out
```

### Three details that are load-bearing, each learned the hard way

**1. `alpha >= 16`, never a bare `getbbox()`.**
`Image.getbbox()` on an alpha channel is an `alpha > 0` test. A feathered cutout leaves
alpha-1 and alpha-2 speckles in the corners, and one such pixel drags the bounding box
out to the full canvas — so the crop becomes a **silent no-op that still reports
success**. Both real images we kept as test fixtures carry such speckles: dropping the
floor to 1 turns two of our tests red, which is how we know. 16 is the same cut
`border_opacity()` already uses in our cutout tool.

**2. The margin is per axis, not a uniform count off the longer side.**
We implemented it the uniform way first and the tests caught it. A staff 32px wide and
216px tall takes a 6px margin off its height; applying those same 6px across gives a
44px-wide canvas holding a 32px subject — 95% filled vertically, 73% horizontally. The
renderer stretches that canvas into the display box and the staff comes out **fat**.
Per-axis keeps `out.width : out.height` equal to `content.width : content.height`, so
proportions survive `drawImage`.

**3. Never upscale back to the original canvas.**
The subject keeps the resolution it was drawn at. Restoring a 121px staff to 1024px
turns crisp art into blur, and buys nothing: the renderer rescales to
`display_width`/`display_height` regardless.

### Do not trim tiles

A ground tile is the terrain itself — full-bleed and meant to be opaque. It has no
subject to crop to, and a tile with a transparent border is a **seam in the world**.
Gate on the request's kind, not on whether the image happens to have alpha.

### Do not touch the backdrop wording

The magenta backdrop is a **contract**, not styling. `tools/cutout-entity-textures.py`
on our side expects it exactly as it is; white keys holes through pale subjects (ice,
bone, snow, marble). Changing the wording breaks transparency silently. This change is
strictly post-cutout — it must not touch prompt construction.

---

## How to tell it worked

Generate one object and measure it. On our side the same check is one command:

```
python3 tools/measure-art-margin.py <image.png>
```

Expect `fillW%` and `fillH%` both around **94** (3% margin each side), and the two
opposite margins within a pixel of each other. Before this change the same command
reports fills in the 12–55% range.

The end-to-end signal, visible from our side without asking you: the backend's job
result carries `trim_ratio`. Once this box crops, newly generated images arrive already
tight and that field reads **1.0** — nothing left for us to trim.

---

## What "done" is not

Do not judge this by whether the image *looks* better. Every failure this project has
had in this area passed a visual sniff test: a five-tree image cut out perfectly, a
scene on an unkeyed backdrop that was 90% transparent, a lattice that was structurally
flawless and semantically wrong. **Measure the bounding box.** That number is the
acceptance test.
