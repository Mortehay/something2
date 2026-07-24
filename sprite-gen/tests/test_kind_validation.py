"""F-034 (SOMET-214): GenerateRequest.kind was an unconstrained `str`, so any
value other than exactly 'tile' or 'object' silently fell through to the
8-direction creature pipeline instead of being rejected — e.g. a caller
sending kind: 'Tile' (capitalized) got a creature-shaped result back instead
of a 422, with roughly 8x the generation work for a typo.
"""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _post(**overrides):
    body = {"creature": "goblin", "base_prompt": "a goblin", "backend": "stub"}
    body.update(overrides)
    return client.post("/generate", json=body)


def test_unrecognized_kind_is_rejected():
    # The exact scenario from F-034: a typo'd/mis-cased kind must not
    # silently fall through to the creature branch.
    r = _post(kind="Tile")
    assert r.status_code == 422


def test_arbitrary_kind_string_is_rejected():
    r = _post(kind="sprite")
    assert r.status_code == 422


def test_tile_kind_is_accepted():
    r = _post(kind="tile")
    assert r.status_code == 202


def test_object_kind_is_accepted():
    r = _post(kind="object")
    assert r.status_code == 202


def test_creature_kind_is_accepted():
    r = _post(kind="creature")
    assert r.status_code == 202


def test_default_kind_is_creature():
    r = _post()
    assert r.status_code == 202
