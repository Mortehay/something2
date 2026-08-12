import io, json
from PIL import Image
from app.storage import SpriteStore

class FakeMinio:
    def __init__(self): self.objects = {}; self.buckets = set()
    def bucket_exists(self, b): return b in self.buckets
    def make_bucket(self, b): self.buckets.add(b)
    def put_object(self, bucket, key, data, length, content_type=None):
        self.objects[key] = data.read()

def _result():
    frames = {"S/0": Image.new("RGBA", (8, 8), (255, 0, 0, 255))}
    atlas = Image.new("RGBA", (8, 8), (255, 0, 0, 255))
    return {"frames": frames, "atlas": atlas, "manifest": {"cell": [8, 8], "frames": {"S/0": [0, 0, 8, 8]}}}

def test_put_creature_uploads_frames_atlas_and_manifest():
    fake = FakeMinio()
    store = SpriteStore(fake, "sprites")
    out = store.put_creature("goblin", "job1", _result())
    assert out["atlas_key"] == "sprites/goblin/job1/atlas.png"
    assert out["manifest_key"] == "sprites/goblin/job1/atlas.json"
    assert "sprites/goblin/job1/S/0.png" in out["frame_keys"]
    assert "sprites/goblin/job1/atlas.png" in fake.objects
    assert "sprites/goblin/job1/S/0.png" in fake.objects
    manifest = json.loads(fake.objects["sprites/goblin/job1/atlas.json"])
    assert manifest["frames"]["S/0"] == [0, 0, 8, 8]

def test_put_creature_two_generations_do_not_collide():
    # SOMET-235: two generations for the SAME creature name (different
    # job_ids) must land under two entirely distinct key sets, with BOTH
    # sets of objects present afterward -- proving the second generation
    # does not clobber the first, live or not.
    fake = FakeMinio()
    store = SpriteStore(fake, "sprites")
    first = store.put_creature("goblin", "job1", _result())
    second = store.put_creature("goblin", "job2", _result())
    assert first["atlas_key"] != second["atlas_key"]
    assert first["manifest_key"] != second["manifest_key"]
    assert set(first["frame_keys"]).isdisjoint(second["frame_keys"])
    for key in [first["atlas_key"], first["manifest_key"], *first["frame_keys"],
                second["atlas_key"], second["manifest_key"], *second["frame_keys"]]:
        assert key in fake.objects
