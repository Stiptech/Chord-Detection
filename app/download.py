"""Unduh audio dari link (YouTube dll.) lewat yt-dlp. Untuk pemakaian pribadi.

Dua langkah: fetch_info() (cepat, tanpa unduh: validasi playlist/livestream/durasi)
lalu download_audio(). Semua error dibungkus DownloadError dengan pesan yang bisa
langsung ditampilkan ke pengguna.
"""
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from . import config
from .audio import INSTALL_HINT

try:
    import yt_dlp
except ImportError:  # pragma: no cover - yt-dlp ada di requirements.txt
    yt_dlp = None

UPDATE_HINT = "pip install -U yt-dlp"


class DownloadError(Exception):
    """Pesan aman ditampilkan langsung ke pengguna."""


@dataclass
class VideoInfo:
    key: str | None  # "youtube:<id>", dipakai agar link yang sama tidak diunduh dua kali
    title: str
    duration: float | None


def validate_url(raw: str) -> str:
    url = (raw or "").strip()
    if not url:
        raise DownloadError("Link kosong.")
    if len(url) > 2000:
        raise DownloadError("Link terlalu panjang.")
    try:
        parts = urlparse(url)
    except ValueError:
        raise DownloadError("Link tidak valid.") from None
    if parts.scheme.lower() not in ("http", "https"):
        raise DownloadError("Link harus diawali http:// atau https://.")
    if not parts.hostname:
        raise DownloadError("Link tidak valid.")
    return url


_ANSI = re.compile(r"\x1b\[[0-9;]*m")

# (kata kunci huruf kecil, pesan). Urutan penting: yang pertama cocok menang.
_ERROR_RULES: list[tuple[tuple[str, ...], str]] = [
    (("private video", "sign in", "log in", "login required", "members-only", "confirm your age"),
     "Video ini privat atau meminta login/verifikasi, jadi tidak bisa diunduh. "
     f"Kalau video publik, coba perbarui yt-dlp ({UPDATE_HINT}); atau unduh audionya sendiri lalu upload."),
    (("in your country", "geo restrict", "geo-restrict"),
     "Video ini diblokir di wilayahmu."),
    (("ffmpeg",), INSTALL_HINT),
    (("unsupported url",), "Link ini tidak dikenali sebagai link video yang didukung."),
    (("video unavailable", "has been removed", "no longer available", "does not exist",
      "this video is not available", "account associated with this video has been terminated",
      "http error 404"),
     "Video tidak tersedia (sudah dihapus atau linknya salah)."),
    (("getaddrinfo", "name or service not known", "name resolution", "timed out", "timeout",
      "connection reset", "connection refused", "network is unreachable", "urlopen error"),
     "Tidak bisa terhubung ke internet atau situsnya. Periksa koneksi lalu coba lagi."),
    (("unable to extract", "nsig", "http error 403", "requested format is not available",
      "signature", "player response"),
     "Gagal membaca halaman video. Biasanya karena yt-dlp sudah kadaluarsa "
     f"(situs sering berubah). Jalankan `{UPDATE_HINT}` lalu mulai ulang server."),
]


def humanize_error(message: str) -> str:
    clean = _ANSI.sub("", message).strip()
    clean = re.sub(r"^ERROR:\s*", "", clean)
    low = clean.lower()
    for keywords, text in _ERROR_RULES:
        if any(k in low for k in keywords):
            return text
    first = (clean.splitlines() or ["alasan tidak diketahui"])[0][:200]
    return f"Gagal mengunduh: {first}. Kalau terus berulang, coba perbarui yt-dlp (`{UPDATE_HINT}`)."


def _require_ytdlp():
    if yt_dlp is None:
        raise DownloadError(f"yt-dlp belum terpasang. Jalankan `{UPDATE_HINT}`.")


def _base_opts() -> dict:
    return {
        "quiet": True, "no_warnings": True, "noprogress": True,
        "noplaylist": True,  # watch?v=X&list=Y -> hanya video X
        "ignoreconfig": True,  # abaikan yt-dlp.conf pengguna agar perilaku konsisten
        "socket_timeout": config.DOWNLOAD_SOCKET_TIMEOUT,
    }


def fetch_info(url: str) -> VideoInfo:
    """Ambil metadata tanpa mengunduh dan tolak playlist, livestream, dan video terlalu panjang."""
    _require_ytdlp()
    opts = {**_base_opts(), "extract_flat": "in_playlist"}  # jangan urai isi playlist
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        raise DownloadError(humanize_error(str(e))) from e
    if not info:
        raise DownloadError("Tidak ada video yang ditemukan di link ini.")

    if info.get("_type") in ("playlist", "multi_video") or "entries" in info:
        raise DownloadError("Link ini playlist atau kumpulan video. Tempel link satu video saja.")
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise DownloadError("Siaran langsung (livestream) tidak didukung.")
    duration = info.get("duration")
    if duration and duration > config.MAX_DOWNLOAD_SEC:
        raise DownloadError(
            f"Video terlalu panjang ({int(duration // 60)} menit). Batasnya "
            f"{config.MAX_DOWNLOAD_SEC // 60} menit (ubah MAX_DOWNLOAD_SEC di app/config.py).")

    extractor = info.get("extractor_key") or info.get("extractor")
    key = f"{extractor.lower()}:{info['id']}" if extractor and info.get("id") else None
    return VideoInfo(key=key, title=info.get("title") or "", duration=duration)


def download_audio(url: str, dest_dir: Path) -> Path:
    """Unduh audio terbaik ke dest_dir, kembalikan path file. Tanpa konversi (itu tugas audio.py)."""
    _require_ytdlp()
    dest_dir = Path(dest_dir)
    opts = {**_base_opts(), "format": config.DOWNLOAD_FORMAT,
            "outtmpl": str(dest_dir / "%(id)s.%(ext)s"), "restrictfilenames": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=True)
    except Exception as e:
        raise DownloadError(humanize_error(str(e))) from e
    files = [p for p in dest_dir.iterdir()
             if p.is_file() and p.suffix not in (".part", ".ytdl", ".temp")]
    if not files:
        raise DownloadError("Unduhan selesai tapi tidak ada file yang dihasilkan.")
    return max(files, key=lambda p: p.stat().st_size)
