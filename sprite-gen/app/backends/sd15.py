from typing import Optional, Tuple
from PIL import Image
from ..config import settings

class SD15Backend:
    name = "sd15"

    def __init__(self):
        self._pipe = None

    def _build_pipeline(self):
        # Imported lazily; downloads weights on first real use.
        import torch
        from diffusers import StableDiffusionControlNetPipeline, ControlNetModel
        controlnet = ControlNetModel.from_pretrained("lllyasviel/sd-controlnet-openpose")
        pipe = StableDiffusionControlNetPipeline.from_pretrained(
            "runwayml/stable-diffusion-v1-5", controlnet=controlnet, safety_checker=None,
        )
        pipe = pipe.to(settings.device)
        return pipe

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
        control = (pose or Image.new("RGB", size, (0, 0, 0))).resize(size)
        result = pipe(prompt=prompt, image=control, num_inference_steps=steps, generator=gen)
        return result.images[0].convert("RGBA").resize(size)
