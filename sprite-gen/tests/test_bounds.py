"""F-033 (SOMET-213): POST /generate had no upper bound on frames/steps/size,
so a caller could request e.g. frames=500 and queue thousands of sequential
CPU generations (~66s each) on the service's single JobManager worker with no
way to cancel it. These bounds are sized from real call sites, not guesses —
see the comment above GenerateRequest in app/main.py for the reasoning.
"""
from fastapi.testclient import TestClient

from app.main import app, MAX_FRAMES, MAX_STEPS, MIN_SIZE_DIM, MAX_SIZE_DIM

client = TestClient(app)


def _post(**overrides):
    body = {"creature": "goblin", "base_prompt": "a goblin", "backend": "stub"}
    body.update(overrides)
    return client.post("/generate", json=body)


def test_frames_within_cap_is_accepted():
    r = _post(frames=MAX_FRAMES)
    assert r.status_code == 202


def test_frames_over_cap_is_rejected():
    r = _post(frames=MAX_FRAMES + 1)
    assert r.status_code == 422


def test_frames_far_over_cap_is_rejected():
    # The exact scenario from F-033's failure_scenario: 500 frames would fan
    # out to 4000 sequential creature-orchestrator generations.
    r = _post(frames=500)
    assert r.status_code == 422


def test_steps_within_cap_is_accepted():
    r = _post(steps=MAX_STEPS)
    assert r.status_code == 202


def test_steps_over_cap_is_rejected():
    r = _post(steps=MAX_STEPS + 1)
    assert r.status_code == 422


def test_size_within_cap_is_accepted():
    r = _post(size=[MAX_SIZE_DIM, MAX_SIZE_DIM])
    assert r.status_code == 202


def test_size_over_cap_is_rejected():
    r = _post(size=[MAX_SIZE_DIM + 1, MIN_SIZE_DIM])
    assert r.status_code == 422


def test_size_below_minimum_is_rejected():
    r = _post(size=[MIN_SIZE_DIM - 1, MIN_SIZE_DIM])
    assert r.status_code == 422


def test_zero_frames_is_rejected():
    r = _post(frames=0)
    assert r.status_code == 422


def test_zero_steps_is_rejected():
    r = _post(steps=0)
    assert r.status_code == 422
