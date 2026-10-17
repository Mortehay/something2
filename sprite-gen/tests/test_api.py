import time
from fastapi.testclient import TestClient
from app.main import app, job_manager

client = TestClient(app)

def _wait(job_id, timeout=10):
    for _ in range(int(timeout * 20)):
        r = client.get(f"/jobs/{job_id}").json()
        if r["status"] in ("done", "error"):
            return r
        time.sleep(0.05)
    raise AssertionError("job did not finish")

def test_backends_endpoint_lists_all():
    assert client.get("/backends").json() == ["stub", "sd15", "sd-turbo", "sdxl"]

def test_generate_with_stub_completes():
    r = client.post("/generate", json={"creature": "goblin", "base_prompt": "a goblin",
                                        "backend": "stub", "seed": 5, "frames": 2,
                                        "size": [32, 40], "steps": 1})
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    done = _wait(job_id)
    assert done["status"] == "done"
    assert done["progress"]["done"] == done["progress"]["total"] == 16  # 8 dirs x 2

def test_unknown_backend_is_400():
    r = client.post("/generate", json={"creature": "x", "base_prompt": "y", "backend": "nope"})
    assert r.status_code == 400


def test_generate_submits_a_dedup_key_scoped_to_kind_and_subject(monkeypatch):
    # SOMET-539: /generate must hand job_manager a dedup_key so resubmitting
    # the same subject while one is in flight collapses -- asserted here
    # against the real route's wiring (JobManager's own collapsing behavior
    # is covered directly in test_jobs.py).
    captured = {}

    def fake_submit(job_type, params, job_id=None, dedup_key=None):
        captured["job_type"] = job_type
        captured["params"] = params
        captured["job_id"] = job_id
        captured["dedup_key"] = dedup_key
        return job_id

    monkeypatch.setattr(job_manager, "submit", fake_submit)
    r = client.post("/generate", json={
        "creature": "goblin", "base_prompt": "a goblin", "kind": "object",
        "backend": "stub", "seed": 3,
    })
    assert r.status_code == 202
    assert captured["job_type"] == "object"
    assert captured["dedup_key"].startswith("object:goblin:")
    assert captured["params"]["creature"] == "goblin"
    assert captured["params"]["job_id"] == r.json()["job_id"]


def _dedup_keys_for(monkeypatch, *bodies):
    keys = []

    def fake_submit(job_type, params, job_id=None, dedup_key=None):
        keys.append(dedup_key)
        return job_id

    monkeypatch.setattr(job_manager, "submit", fake_submit)
    for body in bodies:
        assert client.post("/generate", json=body).status_code == 202
    return keys


def test_dedup_key_distinguishes_requests_whose_params_differ(monkeypatch):
    # SOMET-539 rework, Defect 2: keyed by subject alone, "try another seed"
    # for the same subject while the first was queued got the FIRST job's id
    # and image -- and the backend recorded a sprite_sets row claiming the
    # new seed. Any differing generation param must give a distinct key.
    base = {"creature": "Slow", "base_prompt": "a", "kind": "object", "backend": "stub", "seed": 1}
    variants = [
        {**base, "seed": 2},
        {**base, "base_prompt": "b"},
        {**base, "frames": 2},
        {**base, "size": [64, 64]},
        {**base, "steps": 3},
    ]
    keys = _dedup_keys_for(monkeypatch, base, *variants)
    assert len(set(keys)) == len(keys), keys


def test_dedup_key_collapses_identical_resubmissions(monkeypatch):
    # The AC this dedup exists for: the same subject resubmitted with the
    # same params must still collapse. job_id is minted per request and
    # must NOT leak into the key.
    body = {"creature": "Slow", "base_prompt": "a", "kind": "object", "backend": "stub", "seed": 1}
    first, second = _dedup_keys_for(monkeypatch, body, dict(body))
    assert first == second
