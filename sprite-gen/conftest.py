import pytest
from unittest.mock import patch
from app.backends.stub import StubBackend


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
