import hashlib
from typing import Optional, Tuple
from PIL import Image

class StubBackend:
    name = "stub"

    def generate(self, prompt: str, pose: Optional[Image.Image], seed: int,
                 steps: int, size: Tuple[int, int]) -> Image.Image:
        # Deterministic placeholder: color from hash(prompt, seed); a filled
        # disc on transparent bg so downstream crop/atlas has real alpha.
        h = hashlib.sha256(f"{prompt}|{seed}".encode()).digest()
        color = (h[0], h[1], h[2], 255)
        w, hgt = size
        img = Image.new("RGBA", size, (0, 0, 0, 0))
        from PIL import ImageDraw
        d = ImageDraw.Draw(img)
        r = min(w, hgt) // 3
        cx, cy = w // 2, hgt // 2
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
        return img
