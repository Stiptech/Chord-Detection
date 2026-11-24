"""Tes download.py dengan yt-dlp palsu. Tidak ada akses jaringan."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import config, download
from app.download import DownloadError, fetch_info, humanize_error, validate_url


class FakeYDL:
    """Pengganti yt_dlp.YoutubeDL. Atur info/error lewat atribut kelas."""
    info: dict | None = None
    error: Exception | None = None
    last_opts: dict = {}

    def __init__(self, opts):
        FakeYDL.last_opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=False):
        if FakeYDL.error:
            raise FakeYDL.error
        if download:  # yt-dlp asli menulis file sesuai outtmpl
            out = Path(FakeYDL.last_opts["outtmpl"]).parent
            (out / "abc123.m4a").write_bytes(b"audio" * 100)
            (out / "abc123.m4a.part").write_bytes(b"x")  # sisa sementara harus diabaikan
        return FakeYDL.info


@pytest.fixture
def fake_ydl(monkeypatch):
    FakeYDL.info, FakeYDL.error, FakeYDL.last_opts = None, None, {}
    monkeypatch.setattr(download, "yt_dlp", SimpleNamespace(YoutubeDL=FakeYDL))
    return FakeYDL


def video(**kw):
    return {"id": "abc123", "extractor_key": "Youtube", "title": "Bagi Mu Tuhan", "duration": 240, **kw}


# ---------- validate_url ----------

@pytest.mark.parametrize("url", ["https://youtu.be/abc", "http://example.com/v?x=1", "  https://a.co/x  "])
def test_validate_url_accepts_http_and_https(url):
    assert validate_url(url) == url.strip()


@pytest.mark.parametrize("url", ["", "   ", "ftp://x.com/a", "file:///etc/passwd", "javascript:alert(1)",
                                 "youtube.com/watch?v=1", "https://", "http:///x", "x" * 2001])
def test_validate_url_rejects_others(url):
    with pytest.raises(DownloadError):
        validate_url(url)


# ---------- fetch_info ----------

def test_fetch_info_ok(fake_ydl):
    fake_ydl.info = video()
    info = fetch_info("https://youtu.be/abc123")
    assert (info.key, info.title, info.duration) == ("youtube:abc123", "Bagi Mu Tuhan", 240)
    assert fake_ydl.last_opts["noplaylist"] is True


def test_fetch_info_rejects_playlist(fake_ydl):
    fake_ydl.info = {"_type": "playlist", "entries": [video()], "id": "PL1"}
    with pytest.raises(DownloadError, match="playlist"):
        fetch_info("https://youtube.com/playlist?list=PL1")


@pytest.mark.parametrize("extra", [{"is_live": True}, {"live_status": "is_live"}, {"live_status": "is_upcoming"}])
def test_fetch_info_rejects_livestream(fake_ydl, extra):
    fake_ydl.info = video(**extra)
    with pytest.raises(DownloadError, match="langsung"):
        fetch_info("https://youtu.be/abc123")


def test_fetch_info_rejects_too_long(fake_ydl, monkeypatch):
    monkeypatch.setattr(config, "MAX_DOWNLOAD_SEC", 600)
    fake_ydl.info = video(duration=601)
    with pytest.raises(DownloadError, match="terlalu panjang"):
        fetch_info("https://youtu.be/abc123")
    fake_ydl.info = video(duration=600)  # tepat di batas masih boleh
    assert fetch_info("https://youtu.be/abc123").duration == 600


def test_fetch_info_ytdlp_error_is_humanized(fake_ydl):
    fake_ydl.error = RuntimeError("\x1b[0;31mERROR:\x1b[0m [youtube] abc: Private video. Sign in if you've been granted access")
    with pytest.raises(DownloadError, match="privat"):
        fetch_info("https://youtu.be/abc123")


def test_fetch_info_without_ytdlp_installed(monkeypatch):
    monkeypatch.setattr(download, "yt_dlp", None)
    with pytest.raises(DownloadError, match="pip install -U yt-dlp"):
        fetch_info("https://youtu.be/abc123")


# ---------- humanize_error ----------

@pytest.mark.parametrize("raw, fragment", [
    ("ERROR: [youtube] x: Video unavailable", "tidak tersedia"),
    ("ERROR: [youtube] x: The uploader has not made this video available in your country", "diblokir"),
    ("ERROR: [youtube] x: Video unavailable. This video is not available in your country", "diblokir"),
    ("ERROR: Unsupported URL: https://example.com/", "tidak dikenali"),
    ("ERROR: Unable to extract uploader id", "kadaluarsa"),
    ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "pip install -U yt-dlp"),
    ("ERROR: [Errno 11001] getaddrinfo failed", "internet"),
    ("ERROR: ffprobe and ffmpeg not found", "ffmpeg tidak ditemukan"),
    ("ERROR: sesuatu yang aneh\nbaris dua", "sesuatu yang aneh"),
])
def test_humanize_error(raw, fragment):
    assert fragment in humanize_error(raw)


def test_humanize_unknown_error_suggests_update_and_hides_extra_lines():
    msg = humanize_error("ERROR: aneh\nTraceback baris rahasia")
    assert "pip install -U yt-dlp" in msg and "Traceback" not in msg


# ---------- download_audio ----------

def test_download_audio_returns_file_and_ignores_partials(fake_ydl, tmp_path):
    path = download.download_audio("https://youtu.be/abc123", tmp_path)
    assert path == tmp_path / "abc123.m4a"
    opts = fake_ydl.last_opts
    assert opts["format"] == config.DOWNLOAD_FORMAT
    assert opts["outtmpl"].startswith(str(tmp_path)) and opts["noplaylist"] is True


def test_download_audio_error_is_humanized(fake_ydl, tmp_path):
    fake_ydl.error = RuntimeError("ERROR: [youtube] x: Video unavailable")
    with pytest.raises(DownloadError, match="tidak tersedia"):
        download.download_audio("https://youtu.be/abc123", tmp_path)
