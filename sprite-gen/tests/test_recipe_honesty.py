"""F-037 (SOMET-217): the /generate response reported recipe.controlnet
(and steps) from recipe_for(tier) using the requested/detected tier,
independent of the backend actually resolved for the job. With
SPRITE_BACKEND=sd-turbo permanently set in this deployment, a caller
requesting tier: 'gpu' (expecting the sdxl/ControlNet pipeline) got
backend_name 'sd-turbo' back, yet the response's recipe.controlnet was
still True and steps was still 30 -- SDTurboBackend has no ControlNet
pipeline at all and internally clamps steps to 4 -- misleading a caller
relying on the response to know whether pose-guided generation actually
ran.
"""
import os

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


@pytest.fixture
def force_sd_turbo_env(monkeypatch, no_real_work):
    # Mirrors the deployed container's permanent SPRITE_BACKEND=sd-turbo
    # override (compose/develop/docker-compose.yml).
    monkeypatch.setenv("SPRITE_BACKEND", "sd-turbo")
    return no_real_work


def test_controlnet_field_reflects_resolved_backend_not_tier(force_sd_turbo_env):
    # tier: gpu asks for the sdxl/ControlNet recipe, but SPRITE_BACKEND
    # overrides the actual backend to sd-turbo, which has no ControlNet
    # pipeline. The response must say so.
    r = client.post("/generate", json={
        "creature": "goblin", "base_prompt": "a goblin", "tier": "gpu",
    })
    assert r.status_code == 202
    rec = r.json()["recipe"]
    assert rec["backend"] == "sd-turbo"
    assert rec["controlnet"] is False


def test_steps_field_reflects_what_the_backend_will_actually_run(force_sd_turbo_env):
    # The gpu recipe's steps (30) is not what sd-turbo will run -- it
    # internally clamps to 4 (SDTurboBackend.generate). The reported steps
    # must match reality, not the unclamped recipe default.
    r = client.post("/generate", json={
        "creature": "goblin", "base_prompt": "a goblin", "tier": "gpu",
    })
    assert r.status_code == 202
    rec = r.json()["recipe"]
    assert rec["steps"] == 4


def test_sdxl_backend_still_reports_controlnet_true(no_real_work):
    # Sanity check: when sdxl really is the resolved backend, the honest
    # reporting still says True -- this isn't just flipping the field to
    # always False.
    r = client.post("/generate", json={
        "creature": "goblin", "base_prompt": "a goblin", "tier": "gpu",
        "backend": "sdxl",
    })
    assert r.status_code == 202
    rec = r.json()["recipe"]
    assert rec["controlnet"] is True
    assert rec["steps"] == 30
