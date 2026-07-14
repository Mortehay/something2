import math
from typing import Dict, Tuple
from PIL import Image

def to_transparent(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    try:
        import rembg  # heavy, optional
        import io
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out = rembg.remove(buf.getvalue())
        return Image.open(io.BytesIO(out)).convert("RGBA")
    except Exception:
        # Fallback: make near-white pixels transparent (good enough for the
        # stub/plain-background prompts; real backends use rembg when installed).
        px = img.load()
        w, h = img.size
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if r > 240 and g > 240 and b > 240:
                    px[x, y] = (r, g, b, 0)
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
