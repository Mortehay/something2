"""SOMET-631: GenerateRequest.creature and base_prompt were bare `str`, so
{"creature": "", "base_prompt": ""} returned 202 and queued a generation for
an empty subject, stored under an empty name.

base_prompt is rejected too: prompts.py never puts the creature name into the
prompt, so an empty base_prompt draws pure styling with no subject. Every real
caller already sends one (the admin forms require it or fall back to the
entity/tile name; bulk regeneration uses `prompt || name`).
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _post(**overrides):
    body = {"creature": "goblin", "base_prompt": "a goblin", "backend": "stub"}
    body.update(overrides)
    return client.post("/generate", json=body)


@pytest.mark.parametrize("value", ["", " ", "\t\n  "])
def test_blank_creature_is_rejected(value):
    assert _post(creature=value).status_code == 422


@pytest.mark.parametrize("value", ["", " ", "\t\n  "])
def test_blank_base_prompt_is_rejected(value):
    assert _post(base_prompt=value).status_code == 422


@pytest.mark.parametrize("kind", ["creature", "tile", "object"])
def test_blank_subject_rejected_for_every_kind(kind):
    assert _post(kind=kind, creature="", base_prompt="").status_code == 422


def test_rejected_request_queues_nothing(monkeypatch):
    from app.main import job_manager
    calls = []
    monkeypatch.setattr(job_manager, "submit", lambda *a, **k: calls.append((a, k)) or "x")
    assert _post(creature="").status_code == 422
    assert _post(base_prompt="  ").status_code == 422
    assert calls == []


def test_valid_subject_is_still_accepted():
    assert _post().status_code == 202
