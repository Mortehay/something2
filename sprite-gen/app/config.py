import os
from dataclasses import dataclass

@dataclass(frozen=True)
class Settings:
    device: str = os.getenv("DEVICE", "cpu")
    default_backend: str = os.getenv("SPRITE_BACKEND", "stub")
    n_frames: int = int(os.getenv("N_FRAMES", "4"))
    minio_endpoint: str = os.getenv("MINIO_ENDPOINT", "minio:9000")
    minio_access_key: str = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
    minio_secret_key: str = os.getenv("MINIO_SECRET_KEY", "minioadmin")
    minio_bucket: str = os.getenv("MINIO_BUCKET", "sprites")
    minio_secure: bool = os.getenv("MINIO_SECURE", "false").lower() == "true"

settings = Settings()
DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
