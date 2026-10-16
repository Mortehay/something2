import threading
import time

import fakeredis

from app.jobs import JobManager


def _redis():
    return fakeredis.FakeStrictRedis(decode_responses=True)


def _wait(manager, job_id, timeout=2, statuses=("done", "error")):
    for _ in range(int(timeout * 100)):
        job = manager.get(job_id)
        if job and job["status"] in statuses:
            return job
        time.sleep(0.01)
    raise AssertionError(f"job did not reach {statuses}")


def test_submit_generates_a_job_id_when_none_given():
    manager = JobManager(_redis(), {"echo": lambda params, progress: params["value"]})
    job_id = manager.submit("echo", {"value": "ok"})
    job = _wait(manager, job_id)
    assert job["id"] == job_id
    assert job["result"] == "ok"


def test_submit_uses_the_given_job_id_not_a_fresh_one():
    # SOMET-235: main.py's /generate handler mints its own job_id up front so
    # it can bake it into the storage key, and hands the SAME id to submit()
    # -- the id returned to the caller, the id keying the job record, and
    # the id baked into storage all have to agree. Prove submit() honors a
    # supplied id exactly rather than generating a new one.
    seen = {}

    def handler(params, progress):
        seen["job_id_inside_work"] = params["job_id"]
        return "done"

    manager = JobManager(_redis(), {"echo": handler})
    returned_id = manager.submit("echo", {"job_id": "job-abc123"}, job_id="job-abc123")
    assert returned_id == "job-abc123"
    job = _wait(manager, "job-abc123")
    assert job["id"] == "job-abc123"
    assert job["result"] == "done"
    assert seen["job_id_inside_work"] == "job-abc123"


def test_job_survives_a_restart():
    # SOMET-539 AC: submit, "restart" (a fresh JobManager over the SAME
    # Redis, exactly like a fresh process would see), poll the same id --
    # it resolves instead of 404ing. Block the first manager's single
    # worker on a gate so the restart happens genuinely mid-flight.
    r = _redis()
    gate = threading.Event()

    def slow_handler(params, progress):
        gate.wait(timeout=2)
        return "finished-after-restart"

    first = JobManager(r, {"slow": slow_handler}, worker_count=1)
    job_id = first.submit("slow", {})
    # Give the worker a moment to pick the job up and mark it running.
    for _ in range(200):
        if first.get(job_id)["status"] == "running":
            break
        time.sleep(0.01)
    assert first.get(job_id)["status"] == "running"

    first.stop()  # simulate the process going away mid-job

    second = JobManager(r, {"slow": slow_handler}, worker_count=1)
    # The restart's _requeue_orphaned_jobs reset the orphaned "running"
    # record back to "queued"; the new manager's worker should pick it up
    # and run it to completion.
    job = _wait(second, job_id, timeout=3, statuses=("queued", "running", "done", "error"))
    assert job["status"] in ("queued", "running", "done")
    gate.set()
    job = _wait(second, job_id)
    assert job["status"] == "done"
    assert job["result"] == "finished-after-restart"


def test_n4_workers_run_four_jobs_concurrently():
    # SOMET-539 AC: concurrency is real and measured by timing, not by
    # reading the worker_count config back.
    r = _redis()
    barrier = threading.Barrier(4, timeout=2)

    def handler(params, progress):
        barrier.wait()  # only returns once all 4 have arrived concurrently
        return "ok"

    manager = JobManager(r, {"slow": handler}, worker_count=4)
    job_ids = [manager.submit("slow", {}) for _ in range(4)]
    for job_id in job_ids:
        job = _wait(manager, job_id, timeout=2)
        assert job["result"] == "ok"


def test_n1_behaves_exactly_like_a_single_worker():
    r = _redis()
    order = []
    lock = threading.Lock()

    def handler(params, progress):
        with lock:
            order.append(params["n"])
        time.sleep(0.02)
        return params["n"]

    manager = JobManager(r, {"seq": handler}, worker_count=1)
    job_ids = [manager.submit("seq", {"n": i}) for i in range(3)]
    for job_id in job_ids:
        _wait(manager, job_id)
    assert order == [0, 1, 2]


def test_wedged_job_fails_with_a_reason_instead_of_hanging():
    # max_retries=0: the single worker is permanently stuck inside the
    # handler call (Python threads can't be preemptively killed -- see the
    # comment on _sweep_wedged), so there is no spare worker capacity to
    # drain a requeued retry. The watchdog's deadline sweep still has to
    # make GET /jobs/{id} report a reason instead of hanging, which is the
    # actual acceptance criterion here.
    r = _redis()
    never_returns = threading.Event()

    def wedged_handler(params, progress):
        never_returns.wait()  # never set -- simulates a hung backend call
        return "unreachable"

    manager = JobManager(
        r, {"wedge": wedged_handler}, worker_count=1,
        deadline_seconds=0.05, max_retries=0, watchdog_interval=0.02,
    )
    job_id = manager.submit("wedge", {})
    job = _wait(manager, job_id, timeout=3, statuses=("error",))
    assert job["status"] == "error"
    assert "deadline exceeded" in job["error"]
    assert job["retries"] == 1


def test_wedged_job_retries_and_recovers_with_spare_worker_capacity():
    # The companion to the test above: with a second worker free to pick up
    # the requeued retry, a job that wedged on its first attempt can still
    # finish successfully -- the bounded retry count isn't just a failure
    # path.
    r = _redis()
    never_returns = threading.Event()
    calls = {"n": 0}
    lock = threading.Lock()

    def handler(params, progress):
        with lock:
            calls["n"] += 1
            is_first_attempt = calls["n"] == 1
        if is_first_attempt:
            never_returns.wait()  # hang forever, forcing the watchdog to retry
        return "succeeded-on-retry"

    manager = JobManager(
        r, {"wedge": handler}, worker_count=2,
        deadline_seconds=0.05, max_retries=1, watchdog_interval=0.02,
    )
    job_id = manager.submit("wedge", {})
    job = _wait(manager, job_id, timeout=3)
    assert job["status"] == "done"
    assert job["result"] == "succeeded-on-retry"
    assert job["retries"] == 1


def test_dedup_collapses_a_resubmission_while_one_is_in_flight():
    r = _redis()
    release = threading.Event()

    def handler(params, progress):
        release.wait(timeout=2)
        return "done"

    manager = JobManager(r, {"slow": handler}, worker_count=1)
    first_id = manager.submit("slow", {}, dedup_key="creature:goblin")
    second_id = manager.submit("slow", {}, dedup_key="creature:goblin")
    assert first_id == second_id

    release.set()
    job = _wait(manager, first_id)
    assert job["status"] == "done"

    # Once finished, the dedup key is released -- a THIRD submission starts
    # a genuinely new job rather than colliding with the finished one.
    third_id = manager.submit("slow", {}, dedup_key="creature:goblin")
    assert third_id != first_id


def test_completed_job_gets_a_ttl_so_records_do_not_accumulate_forever():
    r = _redis()
    manager = JobManager(r, {"echo": lambda params, progress: "ok"},
                         worker_count=1, ttl_seconds=60)
    job_id = manager.submit("echo", {})
    _wait(manager, job_id)
    ttl = r.ttl(f"sprite_gen:job:{job_id}")
    assert 0 < ttl <= 60


def test_queued_job_has_no_ttl_so_a_slow_job_cannot_expire_mid_flight():
    r = _redis()
    gate = threading.Event()
    manager = JobManager(
        r, {"slow": lambda params, progress: gate.wait(timeout=2) or "ok"},
        worker_count=1, ttl_seconds=60,
    )
    job_id = manager.submit("slow", {})
    for _ in range(200):
        if manager.get(job_id)["status"] == "running":
            break
        time.sleep(0.01)
    assert r.ttl(f"sprite_gen:job:{job_id}") == -1  # no expiry while in flight
    gate.set()
    _wait(manager, job_id)


def test_dedup_is_scoped_to_the_key_not_global():
    r = _redis()
    manager = JobManager(r, {"echo": lambda params, progress: "ok"}, worker_count=1)
    goblin_id = manager.submit("echo", {}, dedup_key="creature:goblin")
    orc_id = manager.submit("echo", {}, dedup_key="creature:orc")
    assert goblin_id != orc_id


def test_late_returning_attempt_does_not_hide_its_retry_from_the_watchdog():
    # SOMET-539 rework, Defect 1. Attempt 1 overruns its deadline, the
    # watchdog fences it and requeues, worker 2 starts attempt 2 -- and THEN
    # attempt 1's handler returns late. Its result is correctly dropped, but
    # its cleanup used to remove the job id from the running set, which is
    # the only place the watchdog looks; attempt 2 then hung as "running"
    # forever. The slow-but-not-dead backend, the likeliest real case.
    r = _redis()
    never_returns = threading.Event()
    calls = {"n": 0}
    lock = threading.Lock()

    def handler(params, progress):
        with lock:
            calls["n"] += 1
            n = calls["n"]
        if n == 1:
            time.sleep(0.75)  # past the deadline, but it DOES come back
            return "late"
        never_returns.wait()  # attempt 2 wedges for real
        return "unreachable"

    manager = JobManager(
        r, {"slow": handler}, worker_count=2,
        deadline_seconds=0.5, max_retries=1, watchdog_interval=0.05,
    )
    job_id = manager.submit("slow", {})
    job = _wait(manager, job_id, timeout=3, statuses=("error",))
    assert job["error"] == "deadline exceeded after 2 attempts"
    assert job["retries"] == 2
    manager.stop()


def test_watchdog_never_requeues_a_job_that_finished_in_the_meantime():
    # The watchdog reads a record, decides it is past its deadline, then
    # writes. If the worker finishes in between, the fence must lose:
    # a "done" job must never be flipped back to "queued" and re-run.
    r = _redis()
    calls = {"n": 0}

    def handler(params, progress):
        calls["n"] += 1
        return "ok"

    manager = JobManager(r, {"h": handler}, worker_count=1, deadline_seconds=0,
                         max_retries=3, start=False)
    job_id = manager.submit("h", {})
    real_hgetall = manager.redis.hgetall
    finished = {"done": False}

    def hgetall_then_finish(key):
        raw = real_hgetall(key)
        # Simulate the worker's _finish landing right after the watchdog's read.
        if not finished["done"] and raw.get("status") == "running":
            finished["done"] = True
            manager._finish(job_id, raw["attempt"], status="done", result="ok")
        return raw

    # Put the job into "running" by hand, exactly as _run_one would.
    manager.redis.lpop("sprite_gen:queue")
    attempt = manager._mark_running(job_id)
    assert attempt
    manager.redis.hgetall = hgetall_then_finish
    manager._sweep_wedged()
    manager.redis.hgetall = real_hgetall

    job = manager.get(job_id)
    assert job["status"] == "done"
    assert job["result"] == "ok"
    assert manager.redis.llen("sprite_gen:queue") == 0


def test_restart_recovery_counts_as_an_attempt():
    # A job that kills the whole process (OOM inside the model) is left
    # "running" with no live worker. Recovering it at startup must count as
    # an attempt; otherwise it replays on every restart forever.
    r = _redis()
    seed = JobManager(r, {"h": lambda p, cb: "x"}, max_retries=1, start=False)
    job_id = seed.submit("h", {})
    r.lpop("sprite_gen:queue")
    seed._mark_running(job_id)

    # Restart 1: within budget -> requeued, retries=1.
    JobManager(r, {}, max_retries=1, start=False)._requeue_orphaned_jobs()
    raw = r.hgetall(f"sprite_gen:job:{job_id}")
    assert raw["status"] == "queued"
    assert raw["retries"] == "1"

    # It dies again mid-run; restart 2 exhausts the budget -> error, not queued.
    r.lpop("sprite_gen:queue")
    seed._mark_running(job_id)
    JobManager(r, {}, max_retries=1, start=False)._requeue_orphaned_jobs()
    job = seed.get(job_id)
    assert job["status"] == "error"
    assert "interrupted by restart" in job["error"]
    assert r.llen("sprite_gen:queue") == 0
