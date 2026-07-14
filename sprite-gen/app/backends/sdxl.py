from typing import Optional, Tuple
from PIL import Image
from ..config import settings

class SDXLBackend:
    name = "sdxl"

    def __init__(self):
        self._pipe = None

    def _build_pipeline(self):
        import torch
        from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel
        controlnet = ControlNetModel.from_pretrained("thibaud/controlnet-openpose-sdxl-1.0")
        pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
            "stabilityai/stable-diffusion-xl-base-1.0", controlnet=controlnet,
        )
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
        control = (pose or Image.new("RGB", size, (0, 0, 0))).resize(size)
        result = pipe(prompt=prompt, image=control, num_inference_steps=steps, generator=gen)
        return result.images[0].convert("RGBA").resize(size)
