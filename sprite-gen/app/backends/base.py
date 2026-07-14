from typing import Protocol, Optional, Tuple
from PIL import Image

class Backend(Protocol):
    name: str
    def generate(
        self,
        prompt: str,
        pose: Optional[Image.Image],
        seed: int,
        steps: int,
        size: Tuple[int, int],
    ) -> Image.Image:
        """Return an RGBA image of exactly `size`."""
        ...
