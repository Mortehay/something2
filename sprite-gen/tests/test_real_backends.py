import pytest
from PIL import Image
from app.backends.sd15 import SD15Backend

class FakePipe:
    def __init__(self): self.calls = []
    def __call__(self, prompt=None, image=None, num_inference_steps=None,
                 generator=None, **kw):
        self.calls.append({"prompt": prompt, "steps": num_inference_steps,
                           "has_control": image is not None})
        class R: images = [Image.new("RGB", (64, 80), (10, 20, 30))]
        return R()

def test_sd15_wires_prompt_control_and_steps(monkeypatch):
    fake = FakePipe()
    b = SD15Backend()
    monkeypatch.setattr(b, "_build_pipeline", lambda: fake)
    pose = Image.new("RGB", (64, 80), (0, 0, 0))
    out = b.generate(prompt="goblin facing S", pose=pose, seed=3, steps=8, size=(64, 80))
    assert out.size == (64, 80)
    assert fake.calls[0]["prompt"] == "goblin facing S"
    assert fake.calls[0]["steps"] == 8
    assert fake.calls[0]["has_control"] is True

@pytest.mark.slow
def test_sd_turbo_real_generation():
    # Only runs with `pytest -m slow`; downloads sd-turbo (~2.5GB) and runs on CPU.
    from app.backends.sd_turbo import SDTurboBackend
    b = SDTurboBackend()
    img = b.generate(prompt="a goblin, isometric sprite", pose=None, seed=1,
                     steps=2, size=(128, 160))
    assert img.size == (128, 160) and img.mode == "RGBA"
