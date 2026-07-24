import pytest

from app.main import job_manager


@pytest.fixture
def no_real_work(monkeypatch):
    """Accept /generate but never actually run the backend.

    Several tests assert only on the RECIPE that /generate resolves, while
    passing no backend — which resolves to a real diffusion backend (sd-turbo /
    sdxl). Those tests never await the job, so it keeps running in the shared
    JobManager and starves the worker pool; later tests that DO await a stub job
    then time out. Nothing here weakens those assertions: the response body,
    including the resolved recipe, is unchanged.
    """
    monkeypatch.setattr(job_manager, "submit", lambda work: "test-job-not-run")
    return job_manager
