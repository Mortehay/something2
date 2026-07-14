from app.orchestrator import generate_creature
from app.config import DIRECTIONS

def test_generates_all_directions_and_frames_with_stub():
    calls = []
    out = generate_creature(
        creature="goblin", base_prompt="a goblin", backend_name="stub",
        seed=7, n_frames=3, size=(64, 80), steps=1,
        progress=lambda d, t: calls.append((d, t)),
    )
    assert set(k.split("/")[0] for k in out["frames"]) == set(DIRECTIONS)
    assert len(out["frames"]) == len(DIRECTIONS) * 3
    assert out["atlas"].mode == "RGBA"
    assert set(out["manifest"]["frames"].keys()) == set(out["frames"].keys())
    assert calls[-1] == (len(DIRECTIONS) * 3, len(DIRECTIONS) * 3)  # progress completed

def test_deterministic_with_stub():
    a = generate_creature("g", "a goblin", "stub", 7, 2, (32, 40), 1)
    b = generate_creature("g", "a goblin", "stub", 7, 2, (32, 40), 1)
    assert list(a["atlas"].getdata()) == list(b["atlas"].getdata())
