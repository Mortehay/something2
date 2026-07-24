"""F-033 (SOMET-213): POST /generate had no authentication at all — combined
with F-039 (compose publishing db/redis, and this service, reachable beyond
loopback), anything that could reach the port could queue unbounded CPU work.
require_shared_secret() gates /generate behind a header the backend sends,
and fails CLOSED (500) rather than open when the secret isn't configured —
an unconfigured check must never look like protection while granting access.

Unit tests below call require_shared_secret() directly so they exercise the
real check. The end-to-end test temporarily removes the session-wide
dependency override (see the `_bypass_shared_secret_for_generate` fixture in
conftest.py) to confirm the route itself is actually gated, not just the
function in isolation.
"""
from dataclasses import replace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import main

client = TestClient(main.app)


def _configure_secret(monkeypatch, secret):
    monkeypatch.setattr(main, "settings", replace(main.settings, sprite_gen_shared_secret=secret))


def test_unconfigured_secret_fails_closed(monkeypatch):
    _configure_secret(monkeypatch, "")
    with pytest.raises(HTTPException) as exc:
        main.require_shared_secret(x_sprite_gen_secret="anything-at-all")
    assert exc.value.status_code == 500


def test_missing_header_is_rejected(monkeypatch):
    _configure_secret(monkeypatch, "s3cr3t")
    with pytest.raises(HTTPException) as exc:
        main.require_shared_secret(x_sprite_gen_secret=None)
    assert exc.value.status_code == 401


def test_wrong_secret_is_rejected(monkeypatch):
    _configure_secret(monkeypatch, "s3cr3t")
    with pytest.raises(HTTPException) as exc:
        main.require_shared_secret(x_sprite_gen_secret="not-it")
    assert exc.value.status_code == 401


def test_correct_secret_is_accepted(monkeypatch):
    _configure_secret(monkeypatch, "s3cr3t")
    main.require_shared_secret(x_sprite_gen_secret="s3cr3t")  # must not raise


def test_generate_route_is_actually_gated(monkeypatch):
    """End-to-end: with the test-session bypass removed, /generate must
    enforce the secret for real, not just when called as a bare function."""
    _configure_secret(monkeypatch, "s3cr3t")
    main.app.dependency_overrides.pop(main.require_shared_secret, None)
    try:
        no_header = client.post(
            "/generate", json={"creature": "x", "base_prompt": "y", "backend": "stub"}
        )
        assert no_header.status_code == 401

        wrong_header = client.post(
            "/generate",
            json={"creature": "x", "base_prompt": "y", "backend": "stub"},
            headers={"X-Sprite-Gen-Secret": "nope"},
        )
        assert wrong_header.status_code == 401

        right_header = client.post(
            "/generate",
            json={"creature": "x", "base_prompt": "y", "backend": "stub"},
            headers={"X-Sprite-Gen-Secret": "s3cr3t"},
        )
        assert right_header.status_code == 202
    finally:
        main.app.dependency_overrides[main.require_shared_secret] = lambda: None
