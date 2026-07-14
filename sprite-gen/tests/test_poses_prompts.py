from app.poses import pose_for
from app.prompts import build_prompt

def test_pose_is_image_of_size_and_deterministic():
    a = pose_for("S", 0, (128, 160))
    b = pose_for("S", 0, (128, 160))
    assert a.size == (128, 160)
    assert list(a.getdata()) == list(b.getdata())

def test_pose_varies_by_frame_and_direction():
    assert list(pose_for("S", 0, (64, 80)).getdata()) != list(pose_for("S", 1, (64, 80)).getdata())
    assert list(pose_for("S", 0, (64, 80)).getdata()) != list(pose_for("N", 0, (64, 80)).getdata())

def test_prompt_includes_direction_and_iso():
    p = build_prompt("a fierce goblin warrior", "SE", 2)
    assert "goblin" in p
    assert "isometric" in p.lower()
    assert "south-east" in p.lower() or "se" in p.lower()
