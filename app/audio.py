"""Konversi file audio/video apa pun (yang bisa dibaca ffmpeg) ke wav mono 22050 Hz."""
import hashlib
import shutil
import subprocess
from pathlib import Path

import librosa
import numpy as np

from . import config


class AudioError(Exception):
    """Error yang pesannya aman ditampilkan langsung ke pengguna."""


INSTALL_HINT = (
    "ffmpeg tidak ditemukan. Pasang dulu: Windows `winget install Gyan.FFmpeg`, "
    "Mac `brew install ffmpeg`, Linux `sudo apt install ffmpeg`. "
    "Lalu buka ulang terminal."
)


def find_ffmpeg() -> str:
    path = shutil.which(config.FFMPEG_BIN)
    if not path:
        raise AudioError(INSTALL_HINT)
    return path


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _explain(stderr: str) -> str:
    low = stderr.lower()
    if "invalid data found" in low or "moov atom not found" in low:
        return "File rusak atau formatnya tidak didukung."
    if "does not contain any stream" in low or "output file is empty" in low:
        return "File ini tidak punya trek audio."
    last = stderr.strip().splitlines()[-1] if stderr.strip() else "alasan tidak diketahui"
    return f"ffmpeg gagal mengonversi file: {last}"


def to_wav(src: str | Path, cache_dir: str | Path | None = None) -> Path:
    """Konversi src ke wav mono 22050 Hz. Hasil di-cache menurut hash isi file."""
    src = Path(src).resolve()
    if not src.is_file():
        raise AudioError(f"File tidak ditemukan: {src}")
    cache_dir = Path(cache_dir or config.CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)

    out = cache_dir / f"{file_hash(src)}.wav"
    if out.exists() and out.stat().st_size > 0:
        return out

    ffmpeg = find_ffmpeg()
    tmp = out.with_suffix(".tmp.wav")  # tulis ke tmp dulu supaya cache tidak pernah setengah jadi
    cmd = [ffmpeg, "-nostdin", "-y", "-v", "error", "-i", str(src),
           "-vn", "-ac", "1", "-ar", str(config.SAMPLE_RATE), "-f", "wav", str(tmp)]
    try:
        result = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")
    except OSError as e:
        raise AudioError(f"Gagal menjalankan ffmpeg: {e}") from e
    if result.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        raise AudioError(_explain(result.stderr))
    tmp.replace(out)
    return out


def load_audio(wav_path: str | Path) -> tuple[np.ndarray, int]:
    """Muat wav sebagai float mono pada sample rate konfigurasi."""
    try:
        return librosa.load(str(wav_path), sr=config.SAMPLE_RATE, mono=True)
    except Exception as e:  # soundfile/audioread melempar beragam tipe error
        raise AudioError(f"Tidak bisa membaca audio {wav_path}: {e}") from e
