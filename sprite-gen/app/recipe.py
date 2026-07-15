from dataclasses import dataclass


@dataclass(frozen=True)
class Recipe:
    tier: str
    backend: str
    steps: int
    n_frames: int
    controlnet: bool


# The generation recipe is a function of the detected hardware tier, not
# hardcoded per call:
#   gpu -> the consistent full directional set the user wants: ControlNet
#          pose-guided, more inference steps, SDXL.
#   cpu -> real diffusion but deliberately light so it actually finishes on a
#          CPU (just slowly): SD-Turbo's few-step schedule, a single reduced
#          frame set, no ControlNet pass.
_TIER_RECIPES = {
    "gpu": Recipe(tier="gpu", backend="sdxl", steps=30, n_frames=4, controlnet=True),
    "cpu": Recipe(tier="cpu", backend="sd-turbo", steps=4, n_frames=1, controlnet=False),
}


def recipe_for(tier: str) -> Recipe:
    """Full generation recipe for a hardware tier. Unknown tiers fall back to
    the cpu recipe (the safe, always-runnable choice)."""
    return _TIER_RECIPES.get(tier, _TIER_RECIPES["cpu"])
