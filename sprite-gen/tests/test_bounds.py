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


# F-035 (SOMET-215): size had no shape validation, so a malformed size (e.g.
# a single-element list) was accepted at 202 and only failed deep inside the
# async job — after a real ~66s backend generation pass — with a raw
# PIL/Python unpacking error surfaced verbatim through GET /jobs/{id}. The
# `_size_within_bounds` validator's `len(v) != 2` check (added alongside
# these same MIN/MAX_SIZE_DIM bounds) already rejects this at the request
# boundary; these tests lock that shape check in with the finding's exact
# failure scenario, which had no dedicated coverage before this.
def test_size_single_element_is_rejected():
    # The exact scenario from F-035's failure_scenario.
    r = _post(size=[16])
    assert r.status_code == 422


def test_size_three_elements_is_rejected():
    r = _post(size=[MIN_SIZE_DIM, MIN_SIZE_DIM, MIN_SIZE_DIM])
    assert r.status_code == 422


def test_size_empty_list_is_rejected():
    r = _post(size=[])
    assert r.status_code == 422


def test_zero_frames_is_rejected():
    r = _post(frames=0)
    assert r.status_code == 422


def test_zero_steps_is_rejected():
    r = _post(steps=0)
    assert r.status_code == 422
