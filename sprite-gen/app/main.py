from fastapi import FastAPI
from .config import settings

app = FastAPI(title="something2 sprite-gen")

@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": settings.device,
        "default_backend": settings.default_backend,
    }
