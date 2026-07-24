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

# Static generation-capability facts per backend (F-037/SOMET-217): what a
# backend actually does is a property of the backend itself, not of whatever
# hardware-tier recipe happened to pick it. This matters because
# SPRITE_BACKEND (an explicit deployment override) can resolve a different
# backend than recipe_for(tier) assumed -- e.g. tier: 'gpu' asks for the
# sdxl/ControlNet recipe, but SPRITE_BACKEND=sd-turbo overrides the actual
# backend to sd-turbo, which has no ControlNet pipeline and internally
# clamps steps to 4 (see SDTurboBackend.generate). Without this table, the
# /generate response would keep reporting the tier recipe's controlnet/steps
# regardless of what actually runs, misleading any caller relying on it.
#   - controlnet: whether this backend has a ControlNet pose-guided pipeline.
#   - max_steps: the highest step count the backend will actually honor, or
#     None if it isn't clamped (the request's steps value passes through
#     unchanged).
_CAPABILITIES = {
    "stub": {"controlnet": False, "max_steps": None},
    "sd15": {"controlnet": True, "max_steps": None},
    "sdxl": {"controlnet": True, "max_steps": None},
    # Kept in sync with SDTurboBackend.generate's `min(steps, 4)` clamp.
    "sd-turbo": {"controlnet": False, "max_steps": 4},
}

def available():
    return list(_REGISTRY.keys())

def get_backend(name: str):
    if name not in _REGISTRY:
        raise KeyError(name)
    return _REGISTRY[name]()

def capabilities_for(name: str) -> dict:
    """Capability facts for a resolved backend name, for honest response
    reporting. Unknown names (shouldn't happen -- main.py validates the
    backend against `available()` first) get the conservative "assume
    nothing extra ran" defaults.
    """
    return _CAPABILITIES.get(name, {"controlnet": False, "max_steps": None})
