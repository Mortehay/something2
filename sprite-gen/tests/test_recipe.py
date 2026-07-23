from fastapi.testclient import TestClient

from app.recipe import recipe_for
from app.main import app

client = TestClient(app)


def test_gpu_recipe_is_high_fidelity():
    r = recipe_for("gpu")
    assert r.tier == "gpu"
    assert r.backend == "sdxl"
    assert r.controlnet is True
    assert r.steps >= 20
    assert r.n_frames >= 4


def test_cpu_recipe_is_light_but_real():
    r = recipe_for("cpu")
    assert r.tier == "cpu"
    assert r.backend == "sd-turbo"  # real diffusion, not the stub
    assert r.controlnet is False
    assert r.steps <= 8       # few-step schedule so CPU finishes
    assert r.n_frames == 1    # single reduced frame set on CPU


def test_unknown_tier_falls_back_to_cpu():
    assert recipe_for("bogus") == recipe_for("cpu")


def test_generate_fills_defaults_from_tier_recipe(no_real_work):
    # No backend/frames/steps -> filled from the requested tier's recipe.
    # no_real_work: this resolves to sdxl, and an un-awaited sdxl job would
    # hold the shared worker for minutes.
    r = client.post("/generate", json={
        "creature": "goblin", "base_prompt": "a goblin", "tier": "gpu",
    })
    assert r.status_code == 202
    rec = r.json()["recipe"]
    assert rec["tier"] == "gpu"
    assert rec["backend"] == "sdxl"
    assert rec["controlnet"] is True


def test_generate_explicit_fields_win_over_recipe():
    r = client.post("/generate", json={
        "creature": "goblin", "base_prompt": "a goblin", "tier": "gpu",
        "backend": "stub", "frames": 2, "steps": 1,
    })
    assert r.status_code == 202
    rec = r.json()["recipe"]
    assert rec["backend"] == "stub"   # explicit override
    assert rec["frames"] == 2
    assert rec["steps"] == 1
    assert rec["tier"] == "gpu"       # tier still from request
