#!/usr/bin/env python3
"""Make the exported tile textures tile seamlessly against themselves.

WHY THIS IS NEEDED. A generated texture has arbitrary edges, so two adjacent
tiles of the same type meet at a visible seam and a field of grass reads as a
grid of stamps. Nothing upstream fixes it: the provider's txt2img API has no
`tiling` parameter (A1111 does seamless generation with circular padding in
the conv layers, and this service does not expose it), and asking for it in
words actively backfires -- "seamless", "tileable" and "repeating pattern"
were measured producing stripes and sheets of separate assets, not a
continuous surface.

WHY PLAIN WRAP-SEAMLESSNESS IS THE RIGHT PROPERTY, even though tiles are
diamonds. systems/tileTexture.js stretches the whole square into the iso
diamond, and a tile's on-screen neighbour is drawn at exactly a half-tile
offset (+W/2, +H/2). So the pixel just across a shared diamond edge is the
same texture sampled at (x - W/2, y - H/2). A texture that is continuous under
wraparound is therefore continuous across every diamond edge; there is no
separate "diamond-seamless" property to chase.

THE METHOD is offset-and-heal, not mirror-fold. Wrapping the image by half its
size moves the four outer edges into the middle, where they form a cross-shaped
seam, and leaves the NEW outer edges as two formerly-adjacent interior columns
-- which match by construction. The cross is then healed by blending the
un-offset image back in over a feathered band, since the original is
continuous exactly where the offset copy is broken.

A whole-image cross-fade with a mirrored copy would also produce matching
edges, and is rejected on purpose: it ghosts the entire texture and imposes a
kaleidoscope symmetry over every tile. This ghosts only near the healed cross.

Idempotent-ish but not free: re-running blurs the band a second time. Run it
once after `make tiles-export`.
"""

import argparse
import json
import os
import sys

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat
except ImportError:                                          # pragma: no cover
    sys.exit("Pillow is required: pip install --user Pillow")

DEFAULT_DIR = os.path.join(os.path.dirname(__file__), '..', 'backend', 'seeds', 'textures', 'tiles')
MANIFEST = os.path.join(os.path.dirname(__file__), '..', 'backend', 'seeds', 'textures', 'tiles.json')


def wrap_offset(img, dx, dy):
    """The image scrolled by (dx, dy) with wraparound."""
    w, h = img.size
    out = Image.new(img.mode, img.size)
    # Four quadrants, each pasted where it lands after scrolling.
    out.paste(img.crop((0, 0, w - dx, h - dy)), (dx, dy))
    out.paste(img.crop((w - dx, 0, w, h - dy)), (0, dy))
    out.paste(img.crop((0, h - dy, w - dx, h)), (dx, 0))
    out.paste(img.crop((w - dx, h - dy, w, h)), (0, 0))
    return out


def heal_mask(size, band, blur, margin=None):
    """White where the offset copy is trusted, black over the cross seam.

    The bands stop short of the border on purpose. Run all the way out and the
    healed strip puts UN-offset pixels on the outer edge, where the offset
    copy's matching edges were the entire point -- the left border would carry
    the original's left column and the right border the original's right one,
    which is the seam this is supposed to remove. Ending the cross inside a
    margin leaves a short unhealed stub at each border, and the diamond clip
    throws most of that away with the square's corners.
    """
    w, h = size
    if margin is None:
        margin = band + blur * 2
    mask = Image.new('L', size, 255)
    d = ImageDraw.Draw(mask)
    d.rectangle([w // 2 - band, margin, w // 2 + band, h - margin], fill=0)
    d.rectangle([margin, h // 2 - band, w - margin, h // 2 + band], fill=0)
    # Feathered, so the healed strip fades in instead of showing its own edges.
    return mask.filter(ImageFilter.GaussianBlur(blur))


def weld_edges(img, weld=12):
    """Force opposite borders to be pixel-identical, fading inward.

    Offset-and-heal leaves the outer edges as two formerly-ADJACENT columns of
    the original. Adjacent is close, not equal, and on a high-contrast texture
    -- mortar lines, hard pixel-art edges -- close still reads as a seam when
    the same tile repeats across a field.

    So the two borders are averaged into one shared column and blended back
    inward over `weld` pixels. After this the left column IS the right column
    and the top row IS the bottom row, which is the definition the renderer
    needs, at the cost of a slight smear in the outermost few pixels.

    A second full offset-heal pass was tried instead and measured WORSE (mean
    seam 7.7 -> 12.0): it blurs the whole band twice and moves an already-
    blended region onto the border.
    """
    w, h = img.size
    ramp = Image.linear_gradient('L')                    # 0 at top -> 255 at bottom

    # Horizontal: average column 0 with column w-1, then fade it in from both
    # sides so only the border strip is touched.
    shared_col = Image.blend(img.crop((0, 0, 1, h)), img.crop((w - 1, 0, w, h)), 0.5)
    band = shared_col.resize((weld, h))
    fade = ramp.rotate(90, expand=True).resize((weld, h))          # 255 at left -> 0 at right
    img.paste(Image.composite(band, img.crop((0, 0, weld, h)), fade), (0, 0))
    img.paste(Image.composite(img.crop((w - weld, 0, w, h)), band,
                              fade), (w - weld, 0))

    shared_row = Image.blend(img.crop((0, 0, w, 1)), img.crop((0, h - 1, w, h)), 0.5)
    band = shared_row.resize((w, weld))
    fade = ramp.resize((w, weld)).transpose(Image.FLIP_TOP_BOTTOM)  # 255 at top -> 0 down
    img.paste(Image.composite(band, img.crop((0, 0, w, weld)), fade), (0, 0))
    img.paste(Image.composite(img.crop((0, h - weld, w, h)), band, fade), (0, h - weld))
    return img


def make_seamless(img, band=48, blur=24, margin=None, weld=12):
    img = img.convert('RGB')
    w, h = img.size
    offset = wrap_offset(img, w // 2, h // 2)
    healed = Image.composite(offset, img, heal_mask((w, h), band, blur, margin))
    return weld_edges(healed, weld)


def shrink_and_repeat(img, times):
    """Halve (or third) the feature size by tiling a downscaled copy.

    THE SCALE PROBLEM. A tile diamond is ISO_TILE_W x ISO_TILE_H = 128x64, and
    the source texture is 512x512, so the renderer squashes it 4x across and 8x
    down. A generator draws a handful of large elements per image, which lands
    as three or four boulders filling one tile -- ground that reads as scenery.

    Repeating a downscaled copy N times across and down divides the apparent
    feature size by N and multiplies the count by N squared, which is what
    "ground" looks like. Doing it AFTER the seamless pass is what makes it
    free: a texture that already wraps tiles against itself, so the internal
    repeat seams are continuous too.

    The cost is honest and worth stating: the same elements now recur N^2
    times inside one tile, so an obviously unique feature becomes an obviously
    repeated one. N=2 is the safe default; N=3 starts to read as a pattern.
    """
    w, h = img.size
    small = img.resize((w // times, h // times), Image.LANCZOS)
    out = Image.new('RGB', (w, h))
    for y in range(times):
        for x in range(times):
            out.paste(small, (x * (w // times), y * (h // times)))
    return out


def seam_score(img):
    """Mean per-channel difference between the edges that will meet when tiled.

    0 is perfect. Compares the left column against the right and the top row
    against the bottom, which is exactly what wraparound puts side by side.
    """
    img = img.convert('RGB')
    w, h = img.size
    left, right = img.crop((0, 0, 1, h)), img.crop((w - 1, 0, w, h))
    top, bottom = img.crop((0, 0, w, 1)), img.crop((0, h - 1, w, h))
    horiz = ImageStat.Stat(ImageChops.difference(left, right)).mean
    vert = ImageStat.Stat(ImageChops.difference(top, bottom)).mean
    return (sum(horiz) / 3 + sum(vert) / 3) / 2


def preview(img, out_path, times=2):
    """Tile the texture times x times so a seam is visible if there is one."""
    w, h = img.size
    sheet = Image.new('RGB', (w * times, h * times))
    for y in range(times):
        for x in range(times):
            sheet.paste(img, (x * w, y * h))
    sheet.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=DEFAULT_DIR)
    ap.add_argument('--check', action='store_true', help='report seam scores, write nothing')
    ap.add_argument('--band', type=int, default=48)
    ap.add_argument('--blur', type=int, default=24)
    ap.add_argument('--weld', type=int, default=12)
    ap.add_argument('--force', action='store_true',
                    help='process even if the manifest says it was already done')
    ap.add_argument('--repeat', type=int, default=1,
                    help='shrink features by tiling an NxN downscaled copy (after seamless)')
    ap.add_argument('--preview', help='write a 2x2 tiled preview of this tile name')
    args = ap.parse_args()

    names = sorted(f for f in os.listdir(args.dir) if f.endswith('.png'))
    if not names:
        sys.exit(f'no PNGs in {args.dir} -- run `make tiles-export` first')

    # Refuse to process the same export twice.
    #
    # This is a real trap, not a theoretical one: `make tiles-seed` writes the
    # PROCESSED textures back into the object store, so the next
    # `make tiles-export` pulls those down and a second run heals, welds and
    # shrinks an already-healed, welded, shrunk image. The visible result is a
    # progressively blurrier, more repetitive tile and a file that keeps
    # getting smaller.
    #
    # The manifest is the interlock. Export rewrites it from the database with
    # no marker, so a fresh export always clears this; the marker below is
    # written only after a successful pass. To redo the processing, regenerate
    # and export again -- that is the honest reset, because the raw pixels are
    # what the pass needs.
    manifest = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else []
    already = [m['name'] for m in manifest if m.get('seamless')]
    if already and not args.check and not args.force:
        sys.exit(f'{len(already)} of these were already processed (e.g. {already[0]}).\n'
                 'Re-running compounds the blur. Regenerate and re-export first, '
                 'or pass FORCE=1 if you know the export is raw.')

    worst, total_before, total_after = [], 0.0, 0.0
    for name in names:
        path = os.path.join(args.dir, name)
        img = Image.open(path)
        before = seam_score(img)
        total_before += before
        if args.check:
            worst.append((before, name))
            continue
        out = make_seamless(img, args.band, args.blur, weld=args.weld)
        if args.repeat > 1:
            # Weld again afterwards: the downscale inside shrink_and_repeat
            # resamples the borders that weld_edges had just made identical,
            # which shows up as the seam score creeping back up (3.7 -> 5.2).
            out = weld_edges(shrink_and_repeat(out, args.repeat), args.weld)
        after = seam_score(out)
        total_after += after
        out.save(path)
        worst.append((after, name))
        print(f'  {name[:-4]}: seam {before:.1f} -> {after:.1f}')

    worst.sort(reverse=True)
    n = len(names)
    if args.check:
        print(f'{n} tiles, mean seam score {total_before / n:.1f}')
    else:
        print(f'{n} tiles, mean seam score {total_before / n:.1f} -> {total_after / n:.1f}')
    print('worst remaining: ' + ', '.join(f'{nm[:-4]} {sc:.1f}' for sc, nm in worst[:5]))

    if not args.check and manifest:
        for entry in manifest:
            entry['seamless'] = True
            entry['repeat'] = args.repeat
        with open(MANIFEST, 'w') as fh:
            json.dump(manifest, fh, indent=2)
            fh.write('\n')

    if args.preview:
        p = os.path.join(args.dir, f'{args.preview}.png')
        preview(Image.open(p), f'/tmp/{args.preview}-tiled.png')
        print(f'preview: /tmp/{args.preview}-tiled.png')


if __name__ == '__main__':
    main()
