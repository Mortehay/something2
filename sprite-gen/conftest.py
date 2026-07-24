import pytest
from unittest.mock import patch
from app.backends.stub import StubBackend
from app.main import app, require_shared_secret


def _blocked_default_store(*args, **kwargs):
    raise RuntimeError(
        "app.storage.default_store() was called from inside the pytest suite. "
        "Tests must never reach the real MinIO sprite store — this call was "
        "blocked by the _no_real_store_writes autouse fixture in conftest.py "
        "(see F-032: SPRITE_STORE_ENABLED=true in the deployed container let "
        "`pytest` overwrite real production sprites). If a test genuinely "
        "needs storage behavior, exercise SpriteStore directly against a fake "
        "client (see tests/test_storage.py) instead of disabling this guard."
    )


@pytest.fixture(autouse=True, scope="session")
def _no_real_store_writes():
    """Force the sprite store off for the entire test session, unconditionally.

    `app.main._STORE_ENABLED` is read from the `SPRITE_STORE_ENABLED` env var
    at import time. That makes it a container-wide flag with no test-mode
    override: running pytest inside the deployed sprite-gen container (where
    the flag is `true` for real generation) makes `/generate` requests
    silently persist stub output over real art in the production MinIO
    bucket — this already destroyed the real `grass` tile and `Tree` object
    sprites once (F-032).

    Patch the flag to False regardless of the process environment so the
    suite can never depend on where it happens to run, and additionally patch
    `default_store` to raise loudly if anything still reaches it — defense in
    depth in case the flag check is ever bypassed, removed, or a new code
    path forgets it.
    """
    with patch("app.main._STORE_ENABLED", False), \
         patch("app.storage.default_store", side_effect=_blocked_default_store):
        yield


@pytest.fixture(autouse=True, scope="session")
def _force_stub_backend_in_jobs():
    """Unit tests must never *execute* a real diffusion backend.

    The JobManager has a single worker thread, so one real job that downloads a
    model (sdxl ~7GB, sd-turbo ~2.5GB) blocks the queue and starves every test
    that submits a job afterwards. Several tests submit `/generate` requests that
    resolve to sdxl/sd-turbo — on purpose, to assert the resolved backend *name*
    in the 202 response — but never wait for the job. Once torch/torchvision
    import cleanly those jobs actually start downloading and the suite hangs/fails.

    Backend-name resolution lives in app.main and is untouched here, so the
    recipe/echo assertions still hold; only the job's actual generation is
    redirected to the instant stub. Tests that exercise a real backend construct
    it directly (test_real_backends.py) and bypass this seam.
    """
    with patch("app.orchestrator.get_backend", lambda name: StubBackend()):
        yield


@pytest.fixture(autouse=True, scope="session")
def _bypass_shared_secret_for_generate():
    """POST /generate is gated by require_shared_secret() (F-033/SOMET-213).

    The rest of this suite exercises /generate's behavior — recipe
    resolution, job lifecycle, storage, bounds — without simulating the
    backend's shared-secret header on every single call site; rewriting every
    existing test for a concern this fixture already covers once would be
    pure churn. Override the FastAPI dependency for the whole session so
    `client.post("/generate", ...)` keeps working everywhere else.

    The real check is NOT weakened in production by this: dependency_overrides
    only exists inside this test process, and the check itself is unit- and
    end-to-end-tested directly in tests/test_auth.py (which temporarily pops
    this override to prove the route still enforces it for real).
    """
    app.dependency_overrides[require_shared_secret] = lambda: None
    yield
    app.dependency_overrides.pop(require_shared_secret, None)
