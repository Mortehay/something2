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
    out = store.put_creature("goblin", _result())
    assert out["atlas_key"] == "sprites/goblin/atlas.png"
    assert out["manifest_key"] == "sprites/goblin/atlas.json"
    assert "sprites/goblin/S/0.png" in out["frame_keys"]
    assert "sprites/goblin/atlas.png" in fake.objects
    assert "sprites/goblin/S/0.png" in fake.objects
    manifest = json.loads(fake.objects["sprites/goblin/atlas.json"])
    assert manifest["frames"]["S/0"] == [0, 0, 8, 8]
