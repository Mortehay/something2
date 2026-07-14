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
