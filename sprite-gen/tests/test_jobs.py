import time

from app.jobs import JobManager


def _wait(manager, job_id, timeout=2):
    for _ in range(int(timeout * 100)):
        job = manager.get(job_id)
        if job and job["status"] in ("done", "error"):
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_submit_generates_a_job_id_when_none_given():
    manager = JobManager()
    job_id = manager.submit(lambda progress: "ok")
    job = _wait(manager, job_id)
    assert job["id"] == job_id
    assert job["result"] == "ok"


def test_submit_uses_the_given_job_id_not_a_fresh_one():
    # SOMET-235: main.py's /generate handler mints its own job_id up front so
    # it can close over it in `work` (to key the storage path) and hand the
    # SAME id to submit() -- the id returned to the caller, the id keying
    # _jobs, and the id baked into storage all have to agree. Prove submit()
    # honors a supplied id exactly rather than generating a new one.
    manager = JobManager()
    seen = {}

    def work(progress):
        seen["job_id_inside_work"] = "job-abc123"
        return "done"

    returned_id = manager.submit(work, job_id="job-abc123")
    assert returned_id == "job-abc123"
    job = _wait(manager, "job-abc123")
    assert job["id"] == "job-abc123"
    assert job["result"] == "done"
    assert seen["job_id_inside_work"] == "job-abc123"
