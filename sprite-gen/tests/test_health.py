from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["device"] in ("cpu", "cuda")
    assert body["default_backend"] == "stub"  # safe default


def test_health_reports_an_unreachable_job_store(monkeypatch):
    # SOMET-539: with Redis down no job can run; /health must not stay green.
    from redis.exceptions import ConnectionError as RedisConnectionError
    from app.main import job_manager

    def down():
        raise RedisConnectionError("Error 111 connecting to redis:6379. Connection refused.")

    monkeypatch.setattr(job_manager.redis, "ping", down)
    r = client.get("/health")
    assert r.status_code == 503
    assert r.json()["status"] == "degraded"
    assert r.json()["job_store"] == "unreachable"


def test_health_reports_a_reachable_job_store():
    r = client.get("/health")
    assert r.json()["job_store"] == "ok"
