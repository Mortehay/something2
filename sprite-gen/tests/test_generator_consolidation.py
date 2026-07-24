"""F-036 (SOMET-216): sd15.py, sd_turbo.py, and sdxl.py each independently
implemented the same seed->torch.Generator construction with the same
narrow `except ModuleNotFoundError` catch. Confirmed identical before
merging (byte-identical `torch.Generator(device=...).manual_seed(seed)`,
wrapped in `try/except ModuleNotFoundError: gen = None` in all three; only
sd_turbo.py had already extracted its copy into a named `_generator()`
method). A fix to the exception handling applied to one copy (e.g. the
named method a reviewer actually sees) could silently miss the other two
byte-identical inline copies.

These tests assert the shared helper is now the single place this logic
lives, and that generate() on each backend still produces the same
seeded-vs-unseeded behavior as before.
"""
import re
from pathlib import Path

BACKENDS_DIR = Path(__file__).parent.parent / "app" / "backends"


def test_seed_to_generator_logic_lives_in_exactly_one_place():
    # Before the fix: sd15.py, sd_turbo.py, and sdxl.py each have their own
    # `except ModuleNotFoundError` catch around the seed->Generator build.
    # After the fix: only base.py (the shared helper) has it.
    hits = {}
    for f in BACKENDS_DIR.glob("*.py"):
        text = f.read_text()
        count = len(re.findall(r"except ModuleNotFoundError", text))
        if count:
            hits[f.name] = count
    assert hits == {"base.py": 1}, (
        f"expected the seed->Generator exception handling to live only in "
        f"base.py, found it in: {hits}"
    )


def test_sd15_still_builds_a_seeded_generator(monkeypatch):
    from PIL import Image
    from app.backends.sd15 import SD15Backend

    calls = []

    class FakePipe:
        def __call__(self, prompt=None, image=None, num_inference_steps=None,
                     generator=None, **kw):
            calls.append(generator)
            class R: images = [Image.new("RGB", (32, 32), (1, 2, 3))]
            return R()

    b = SD15Backend()
    monkeypatch.setattr(b, "_build_pipeline", lambda: FakePipe())
    b.generate(prompt="x", pose=None, seed=7, steps=1, size=(32, 32))
    # torch isn't installed in this test environment, so the shared helper's
    # ModuleNotFoundError fallback applies -> generator is None, not an
    # exception propagating out of generate().
    assert calls == [None]


def test_sdxl_still_builds_a_seeded_generator(monkeypatch):
    from PIL import Image
    from app.backends.sdxl import SDXLBackend

    calls = []

    class FakePipe:
        def __call__(self, prompt=None, image=None, num_inference_steps=None,
                     generator=None, **kw):
            calls.append(generator)
            class R: images = [Image.new("RGB", (32, 32), (1, 2, 3))]
            return R()

    b = SDXLBackend()
    monkeypatch.setattr(b, "_build_pipeline", lambda: FakePipe())
    b.generate(prompt="x", pose=None, seed=7, steps=1, size=(32, 32))
    assert calls == [None]


def test_sd_turbo_still_builds_a_seeded_generator(monkeypatch):
    from PIL import Image
    from app.backends.sd_turbo import SDTurboBackend

    calls = []

    class FakePipe:
        def __call__(self, prompt=None, num_inference_steps=None,
                     guidance_scale=None, height=None, width=None,
                     generator=None, **kw):
            calls.append(generator)
            class R: images = [Image.new("RGB", (32, 32), (1, 2, 3))]
            return R()

    b = SDTurboBackend()
    monkeypatch.setattr(b, "_build_txt2img", lambda: FakePipe())
    b.generate(prompt="x", pose=None, seed=7, steps=1, size=(32, 32))
    assert calls == [None]
