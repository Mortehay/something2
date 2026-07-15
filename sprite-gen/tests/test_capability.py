import sys
import types

from fastapi.testclient import TestClient

from app.config import detect_device, build_capability
from app.main import app

client = TestClient(app)


def _fake_torch(cuda_available: bool):
    mod = types.ModuleType("torch")
    mod.cuda = types.SimpleNamespace(is_available=lambda: cuda_available)
    return mod


def test_explicit_device_env_wins(monkeypatch):
    monkeypatch.setenv("DEVICE", "cuda")
    # Even with no CUDA visible, the explicit override is honored.
    assert detect_device() == "cuda"


def test_autodetect_cuda_present(monkeypatch):
    monkeypatch.delenv("DEVICE", raising=False)
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(True))
    assert detect_device() == "cuda"


def test_autodetect_cuda_absent(monkeypatch):
    monkeypatch.delenv("DEVICE", raising=False)
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(False))
    assert detect_device() == "cpu"


def test_missing_torch_degrades_to_cpu(monkeypatch):
    monkeypatch.delenv("DEVICE", raising=False)
    # Simulate torch not installed: importing it raises ImportError.
    monkeypatch.setitem(sys.modules, "torch", None)
    assert detect_device() == "cpu"


def test_capability_shapes():
    # recommended_backend mirrors the per-tier recipe backend.
    gpu = build_capability("cuda")
    assert gpu == {
        "device": "cuda",
        "cuda": True,
        "tier": "gpu",
        "recommended_backend": "sdxl",
    }
    cpu = build_capability("cpu")
    assert cpu == {
        "device": "cpu",
        "cuda": False,
        "tier": "cpu",
        "recommended_backend": "sd-turbo",
    }


def test_capability_endpoint():
    r = client.get("/capability")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"device", "cuda", "tier", "recommended_backend"}
    assert body["tier"] in ("gpu", "cpu")
    assert body["device"] in ("cpu", "cuda")


def test_health_includes_capability():
    r = client.get("/health")
    assert r.status_code == 200
    cap = r.json()["capability"]
    assert cap["tier"] in ("gpu", "cpu")
