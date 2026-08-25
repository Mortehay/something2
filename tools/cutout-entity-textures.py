#!/usr/bin/env python3
"""Key the flat backdrop out of the exported entity art, leaving transparency.

WHY THIS IS NOT OPTIONAL. A tile fills its diamond, so a rectangular texture is
exactly right. An entity is a SILHOUETTE standing on whatever tile it occupies,
so the generated backdrop has to go -- without this, a tree renders as a tree
inside an opaque white square, which is worse than the coloured rectangle it
replaces. sprite-gen does this locally in postproc.cutout_background(); the
remote provider path stores whatever the service returned, so the step has to
happen somewhere and here is the only place that sees the pixels.

The generation prompt asks for a flat MAGENTA backdrop for exactly this
reason, and the two halves are one contract -- see BACKDROP in
backend/scripts/generate-entity-textures.js. Magenta rather than the white
sprite-gen uses locally, because this catalog is full of pale subjects: keying
white punches holes through ice boulders, bone and snow-covered rock.

HOW IT DECIDES. Flood fill from the four corners rather than "delete every
pixel near the key colour": a global test eats matching highlights inside the
subject, and those holes are far more obvious than a slightly ragged edge.
Only backdrop connected to the frame edge is removed, so an enclosed region
that happens to match survives.

Alpha is feathered by one pixel at the boundary so the cutout does not read as
a sticker with a hard edge over the ground beneath it.
"""

import argparse
import json
import os
import sys
from collections import deque

try:
    from PIL import Image, ImageFilter
except ImportError:                                          # pragma: no cover
    sys.exit("Pillow is required: pip install --user Pillow")

DEFAULT_DIR = os.path.join(os.path.dirname(__file__), '..', 'backend', 'seeds', 'textures', 'entities')
MANIFEST = os.path.join(os.path.dirname(__file__), '..', 'backend', 'seeds', 'textures', 'entities.json')


def near(a, b, tol):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol and abs(a[2] - b[2]) <= tol


def despill(px, w, h, mask, backdrop, strength=0.8):
    """Pull the backdrop's colour out of the pixels that survived next to it.

    A keyed edge keeps a rim of the backdrop colour -- with magenta that reads
    as a bright pink halo around every tree, which is more obvious on grass
    than the white box this replaced. For each kept pixel, any channel running
    ahead of the others in the backdrop's direction is pulled back toward them.
    """
    br, bg, bb = backdrop
    dominant = max(range(3), key=lambda i: backdrop[i])
    for y in range(h):
        for x in range(w):
            a = mask.getpixel((x, y))
            if a == 0 or a == 255:
                continue                       # fully out, or well inside
            r, g, b = px[x, y]
            other = (g + b) / 2 if dominant == 0 else (r + b) / 2 if dominant == 1 else (r + g) / 2
            chan = (r, g, b)[dominant]
            if chan > other:
                pulled = int(chan - (chan - other) * strength)
                rgb = list((r, g, b))
                rgb[dominant] = pulled
                px[x, y] = tuple(rgb)


def flood_from_border(px, w, h, mask, tol):
    """Remove one connected layer of border colour. Returns (removed, backdrop)."""
    # The colour to key is whatever dominates the pixels that are STILL opaque
    # on the frame edge, re-sampled every pass. That is what lets this peel a
    # picture frame and then the backdrop inside it: after the frame goes, the
    # border is made of backdrop.
    ring = []
    for x in range(w):
        for y in (0, h - 1):
            if mask.getpixel((x, y)):
                ring.append(px[x, y])
    for y in range(h):
        for x in (0, w - 1):
            if mask.getpixel((x, y)):
                ring.append(px[x, y])
    if not ring:
        return 0, (255, 0, 255)

    # SEVERAL key colours, not one. The backgrounds this has to remove are
    # frequently a CHECKERBOARD or a two-tone grid -- the model's idea of
    # "transparent" -- and a single-colour key can only take one square of it,
    # then stops at the first square of the other colour and leaves the rest.
    # Keying the most common few border colours together lets the fill cross
    # the whole pattern.
    counts = {}
    for c in ring:
        counts[c] = counts.get(c, 0) + 1
    ranked = sorted(counts, key=counts.get, reverse=True)
    keys = []
    for c in ranked:
        if counts[c] < len(ring) * 0.04:      # ignore stray subject pixels
            break
        if any(near(c, k, 24) for k in keys):  # already covered by a chosen key
            continue
        keys.append(c)
        if len(keys) == 3:
            break
    # A border with no colour above the threshold is a noisy or gradient one.
    # Falling back to the single most common pixel keeps this useful there
    # instead of crashing, which is what the empty list used to do.
    if not keys:
        keys = [ranked[0]]
    backdrop = keys[0]

    removed = 0
    seen = bytearray(w * h)
    queue = deque()
    for x in range(w):
        queue.append((x, 0))
        queue.append((x, h - 1))
    for y in range(h):
        queue.append((0, y))
        queue.append((w - 1, y))
    while queue:
        x, y = queue.popleft()
        idx = y * w + x
        if seen[idx]:
            continue
        seen[idx] = 1
        if mask.getpixel((x, y)) == 0:
            # Already transparent: keep walking THROUGH it, so a later pass can
            # reach the backdrop sitting behind a frame that has been removed.
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    queue.append((nx, ny))
            continue
        if not any(near(px[x, y], k, tol) for k in keys):
            continue
        mask.putpixel((x, y), 0)
        removed += 1
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h:
                queue.append((nx, ny))
    return removed, backdrop


def cutout(img, tol=60, feather=1, passes=8):
    """Peel the background away layer by layer, then crop to what is left.

    ONE FLOOD FILL IS NOT ENOUGH, which is the whole reason this is iterative.
    This model persistently draws the subject as framed art: a border, then a
    mat, then the backdrop, then the object. A single corner-sampled fill eats
    the outermost band and stops, leaving the subject inside a box -- which is
    precisely the "white cover over the entity" this is meant to remove. Each
    pass re-samples whatever is now on the border and takes that layer too.

    It stops early when a pass removes almost nothing, so a clean image is not
    chewed further.
    """
    img = img.convert('RGB')
    w, h = img.size
    px = img.load()
    mask = Image.new('L', (w, h), 255)

    backdrop = (255, 0, 255)
    for _ in range(passes):
        removed, backdrop = flood_from_border(px, w, h, mask, tol)
        if removed < (w * h) * 0.002:          # nothing meaningful left to peel
            break

    if feather:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    despill(px, w, h, mask, backdrop)
    out = img.convert('RGBA')
    out.putalpha(mask)

    # Crop to the subject and re-centre it. Without this a sprite keeps
    # whatever margin the generator felt like leaving, and since
    # display_width/display_height scale the WHOLE image, two props drawn with
    # different margins render at visibly different sizes for no reason.
    box = out.getbbox()
    if box:
        sub = out.crop(box)
        side = max(sub.size)
        square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
        square.paste(sub, ((side - sub.size[0]) // 2, (side - sub.size[1]) // 2))
        # Kept at the SUBJECT's own resolution, never scaled back up to the
        # canvas it was drawn on. A concept generator centres a small object in
        # a large frame, so restoring the original size would upscale a ~70px
        # boulder to 512 and turn crisp pixel art into blur. The renderer
        # scales to display_width/display_height regardless, so the only thing
        # an upscale here buys is lost detail.
        out = square
    return out


def border_opacity(img):
    """How much of the outer ring is still opaque. 0 means a clean cutout.

    This is the acceptance test, not a diagnostic. "The background is gone" is
    exactly the claim that the frame of the image is transparent, and checking
    it directly is what stops a subject-in-a-box shipping as finished art.
    """
    a = img.getchannel('A')
    w, h = img.size
    ring = []
    for x in range(w):
        ring.append(a.getpixel((x, 0)))
        ring.append(a.getpixel((x, h - 1)))
    for y in range(h):
        ring.append(a.getpixel((0, y)))
        ring.append(a.getpixel((w - 1, y)))
    return sum(1 for v in ring if v > 16) / float(len(ring))


def cutout_until_clean(img, feather=1):
    """Escalate the key tolerance until the border really is transparent.

    One fixed tolerance cannot serve every image: a flat backdrop keys at 40, a
    dithered or lightly shaded one needs 100+, and using the high value
    everywhere eats subjects that share a tone with their backdrop. So this
    walks up and stops at the first result that both clears the border AND
    keeps a plausible amount of subject.
    """
    best = None
    for tol in (40, 60, 80, 100, 130, 160):
        out = cutout(img, tol=tol, feather=feather)
        cov = coverage(out)
        border = border_opacity(out)
        if best is None or (border, -cov) < (best[1], -best[2]):
            best = (out, border, cov, tol)
        # A subject under 3% is a sprite that has been erased, not cut out.
        if border <= 0.02 and cov >= 0.03:
            return out, border, cov, tol
    return best


def coverage(img):
    """Fraction of the image that survived, as a sanity number."""
    alpha = img.getchannel('A')
    return sum(alpha.histogram()[128:]) / float(img.size[0] * img.size[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=DEFAULT_DIR)
    ap.add_argument('--tol', type=int, default=60)
    ap.add_argument('--feather', type=int, default=1)
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    names = sorted(f for f in os.listdir(args.dir) if f.endswith('.png'))
    if not names:
        sys.exit(f'no PNGs in {args.dir} -- run `make entities-export` first')

    manifest = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else []
    if [m for m in manifest if m.get('cutout')] and not args.check and not args.force:
        sys.exit('these were already cut out; re-running would eat the feathered edge.\n'
                 'Regenerate and re-export first, or pass FORCE=1.')

    suspicious = []
    for name in names:
        path = os.path.join(args.dir, name)
        img = Image.open(path)
        if args.check:
            if img.mode == 'RGBA':
                print(f'  {name[:-4]}: already RGBA, {coverage(img) * 100:.0f}% opaque')
            else:
                print(f'  {name[:-4]}: opaque {img.mode}')
            continue
        out, border, cov, tol = cutout_until_clean(img, args.feather)
        out.save(path)
        # Two failure shapes worth naming rather than silently shipping: almost
        # nothing removed (the backdrop was not flat, so the subject is still
        # in a box) and almost everything removed (the subject was the same
        # colour as its backdrop and has been erased).
        # The border test is the one that matters; coverage only catches the
        # opposite failure, a subject erased along with its backdrop.
        if border > 0.02 or cov < 0.03:
            suspicious.append((name[:-4], cov, border))
        print(f'  {name[:-4]}: {cov * 100:.0f}% subject, border {border * 100:.1f}% opaque (tol {tol})')

    if not args.check and manifest:
        for entry in manifest:
            entry['cutout'] = True
        with open(MANIFEST, 'w') as fh:
            json.dump(manifest, fh, indent=2)
            fh.write('\n')

    if suspicious:
        print('\nNOT TRANSPARENT -- these still carry a background:')
        for nm, cov, border in suspicious:
            what = 'subject erased' if cov < 0.03 else f'{border * 100:.0f}% of the border is opaque'
            print(f'  {nm}: {what}')
        # Loud and non-zero: seeding these would put a box behind every prop,
        # and a warning nobody reads is how that ships.
        sys.exit(1)


if __name__ == '__main__':
    main()
