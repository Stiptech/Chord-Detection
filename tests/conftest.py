import io

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app import config


@pytest.fixture
def client(tmp_path, monkeypatch):
    """TestClient dengan semua folder data dan database diarahkan ke tmp_path."""
    for attr, sub in [("AUDIO_DIR", "audio"), ("LABELS_DIR", "labels"), ("CACHE_DIR", "cache")]:
        monkeypatch.setattr(config, attr, tmp_path / sub)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    from app.main import app
    with TestClient(app) as c:  # 'with' menjalankan lifespan (buat folder + tabel)
        yield c


@pytest.fixture
def wav_bytes():
    """WAV sintetis 4 detik: C (2 dtk) lalu Am (2 dtk)."""
    sr = config.SAMPLE_RATE
    t = np.arange(2 * sr) / sr

    def tone(freqs):
        return sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs) * 0.5

    y = np.concatenate([tone([261.63, 329.63, 392.00]), tone([220.00, 261.63, 329.63])])
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV")
    return buf.getvalue()


@pytest.fixture
def no_ffmpeg_needed(monkeypatch):
    """Analisis dites tanpa ffmpeg: file upload (sudah wav 22050 mono) dipakai apa adanya."""
    monkeypatch.setattr("app.main.to_wav", lambda p: p)


@pytest.fixture
def upload(client):
    def _upload(data: bytes, filename: str = "lagu.wav") -> dict:
        r = client.post("/api/songs", files={"file": (filename, data, "application/octet-stream")})
        assert r.status_code == 201, r.text
        return r.json()
    return _upload
