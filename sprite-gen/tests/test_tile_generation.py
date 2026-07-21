from app.prompts import build_tile_prompt
from app.orchestrator import generate_tile
from PIL import Image

def test_build_tile_prompt_has_tile_styling_and_no_facing_words():
    p = build_tile_prompt("molten lava")
    assert "molten lava" in p
    assert "seamless" in p and "tile" in p
    # Must NOT reuse the creature facing/walk vocabulary.
    for banned in ("facing", "walk cycle", "full body"):
        assert banned not in p, f"tile prompt leaked creature word: {banned}"

def test_generate_tile_static_only_produces_one_frame():
    out = generate_tile("grass", "green grass", "stub", seed=3, n_frames=1, size=(16, 16), steps=1)
    assert set(out.keys()) == {"static", "frames", "atlas", "manifest"}
    assert list(out["frames"].keys()) == ["0"]
    assert out["static"] is out["frames"]["0"]
    assert isinstance(out["static"], Image.Image)
    assert out["manifest"]["frames"]["0"][2] > 0  # non-empty cell

def test_generate_tile_animated_produces_n_frames_and_reports_progress():
    seen = []
    out = generate_tile("water", "blue water", "stub", seed=7, n_frames=4, size=(16, 16),
                        steps=1, progress=lambda d, t: seen.append((d, t)))
    assert list(out["frames"].keys()) == ["0", "1", "2", "3"]
    assert seen[-1] == (4, 4)  # progress reaches total
    # The static image is frame 0, and the atlas packs all 4 frames.
    assert len(out["manifest"]["frames"]) == 4

def test_generate_tile_is_deterministic():
    a = generate_tile("grass", "green grass", "stub", seed=3, n_frames=2, size=(16, 16), steps=1)
    b = generate_tile("grass", "green grass", "stub", seed=3, n_frames=2, size=(16, 16), steps=1)
    assert a["manifest"] == b["manifest"]
    assert a["static"].tobytes() == b["static"].tobytes()
