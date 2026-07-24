from typing import Protocol, Optional, Tuple
from PIL import Image


def seeded_generator(seed: int, device: str):
    """Build a torch.Generator deterministically seeded for reproducible
    per-frame output, or None if torch is unavailable.

    F-036/SOMET-216: this exact construction (and this exact narrow except
    clause) used to be duplicated independently in sd15.py, sd_turbo.py, and
    sdxl.py's generate() methods. Confirmed byte-identical across all three
    before consolidating here — a fix to the exception handling applied to
    only one copy would otherwise silently miss the others.

    torch is a hard requirement in production (see requirements.txt); the
    ModuleNotFoundError fallback only triggers when a backend's pipeline
    builder is monkeypatched in tests and torch itself is absent from the
    test environment.
    """
    try:
        import torch
        return torch.Generator(device=device).manual_seed(seed)
    except ModuleNotFoundError:
        return None


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
