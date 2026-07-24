import json, time
from PIL import Image
from fastapi.testclient import TestClient
from app.storage import SpriteStore
from app.main import app
from app.prompts import build_object_prompt, build_tile_prompt

client = TestClient(app)

class FakeMinio:
    def __init__(self): self.objects = {}; self.buckets = set()
    def bucket_exists(self, b): return b in self.buckets
    def make_bucket(self, b): self.buckets.add(b)
    def put_object(self, bucket, key, data, length, content_type=None):
        self.objects[key] = data.read()

def _flat_result():
    img = Image.new("RGBA", (8, 8), (0, 255, 0, 255))
    return {"static": img, "frames": {"0": img},
            "atlas": img, "manifest": {"cell": [8, 8], "frames": {"0": [0, 0, 8, 8]}}}

def test_put_object_uploads_under_objects_prefix():
    fake = FakeMinio()
    store = SpriteStore(fake, "sprites")
    out = store.put_object("Tree", _flat_result())
    # Distinct prefix from tiles so an entity named like a tile can't clobber it.
    assert out["image_key"] == "sprites/objects/Tree/static.png"
    assert out["atlas_key"] == "sprites/objects/Tree/atlas.png"
    assert out["manifest_key"] == "sprites/objects/Tree/atlas.json"
    assert out["frames"] == 1
    manifest = json.loads(fake.objects["sprites/objects/Tree/atlas.json"])
    assert manifest["frames"]["0"] == [0, 0, 8, 8]

def test_put_tile_and_put_object_do_not_share_keys():
    fake = FakeMinio()
    store = SpriteStore(fake, "sprites")
    tile = store.put_tile("grass", _flat_result())
    obj = store.put_object("grass", _flat_result())
    assert tile["image_key"] != obj["image_key"]

def test_object_prompt_is_not_tileable():
    # A prop must not be asked for a seamless repeating texture — that is the
    # one styling difference between the two flat paths.
    p = build_object_prompt("a tall oak")
    assert "a tall oak" in p
    assert "seamless" not in p and "tileable" not in p
    assert "seamless" in build_tile_prompt("grass")

def _wait(job_id, timeout=10):
    for _ in range(int(timeout * 20)):
        r = client.get(f"/jobs/{job_id}").json()
        if r["status"] in ("done", "error"):
            return r
        time.sleep(0.05)
    raise AssertionError("job did not finish")

def test_generate_kind_object_runs_flat_branch_not_directional():
    r = client.post("/generate", json={"creature": "Tree", "base_prompt": "a tall oak",
                                       "kind": "object", "backend": "stub", "seed": 3,
                                       "frames": 3, "size": [16, 16], "steps": 1})
    assert r.status_code == 202
    done = _wait(r.json()["job_id"])
    assert done["status"] == "done"
    # 3 frames total, NOT 8 directions x 3 frames — that ~8x saving is the whole
    # point of routing entity props through the flat path.
    assert done["progress"]["done"] == done["progress"]["total"] == 3
    assert done["result"]["frames"] == 3

def test_generate_kind_object_manifest_keys_are_flat():
    r = client.post("/generate", json={"creature": "Tree", "base_prompt": "a tall oak",
                                       "kind": "object", "backend": "stub", "seed": 3,
                                       "frames": 2, "size": [16, 16], "steps": 1})
    done = _wait(r.json()["job_id"])
    keys = set(done["result"]["manifest"]["frames"].keys())
    # Bare indices, no "DIR/idx" — the client cycles these with tileFrameKey.
    assert keys == {"0", "1"}
