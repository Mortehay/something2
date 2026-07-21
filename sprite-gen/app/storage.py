import io, json

def _png_bytes(img):
    buf = io.BytesIO()
    img.convert("RGBA").save(buf, format="PNG")
    buf.seek(0)
    return buf, buf.getbuffer().nbytes

class SpriteStore:
    def __init__(self, client, bucket: str):
        self.client = client
        self.bucket = bucket

    def ensure_bucket(self):
        if not self.client.bucket_exists(self.bucket):
            self.client.make_bucket(self.bucket)

    def put_creature(self, creature: str, result: dict) -> dict:
        self.ensure_bucket()
        frame_keys = []
        for name, img in result["frames"].items():
            key = f"{self.bucket}/{creature}/{name}.png"
            data, length = _png_bytes(img)
            self.client.put_object(self.bucket, key, data, length, content_type="image/png")
            frame_keys.append(key)
        atlas_key = f"{self.bucket}/{creature}/atlas.png"
        data, length = _png_bytes(result["atlas"])
        self.client.put_object(self.bucket, atlas_key, data, length, content_type="image/png")
        manifest_key = f"{self.bucket}/{creature}/atlas.json"
        mbytes = json.dumps(result["manifest"]).encode()
        self.client.put_object(self.bucket, manifest_key, io.BytesIO(mbytes), len(mbytes),
                               content_type="application/json")
        return {"atlas_key": atlas_key, "manifest_key": manifest_key, "frame_keys": frame_keys}

    def put_tile(self, tile: str, result: dict) -> dict:
        self.ensure_bucket()
        image_key = f"{self.bucket}/tiles/{tile}/static.png"
        data, length = _png_bytes(result["static"])
        self.client.put_object(self.bucket, image_key, data, length, content_type="image/png")
        atlas_key = f"{self.bucket}/tiles/{tile}/atlas.png"
        data, length = _png_bytes(result["atlas"])
        self.client.put_object(self.bucket, atlas_key, data, length, content_type="image/png")
        manifest_key = f"{self.bucket}/tiles/{tile}/atlas.json"
        mbytes = json.dumps(result["manifest"]).encode()
        self.client.put_object(self.bucket, manifest_key, io.BytesIO(mbytes), len(mbytes),
                               content_type="application/json")
        return {"image_key": image_key, "atlas_key": atlas_key,
                "manifest_key": manifest_key, "frames": len(result["frames"])}

def default_store():
    from minio import Minio
    from .config import settings
    client = Minio(settings.minio_endpoint, access_key=settings.minio_access_key,
                   secret_key=settings.minio_secret_key, secure=settings.minio_secure)
    return SpriteStore(client, settings.minio_bucket)
