"""Durable job store + concurrent workers (SOMET-539).

Job records live in Redis as (type, params) rather than a Python closure --
a closure cannot survive a process restart, and the whole point of this
store is that a restart does not lose work. `JobManager` is handed a
`handlers` map (job type -> `(params, progress) -> result`) and looks the
handler up by the job's stored type whether it is running the job for the
first time or replaying it after a restart.
"""

import json
import threading
import time
import uuid

from .config import settings

QUEUE_KEY = "sprite_gen:queue"
RUNNING_SET_KEY = "sprite_gen:running"
JOB_KEY_PREFIX = "sprite_gen:job:"
DEDUP_KEY_PREFIX = "sprite_gen:inflight:"


def _job_key(job_id: str) -> str:
    return f"{JOB_KEY_PREFIX}{job_id}"


def _dedup_key(dedup_key: str) -> str:
    return f"{DEDUP_KEY_PREFIX}{dedup_key}"


def _now() -> float:
    return time.time()


def build_redis_client():
    if settings.redis_backend == "fake":
        import fakeredis
        return fakeredis.FakeStrictRedis(decode_responses=True)
    import redis
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


class JobManager:
    def __init__(self, redis_client, handlers: dict, worker_count: int = None,
                deadline_seconds: int = None, max_retries: int = None,
                ttl_seconds: int = None, watchdog_interval: float = None,
                start: bool = True):
        self.redis = redis_client
        self.handlers = handlers
        self.worker_count = worker_count if worker_count is not None else settings.sprite_gen_workers
        self.deadline_seconds = (
            deadline_seconds if deadline_seconds is not None else settings.job_deadline_seconds
        )
        self.max_retries = max_retries if max_retries is not None else settings.job_max_retries
        self.ttl_seconds = ttl_seconds if ttl_seconds is not None else settings.job_ttl_seconds
        self.watchdog_interval = (
            watchdog_interval if watchdog_interval is not None else settings.job_watchdog_interval_seconds
        )
        self._stop = threading.Event()
        self._threads = []
        if start:
            self._requeue_orphaned_jobs()
            for _ in range(max(1, self.worker_count)):
                t = threading.Thread(target=self._worker_loop, daemon=True)
                t.start()
                self._threads.append(t)
            watchdog = threading.Thread(target=self._watchdog_loop, daemon=True)
            watchdog.start()
            self._threads.append(watchdog)

    # -- submission -----------------------------------------------------

    def submit(self, job_type: str, params: dict, job_id: str = None,
              dedup_key: str = None) -> str:
        """Enqueue a job and return its id.

        `job_id` lets a caller mint the id up front (e.g. to bake it into a
        storage key) and have it agree with the id this returns (SOMET-235).
        `dedup_key` collapses a resubmission of the same subject while one
        is already queued/running into the existing job id instead of
        starting a second generation -- sprite-gen owns this dedup, not the
        Node caller, which has no visibility into what is already queued
        here (pairs with SOMET-538).
        """
        if job_id is None:
            job_id = uuid.uuid4().hex

        if dedup_key:
            dk = _dedup_key(dedup_key)
            # SET ... NX is atomic: at most one submitter wins the dedup
            # pointer for a given key, even under concurrent requests.
            if not self.redis.set(dk, job_id, nx=True):
                existing_id = self.redis.get(dk)
                existing = self.get(existing_id) if existing_id else None
                if existing and existing["status"] in ("queued", "running"):
                    return existing_id
                # Stale pointer -- the previous job already reached a
                # terminal state (cleanup should have cleared this, but
                # defend against it anyway). Reclaim it for the new job.
                self.redis.set(dk, job_id)

        self.redis.hset(_job_key(job_id), mapping={
            "id": job_id,
            "type": job_type,
            "params": json.dumps(params),
            "status": "queued",
            "progress": json.dumps({"done": 0, "total": 0}),
            "result": "",
            "error": "",
            "dedup_key": dedup_key or "",
            "retries": "0",
            "attempt": "",
            "created_at": repr(_now()),
        })
        self.redis.rpush(QUEUE_KEY, job_id)
        return job_id

    def get(self, job_id: str):
        raw = self.redis.hgetall(_job_key(job_id))
        if not raw:
            return None
        return {
            "id": raw["id"],
            "status": raw["status"],
            "progress": json.loads(raw["progress"]) if raw.get("progress") else {"done": 0, "total": 0},
            "result": json.loads(raw["result"]) if raw.get("result") else None,
            "error": raw.get("error") or None,
            "retries": int(raw.get("retries") or 0),
        }

    def stop(self):
        self._stop.set()

    # -- startup: replay whatever a previous process left behind --------

    def _requeue_orphaned_jobs(self):
        """Rebuild the queue from the job records themselves.

        Called once before any worker starts. Nothing in THIS process can
        possibly be running a job yet, so any record still marked "running"
        belongs to a process that died mid-job -- it is reset to "queued".
        The queue list is then rebuilt from scratch in creation order so a
        crash that happened between writing the job hash and pushing the
        queue entry (or any other loss of the list itself) can't orphan a
        job permanently. This is what makes "submit, restart, poll the same
        id" resolve instead of 404ing.
        """
        self.redis.delete(RUNNING_SET_KEY)
        pending = []
        cursor = 0
        while True:
            cursor, keys = self.redis.scan(cursor, match=f"{JOB_KEY_PREFIX}*", count=200)
            for key in keys:
                raw = self.redis.hgetall(key)
                if not raw:
                    continue
                status = raw.get("status")
                if status in ("queued", "running"):
                    pending.append((float(raw.get("created_at") or 0), raw["id"]))
                    if status == "running":
                        self.redis.hset(key, mapping={"status": "queued", "attempt": ""})
            if cursor == 0:
                break
        self.redis.delete(QUEUE_KEY)
        for _, job_id in sorted(pending, key=lambda pair: pair[0]):
            self.redis.rpush(QUEUE_KEY, job_id)

    # -- workers ----------------------------------------------------------

    def _worker_loop(self):
        while not self._stop.is_set():
            popped = self.redis.blpop(QUEUE_KEY, timeout=1)
            if not popped:
                continue
            _, job_id = popped
            self._run_one(job_id)

    def _run_one(self, job_id: str):
        key = _job_key(job_id)
        raw = self.redis.hgetall(key)
        if not raw or raw.get("status") != "queued":
            # Already handled (e.g. a dedup resubmission, or the watchdog
            # already fenced and requeued it under a later attempt).
            return
        attempt = uuid.uuid4().hex
        deadline_at = _now() + self.deadline_seconds
        self.redis.hset(key, mapping={
            "status": "running",
            "started_at": repr(_now()),
            "deadline_at": repr(deadline_at),
            "attempt": attempt,
        })
        self.redis.sadd(RUNNING_SET_KEY, job_id)
        job_type = raw["type"]
        params = json.loads(raw["params"])
        try:
            handler = self.handlers.get(job_type)
            if handler is None:
                raise RuntimeError(f"no handler registered for job type '{job_type}'")
            result = handler(params, self._progress_cb(job_id, attempt))
            self._finish(job_id, attempt, status="done", result=result)
        except Exception as e:  # noqa: BLE001 - report any failure to the client
            self._finish(job_id, attempt, status="error", error=str(e))
        finally:
            self.redis.srem(RUNNING_SET_KEY, job_id)

    def _progress_cb(self, job_id: str, attempt: str):
        def cb(done, total):
            key = _job_key(job_id)
            if self.redis.hget(key, "attempt") != attempt:
                return  # superseded by a retry; this attempt's updates are dead
            self.redis.hset(key, "progress", json.dumps({"done": done, "total": total}))
        return cb

    def _finish(self, job_id: str, attempt: str, status: str, result=None, error: str = None):
        key = _job_key(job_id)
        if self.redis.hget(key, "attempt") != attempt:
            # The watchdog already fenced this attempt out (deadline
            # exceeded -> requeued or failed under a new attempt token) and
            # may already be running again elsewhere. A late result from a
            # worker thread that can't be forcibly cancelled must never
            # stomp whatever the newer attempt wrote -- drop it silently.
            return
        updates = {"status": status}
        if status == "done":
            updates["result"] = json.dumps(result)
        else:
            updates["error"] = error or ""
        self.redis.hset(key, mapping=updates)
        self._release_dedup(job_id)
        if self.ttl_seconds:
            self.redis.expire(key, self.ttl_seconds)

    def _release_dedup(self, job_id: str):
        key = _job_key(job_id)
        dedup_key = self.redis.hget(key, "dedup_key")
        if not dedup_key:
            return
        dk = _dedup_key(dedup_key)
        if self.redis.get(dk) == job_id:
            self.redis.delete(dk)

    # -- watchdog: wedged jobs fail with a reason instead of hanging ----

    def _watchdog_loop(self):
        while not self._stop.is_set():
            self._stop.wait(self.watchdog_interval)
            if self._stop.is_set():
                return
            self._sweep_wedged()

    def _sweep_wedged(self):
        """Flip a job's reported status for anything past its deadline.

        This cannot forcibly cancel the worker thread actually stuck inside
        the handler call -- Python threads have no safe preemptive kill, and
        subprocess isolation would break the test suite's backend-stubbing
        seam (`app.orchestrator.get_backend` is monkeypatched in-process).
        What it *can* do, and what the acceptance criterion actually asks
        for, is make GET /jobs/{id} report a reason instead of hanging: the
        attempt token above fences the eventually-returning (or
        never-returning) stuck worker out, so its result can't stomp a
        retried attempt, and a deployment sizes SPRITE_GEN_WORKERS with the
        knowledge that a truly wedged backend call keeps one worker busy
        forever.
        """
        now = _now()
        for job_id in list(self.redis.smembers(RUNNING_SET_KEY)):
            key = _job_key(job_id)
            raw = self.redis.hgetall(key)
            if not raw or raw.get("status") != "running":
                self.redis.srem(RUNNING_SET_KEY, job_id)
                continue
            deadline_at = float(raw.get("deadline_at") or 0)
            if now < deadline_at:
                continue
            self.redis.srem(RUNNING_SET_KEY, job_id)
            retries = int(raw.get("retries") or 0)
            if retries < self.max_retries:
                self.redis.hset(key, mapping={
                    "status": "queued",
                    "retries": str(retries + 1),
                    "attempt": "",
                    "error": f"deadline exceeded, retrying (attempt {retries + 1})",
                })
                self.redis.rpush(QUEUE_KEY, job_id)
            else:
                self.redis.hset(key, mapping={
                    "status": "error",
                    "attempt": "",
                    "retries": str(retries + 1),
                    "error": f"deadline exceeded after {retries + 1} attempts",
                })
                self._release_dedup(job_id)
                if self.ttl_seconds:
                    self.redis.expire(key, self.ttl_seconds)
