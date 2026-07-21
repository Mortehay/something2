from typing import Optional, Tuple
from PIL import Image
from ..config import settings

class SDTurboBackend:
    name = "sd-turbo"
    # sd-turbo is trained at 512px. Generating at the target tile size (128px)
    # directly yields incoherent mush; generate at native resolution and
    # downscale, which also crisps up the pixel-art look.
    NATIVE = 512

    def __init__(self):
        self._txt2img = None
        self._img2img = None

    def _build_txt2img(self):
        from diffusers import AutoPipelineForText2Image
        pipe = AutoPipelineForText2Image.from_pretrained("stabilityai/sd-turbo",
                                                         safety_checker=None)
        return pipe.to(settings.device)

    def _build_pipeline(self):
        # img2img reuses the txt2img weights — no second copy of the model in RAM.
        from diffusers import AutoPipelineForImage2Image
        return AutoPipelineForImage2Image.from_pipe(self._text_pipeline())

    def _text_pipeline(self):
        if self._txt2img is None:
            self._txt2img = self._build_txt2img()
        return self._txt2img

    def _pipeline(self):
        if self._img2img is None:
            self._img2img = self._build_pipeline()
        return self._img2img

    def _generator(self, seed: int):
        try:
            import torch
            return torch.Generator(device=settings.device).manual_seed(seed)
        except ModuleNotFoundError:
            # torch is a hard requirement in production (see requirements.txt);
            # this only triggers when a pipeline builder is monkeypatched in tests.
            return None

    def generate(self, prompt: str, pose: Optional[Image.Image], seed: int,
                 steps: int, size: Tuple[int, int]) -> Image.Image:
        # sd-turbo uses its distilled few-step schedule with no CFG (guidance 0).
        n = max(1, min(steps, 4))
        gen = self._generator(seed)
        if pose is None:
            # Poseless (tile / texture) request: pure text2img at native res so
            # the prompt actually drives the image, then downscale to target.
            pipe = self._text_pipeline()
            result = pipe(prompt=prompt, num_inference_steps=n, guidance_scale=0.0,
                          height=self.NATIVE, width=self.NATIVE, generator=gen)
        else:
            # Pose-guided creature: soft img2img init keeps direction influence.
            pipe = self._pipeline()
            init = pose.convert("RGB").resize((self.NATIVE, self.NATIVE))
            result = pipe(prompt=prompt, image=init, num_inference_steps=n,
                          strength=0.7, guidance_scale=0.0, generator=gen)
        return result.images[0].convert("RGBA").resize(size, Image.LANCZOS)
