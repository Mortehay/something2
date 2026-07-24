from PIL import Image
from app.postproc import cutout_background, crop_to_content, remove_background

def _alpha(img, x, y):
    return img.convert("RGBA").getpixel((x, y))[3]

def test_clears_a_flat_backdrop_and_keeps_the_subject():
    img = Image.new("RGBA", (32, 32), (200, 200, 200, 255))   # grey backdrop
    for y in range(12, 20):
        for x in range(12, 20):
            img.putpixel((x, y), (10, 120, 30, 255))          # subject blob
    out = cutout_background(img)

    assert _alpha(out, 0, 0) == 0, "corner backdrop must be cleared"
    assert _alpha(out, 31, 31) == 0
    assert _alpha(out, 15, 15) == 255, "subject must stay opaque"

def test_does_not_clear_a_background_coloured_patch_inside_the_subject():
    # The reason this floods from the border instead of thresholding globally:
    # a highlight inside the subject can match the backdrop colour exactly and
    # must NOT be punched out, or sprites come back full of holes.
    img = Image.new("RGBA", (32, 32), (255, 255, 255, 255))
    for y in range(8, 24):
        for x in range(8, 24):
            img.putpixel((x, y), (20, 20, 20, 255))
    img.putpixel((15, 15), (255, 255, 255, 255))              # enclosed white pixel
    out = cutout_background(img)

    assert _alpha(out, 0, 0) == 0
    assert _alpha(out, 15, 15) == 255, "enclosed highlight must survive"

def test_tolerates_a_slightly_noisy_backdrop():
    img = Image.new("RGBA", (32, 32), (180, 180, 190, 255))
    for i in range(32):                                        # dithering noise
        img.putpixel((i, 0), (188, 174, 196, 255))
    for y in range(12, 20):
        for x in range(12, 20):
            img.putpixel((x, y), (255, 40, 40, 255))
    out = cutout_background(img)

    assert _alpha(out, 0, 0) == 0
    assert _alpha(out, 5, 16) == 0, "noisy backdrop still floods through"
    assert _alpha(out, 15, 15) == 255

def test_leaves_an_already_transparent_image_alone():
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    img.putpixel((8, 8), (255, 0, 0, 255))
    out = cutout_background(img)

    assert _alpha(out, 8, 8) == 255

def test_crop_to_content_after_cutout_trims_to_the_subject():
    img = Image.new("RGBA", (32, 32), (200, 200, 200, 255))
    for y in range(12, 20):
        for x in range(12, 20):
            img.putpixel((x, y), (10, 120, 30, 255))
    out = crop_to_content(cutout_background(img))

    assert out.size == (8, 8)

def test_remove_background_falls_back_to_the_flood_fill(monkeypatch):
    # rembg is optional and fails silently when onnxruntime is missing, so the
    # entity path must still come back transparent without it.
    import app.postproc as pp
    monkeypatch.setattr(pp, "_rembg", lambda img: None)

    img = Image.new("RGBA", (32, 32), (120, 140, 160, 255))
    for y in range(12, 20):
        for x in range(12, 20):
            img.putpixel((x, y), (240, 30, 30, 255))
    out = pp.remove_background(img)

    assert _alpha(out, 0, 0) == 0
    assert _alpha(out, 15, 15) == 255

def test_remove_background_rejects_a_matte_that_kept_the_backdrop(monkeypatch):
    # Observed on real sd-turbo output (sprites/objects/IceRock): rembg is
    # installed and succeeds, but segments a "subject" that includes the
    # backdrop — the returned matte was 60% opaque around the border, so the
    # entity rendered as a rectangle with its background baked in. A matte that
    # leaves the border opaque is a failed matte; fall back to the flood-fill
    # rather than trusting it.
    import app.postproc as pp

    def bad_matte(img):
        out = img.convert("RGBA").copy()
        for y in range(out.size[1]):          # clears nothing at all
            for x in range(out.size[0]):
                r, g, b, _ = out.getpixel((x, y))
                out.putpixel((x, y), (r, g, b, 255))
        return out

    monkeypatch.setattr(pp, "_rembg", bad_matte)

    img = Image.new("RGBA", (32, 32), (120, 140, 160, 255))
    for y in range(12, 20):
        for x in range(12, 20):
            img.putpixel((x, y), (240, 30, 30, 255))
    out = pp.remove_background(img)

    assert _alpha(out, 0, 0) == 0, "a matte with an opaque border must be rejected"
    assert _alpha(out, 31, 31) == 0
    assert _alpha(out, 15, 15) == 255, "the subject must survive the fallback"

def test_remove_background_keeps_a_good_matte(monkeypatch):
    # The flip side: a matte that DID clear the border is what rembg is for —
    # it handles subjects the flood-fill can't (soft edges, non-flat backdrops),
    # so a clean result must be returned untouched.
    import app.postproc as pp

    marker = (7, 7, 7, 128)     # partial alpha: only a real matte produces this

    def good_matte(img):
        out = Image.new("RGBA", img.size, (0, 0, 0, 0))
        for y in range(12, 20):
            for x in range(12, 20):
                out.putpixel((x, y), marker)
        return out

    monkeypatch.setattr(pp, "_rembg", good_matte)

    img = Image.new("RGBA", (32, 32), (120, 140, 160, 255))
    out = pp.remove_background(img)

    assert out.getpixel((15, 15)) == marker, "a clean matte must be returned as-is"

def test_remove_background_does_not_key_interior_white(monkeypatch):
    # key_near_white()'s global >240 key would blank this pixel; the entity
    # path must not, or white highlights become holes.
    import app.postproc as pp
    monkeypatch.setattr(pp, "_rembg", lambda img: None)

    img = Image.new("RGBA", (32, 32), (60, 60, 60, 255))
    for y in range(8, 24):
        for x in range(8, 24):
            img.putpixel((x, y), (200, 40, 40, 255))
    img.putpixel((15, 15), (255, 255, 255, 255))
    out = pp.remove_background(img)

    assert _alpha(out, 15, 15) == 255
    assert _alpha(out, 0, 0) == 0
