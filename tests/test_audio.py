import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf

from app import audio, config
from app.audio import AudioError, file_hash, to_wav


def test_missing_file(tmp_path):
    with pytest.raises(AudioError, match="tidak ditemukan"):
        to_wav(tmp_path / "nope.mp3", cache_dir=tmp_path)


def test_missing_ffmpeg_gives_install_hint(tmp_path, monkeypatch):
    src = tmp_path / "a.mp3"
    src.write_bytes(b"x")
    monkeypatch.setattr(config, "FFMPEG_BIN", "ffmpeg-yang-tidak-ada")
    with pytest.raises(AudioError, match="ffmpeg tidak ditemukan"):
        to_wav(src, cache_dir=tmp_path / "cache")


def test_cache_by_content_hash(tmp_path, monkeypatch):
    """ffmpeg dipalsukan: cek perintahnya benar dan file identik tidak dikonversi dua kali."""
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        sf.write(cmd[-1], np.zeros(100), config.SAMPLE_RATE)  # argumen terakhir = file keluaran
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(audio, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(audio.subprocess, "run", fake_run)

    a = tmp_path / "a.mp4"
    b = tmp_path / "salinan.mp4"  # nama beda, isi sama
    a.write_bytes(b"isi video")
    b.write_bytes(b"isi video")
    cache = tmp_path / "cache"

    out_a = to_wav(a, cache)
    out_b = to_wav(b, cache)
    assert out_a == out_b == cache / f"{file_hash(a)}.wav"
    assert len(calls) == 1
    cmd = calls[0]
    assert "-vn" in cmd and cmd[cmd.index("-ac") + 1] == "1"
    assert cmd[cmd.index("-ar") + 1] == str(config.SAMPLE_RATE)
    assert not list(cache.glob("*.tmp.wav"))


def test_ffmpeg_failure_is_humanized(tmp_path, monkeypatch):
    def fake_run(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 1, "", "x.mp3: Invalid data found when processing input")

    monkeypatch.setattr(audio, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(audio.subprocess, "run", fake_run)
    src = tmp_path / "x.mp3"
    src.write_bytes(b"bukan audio")
    with pytest.raises(AudioError, match="rusak"):
        to_wav(src, cache_dir=tmp_path / "cache")


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg belum terpasang")
def test_real_ffmpeg_conversion(tmp_path):
    src = tmp_path / "stereo44k.wav"
    sf.write(src, np.random.randn(44100, 2) * 0.1, 44100)
    out = to_wav(src, cache_dir=tmp_path / "cache")
    info = sf.info(out)
    assert info.samplerate == config.SAMPLE_RATE and info.channels == 1
