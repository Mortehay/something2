import io, json, time
from PIL import Image
from fastapi.testclient import TestClient
from app.storage import SpriteStore
from app.main import app

client = TestClient(app)

class FakeMinio:
    def __init__(self): self.objects = {}; self.buckets = set()
    def bucket_exists(self, b): return b in self.buckets
    def make_bucket(self, b): self.buckets.add(b)
    def put_object(self, bucket, key, data, length, content_type=None):
        self.objects[key] = data.read()

def _tile_result():
    img = Image.new("RGBA", (8, 8), (0, 255, 0, 255))
    return {"static": img, "frames": {"0": img},
            "atlas": img, "manifest": {"cell": [8, 8], "frames": {"0": [0, 0, 8, 8]}}}

def test_put_tile_uploads_static_atlas_and_manifest():
    fake = FakeMinio()
    store = SpriteStore(fake, "sprites")
    out = store.put_tile("grass", _tile_result())
    assert out["image_key"] == "sprites/tiles/grass/static.png"
    assert out["atlas_key"] == "sprites/tiles/grass/atlas.png"
    assert out["manifest_key"] == "sprites/tiles/grass/atlas.json"
    assert out["frames"] == 1
    assert "sprites/tiles/grass/static.png" in fake.objects
    manifest = json.loads(fake.objects["sprites/tiles/grass/atlas.json"])
    assert manifest["frames"]["0"] == [0, 0, 8, 8]

def _wait(job_id, timeout=10):
    for _ in range(int(timeout * 20)):
        r = client.get(f"/jobs/{job_id}").json()
        if r["status"] in ("done", "error"):
            return r
        time.sleep(0.05)
    raise AssertionError("job did not finish")

def test_generate_kind_tile_runs_tile_branch_no_store():
    # SPRITE_STORE_ENABLED defaults false in tests → the no-store result shape.
    r = client.post("/generate", json={"creature": "grass", "base_prompt": "green grass",
                                        "kind": "tile", "backend": "stub", "seed": 2,
                                        "frames": 3, "size": [16, 16], "steps": 1})
    assert r.status_code == 202
    done = _wait(r.json()["job_id"])
    assert done["status"] == "done"
    # tile branch: total progress == n_frames (NOT 8 dirs x frames).
    assert done["progress"]["done"] == done["progress"]["total"] == 3
    assert done["result"]["frames"] == 3

def test_generate_default_kind_is_creature_unchanged():
    r = client.post("/generate", json={"creature": "goblin", "base_prompt": "a goblin",
                                        "backend": "stub", "seed": 1, "frames": 2,
                                        "size": [16, 16], "steps": 1})
    done = _wait(r.json()["job_id"])
    assert done["progress"]["total"] == 16  # 8 dirs x 2 frames — creature path intact
