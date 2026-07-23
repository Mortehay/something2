from PIL import Image
from app.postproc import key_near_white, crop_to_content, pack_atlas

def _solid(w, h, color=(255, 0, 0, 255)):
    return Image.new("RGBA", (w, h), color)

def test_key_near_white_returns_rgba():
    out = key_near_white(Image.new("RGB", (10, 10), (255, 255, 255)))
    assert out.mode == "RGBA"

def test_crop_to_content_trims_transparent_border():
    img = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    for x in range(5, 15):
        for y in range(5, 15):
            img.putpixel((x, y), (0, 255, 0, 255))
    out = crop_to_content(img)
    assert out.size == (10, 10)

def test_pack_atlas_manifest_matches_placement():
    frames = {"S/0": _solid(16, 24), "S/1": _solid(16, 24),
              "N/0": _solid(16, 24), "N/1": _solid(16, 24)}
    sheet, manifest = pack_atlas(frames)
    assert manifest["cell"] == [16, 24]
    assert set(manifest["frames"].keys()) == set(frames.keys())
    for key, (x, y, w, h) in manifest["frames"].items():
        assert w == 16 and h == 24
        assert 0 <= x <= sheet.width - w
        assert 0 <= y <= sheet.height - h
