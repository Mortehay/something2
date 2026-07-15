import os
from dataclasses import dataclass, field

from .recipe import recipe_for


def detect_device() -> str:
    """Resolve the compute device.

    An explicit DEVICE env var always wins (the manual switch documented in
    local-ai-dev). When it is unset we auto-detect: 'cuda' if a CUDA GPU is
    visible, else 'cpu'. torch is imported lazily and any failure (torch not
    installed, driver error) degrades to 'cpu' — the service must never crash
    just because it cannot see a GPU.
    """
    explicit = os.getenv("DEVICE")
    if explicit:
        return explicit
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def build_capability(device: str) -> dict:
    """Describe what the detected hardware can do, for the Node bridge / UI.

    tier is the coarse switch consumers branch on: 'gpu' unlocks the
    high-fidelity recipe (ControlNet, more steps, SDXL), 'cpu' runs a lighter,
    slower recipe. recommended_backend mirrors the tier recipe so the UI hint
    and actual generation agree.
    """
    cuda = device == "cuda"
    tier = "gpu" if cuda else "cpu"
    return {
        "device": device,
        "cuda": cuda,
        "tier": tier,
        "recommended_backend": recipe_for(tier).backend,
    }


@dataclass(frozen=True)
class Settings:
    device: str = field(default_factory=detect_device)
    default_backend: str = os.getenv("SPRITE_BACKEND", "stub")
    n_frames: int = int(os.getenv("N_FRAMES", "4"))
    minio_endpoint: str = os.getenv("MINIO_ENDPOINT", "minio:9000")
    minio_access_key: str = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
    minio_secret_key: str = os.getenv("MINIO_SECRET_KEY", "minioadmin")
    minio_bucket: str = os.getenv("MINIO_BUCKET", "sprites")
    minio_secure: bool = os.getenv("MINIO_SECURE", "false").lower() == "true"

    def capability(self) -> dict:
        return build_capability(self.device)

settings = Settings()
DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
