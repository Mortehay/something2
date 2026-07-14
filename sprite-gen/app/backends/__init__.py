from .stub import StubBackend

# Lazy factories so heavy backends don't import torch/diffusers at import time.
def _stub():
    return StubBackend()

def _sd15():
    from .sd15 import SD15Backend
    return SD15Backend()

def _sd_turbo():
    from .sd_turbo import SDTurboBackend
    return SDTurboBackend()

def _sdxl():
    from .sdxl import SDXLBackend
    return SDXLBackend()

_REGISTRY = {
    "stub": _stub,
    "sd15": _sd15,
    "sd-turbo": _sd_turbo,
    "sdxl": _sdxl,
}

def available():
    return list(_REGISTRY.keys())

def get_backend(name: str):
    if name not in _REGISTRY:
        raise KeyError(name)
    return _REGISTRY[name]()
