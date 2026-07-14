from typing import Optional, Tuple
from PIL import Image
from ..config import settings

class SDTurboBackend:
    name = "sd-turbo"

    def __init__(self):
        self._pipe = None

    def _build_pipeline(self):
        import torch
        from diffusers import AutoPipelineForImage2Image
        pipe = AutoPipelineForImage2Image.from_pretrained("stabilityai/sd-turbo",
                                                          safety_checker=None)
        return pipe.to(settings.device)

    def _pipeline(self):
        if self._pipe is None:
            self._pipe = self._build_pipeline()
        return self._pipe

    def generate(self, prompt: str, pose: Optional[Image.Image], seed: int,
                 steps: int, size: Tuple[int, int]) -> Image.Image:
        pipe = self._pipeline()
        try:
            import torch
            gen = torch.Generator(device=settings.device).manual_seed(seed)
        except ModuleNotFoundError:
            # torch is a hard requirement in production (see requirements.txt);
            # this only triggers when _build_pipeline is monkeypatched in tests.
            gen = None
        # sd-turbo has weak ControlNet support; use the pose as a soft img2img
        # init so direction still influences the result. 1-4 steps.
        init = (pose or Image.new("RGB", size, (127, 127, 127))).resize(size)
        n = max(1, min(steps, 4))
        result = pipe(prompt=prompt, image=init, num_inference_steps=n,
                      strength=0.7, guidance_scale=0.0, generator=gen)
        return result.images[0].convert("RGBA").resize(size)
