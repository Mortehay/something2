import math
from typing import Tuple
from PIL import Image, ImageDraw

# 8 iso facings -> a screen-space heading angle (radians), for limb orientation.
_DIR_ANGLE = {
    "S": math.pi / 2, "SE": math.pi / 4, "E": 0.0, "NE": -math.pi / 4,
    "N": -math.pi / 2, "NW": -3 * math.pi / 4, "W": math.pi, "SW": 3 * math.pi / 4,
}

def pose_for(direction: str, frame: int, size: Tuple[int, int]) -> Image.Image:
    """A simple deterministic openpose-like skeleton. Not anatomically perfect —
    enough to give ControlNet a consistent pose per (direction, frame) so all
    frames of a creature read as the same character walking."""
    w, h = size
    img = Image.new("RGB", size, (0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = w // 2
    top = int(h * 0.18)
    hip = int(h * 0.55)
    ang = _DIR_ANGLE.get(direction, math.pi / 2)

    # Spine + head
    d.ellipse([cx - w // 12, top - h // 12, cx + w // 12, top + h // 12], outline=(255, 255, 0), width=2)
    d.line([cx, top + h // 12, cx, hip], fill=(0, 255, 0), width=3)

    # Legs swing by frame (walk cycle): phase alternates.
    swing = math.sin(frame / max(1, 4) * 2 * math.pi) * (w * 0.12)
    foot_y = int(h * 0.92)
    d.line([cx, hip, cx - int(swing), foot_y], fill=(0, 128, 255), width=3)
    d.line([cx, hip, cx + int(swing), foot_y], fill=(255, 0, 255), width=3)

    # Arms rotate slightly with heading so direction visibly differs.
    arm_y = int(h * 0.4)
    ax = int(math.sin(ang) * w * 0.18)
    d.line([cx, arm_y, cx - ax, arm_y + int(swing)], fill=(255, 128, 0), width=2)
    d.line([cx, arm_y, cx + ax, arm_y - int(swing)], fill=(128, 255, 0), width=2)
    return img
