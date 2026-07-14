import pytest
from app import backends

def test_registry_lists_all_four():
    assert backends.available() == ["stub", "sd15", "sd-turbo", "sdxl"]

def test_unknown_backend_raises():
    with pytest.raises(KeyError):
        backends.get_backend("nope")

def test_stub_is_deterministic_and_sized():
    b = backends.get_backend("stub")
    img1 = b.generate(prompt="goblin facing S", pose=None, seed=42, steps=1, size=(128, 160))
    img2 = b.generate(prompt="goblin facing S", pose=None, seed=42, steps=1, size=(128, 160))
    assert img1.size == (128, 160)
    assert img1.mode == "RGBA"
    assert list(img1.getdata()) == list(img2.getdata())  # deterministic

def test_stub_varies_by_seed():
    b = backends.get_backend("stub")
    a = b.generate(prompt="goblin", pose=None, seed=1, steps=1, size=(64, 64))
    c = b.generate(prompt="goblin", pose=None, seed=2, steps=1, size=(64, 64))
    assert list(a.getdata()) != list(c.getdata())
