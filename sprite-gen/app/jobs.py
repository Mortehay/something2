import threading, queue, uuid

class JobManager:
    def __init__(self):
        self._jobs = {}
        self._q = queue.Queue()
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def submit(self, fn) -> str:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = {"id": job_id, "status": "queued",
                                  "progress": {"done": 0, "total": 0},
                                  "result": None, "error": None}
        self._q.put((job_id, fn))
        return job_id

    def _set(self, job_id, **kw):
        with self._lock:
            self._jobs[job_id].update(kw)

    def _progress(self, job_id):
        def cb(done, total):
            with self._lock:
                self._jobs[job_id]["progress"] = {"done": done, "total": total}
        return cb

    def _run(self):
        while True:
            job_id, fn = self._q.get()
            self._set(job_id, status="running")
            try:
                result = fn(self._progress(job_id))
                self._set(job_id, status="done", result=result)
            except Exception as e:  # noqa: BLE001 - report any failure to the client
                self._set(job_id, status="error", error=str(e))
            finally:
                self._q.task_done()

    def get(self, job_id):
        with self._lock:
            return dict(self._jobs.get(job_id)) if job_id in self._jobs else None
