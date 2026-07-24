import math
from typing import Dict, Tuple
from PIL import Image

def _rembg(img: Image.Image):
    """Matte the subject with rembg, or None when it isn't usable.

    rembg is an optional heavy dep and imports fine while its onnxruntime
    backend is missing, so a failure here is normal — callers must have a
    fallback, not assume this ran.
    """
    try:
        import rembg  # heavy, optional
        import io
        buf = io.BytesIO()
        img.convert("RGBA").save(buf, format="PNG")
        out = rembg.remove(buf.getvalue())
        return Image.open(io.BytesIO(out)).convert("RGBA")
    except Exception:
        return None

def remove_background(img: Image.Image, matting: str = "auto") -> Image.Image:
    """Background removal for ENTITIES — they must never render a backdrop.

    matting="auto"   rembg (real subject matting), falling back to the border
                     flood-fill when its runtime is missing.
    matting="cutout" flood-fill only. For synthetic backends (stub) whose
                     backdrop is already one flat tone: the flood-fill is exact
                     there and instant, where u2net inference costs seconds a
                     frame for an identical result.

    Deliberately never uses key_near_white()'s global near-white key, which
    also eats white pixels inside the subject and leaves sprites full of holes.
    """
    if matting != "cutout":
        matted = _rembg(img)
        if matted is not None:
            return matted
    return cutout_background(img)

def key_near_white(img: Image.Image) -> Image.Image:
    """Clear near-white pixels. Nothing else.

    This is what TILES get. A tile is the ground itself, so it must never go
    through subject matting — rembg would cut a "subject" out of a grass
    texture and leave a hole in the world. It also stays deliberately cheap:
    tiles are generated in bulk.
    """
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r > 240 and g > 240 and b > 240:
                px[x, y] = (r, g, b, 0)
    return img

def cutout_background(img: Image.Image, tolerance: int = 48) -> Image.Image:
    """Clear the background of a sprite so only the subject stays opaque.

    Entities must never render with a filled backdrop, and key_near_white()
    alone does not guarantee that: rembg is optional (it silently falls back
    when onnxruntime is absent) and the fallback only clears near-WHITE pixels,
    while a diffusion backend happily paints a grey/green/blue "plain
    background".

    So flood-fill inward from the image border, clearing every pixel close to
    the background colour. Seeding from the border is what makes this safe —
    a light patch INSIDE the subject (a tooth, an eye) is never reached, so it
    stays opaque, which a global colour-distance threshold would punch out.

    Not used for tiles: a ground tile is meant to be fully opaque.
    """
    img = img.convert("RGBA")
    w, h = img.size
    if w == 0 or h == 0:
        return img
    px = img.load()

    # Background colour = the most common border pixel. The border is nearly
    # all background by construction ("subject centered, isolated"), so the
    # mode is more robust than a single corner sample.
    counts = {}
    border = []
    for x in range(w):
        border.append((x, 0)); border.append((x, h - 1))
    for y in range(h):
        border.append((0, y)); border.append((w - 1, y))
    for x, y in border:
        r, g, b, a = px[x, y]
        if a == 0:
            continue
        key = (r // 8, g // 8, b // 8)
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return img  # already fully transparent at the edges
    bg = max(counts, key=counts.get)
    br, bg_, bb = bg[0] * 8 + 4, bg[1] * 8 + 4, bg[2] * 8 + 4

    def is_bg(x, y):
        r, g, b, a = px[x, y]
        if a == 0:
            return True
        return abs(r - br) <= tolerance and abs(g - bg_) <= tolerance and abs(b - bb) <= tolerance

    seen = bytearray(w * h)
    stack = [(x, y) for x, y in border if is_bg(x, y)]
    for x, y in stack:
        seen[y * w + x] = 1
    while stack:
        x, y = stack.pop()
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_bg(nx, ny):
                seen[ny * w + nx] = 1
                stack.append((nx, ny))
    return img

def crop_to_content(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    bbox = img.split()[3].getbbox()  # alpha channel bbox
    return img.crop(bbox) if bbox else img

def pack_atlas(frames: Dict[str, Image.Image]) -> Tuple[Image.Image, dict]:
    if not frames:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0)), {"cell": [0, 0], "frames": {}}
    cell_w = max(f.width for f in frames.values())
    cell_h = max(f.height for f in frames.values())
    keys = sorted(frames.keys())
    cols = math.ceil(math.sqrt(len(keys)))
    rows = math.ceil(len(keys) / cols)
    sheet = Image.new("RGBA", (cols * cell_w, rows * cell_h), (0, 0, 0, 0))
    manifest = {"cell": [cell_w, cell_h], "frames": {}}
    for i, key in enumerate(keys):
        cx = (i % cols) * cell_w
        cy = (i // cols) * cell_h
        sheet.paste(frames[key], (cx, cy))
        manifest["frames"][key] = [cx, cy, frames[key].width, frames[key].height]
    return sheet, manifest
