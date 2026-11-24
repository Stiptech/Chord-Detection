"""SQLite untuk daftar lagu + lokasi/pembacaan file label.

Status lagu: uploaded, analyzing, ready, error
(fase 2b menambah: downloading, converting).
"""
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config
from .detectors.base import Segment
from .labels import read_lab

BUSY_STATUSES = ("analyzing", "downloading", "converting")
_FIELDS = {"name", "audio_file", "status", "error", "detector", "source_url", "source_key"}


@contextmanager
def _conn():
    # Satu koneksi per operasi: aman dipakai dari thread background task.
    con = sqlite3.connect(config.DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        with con:  # commit / rollback
            yield con
    finally:
        con.close()


def init_db() -> None:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _conn() as con:
        # AUTOINCREMENT: id tidak pernah dipakai ulang, jadi file label lama tak bisa tertukar.
        con.execute("""
            CREATE TABLE IF NOT EXISTS songs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                audio_file TEXT NOT NULL DEFAULT '',
                status     TEXT NOT NULL DEFAULT 'uploaded',
                error      TEXT,
                detector   TEXT,
                source_url TEXT,
                source_key TEXT,
                created_at TEXT NOT NULL
            )""")
        # Proses yang terputus karena server mati tidak boleh menggantung selamanya.
        marks = ",".join("?" * len(BUSY_STATUSES))
        con.execute(
            f"UPDATE songs SET status='error', error=? WHERE status IN ({marks})",
            ("Server berhenti saat proses berjalan. Coba lagi.", *BUSY_STATUSES))


def create_song(name: str, status: str = "uploaded", source_url: str | None = None,
                source_key: str | None = None) -> int:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _conn() as con:
        cur = con.execute(
            "INSERT INTO songs (name, status, source_url, source_key, created_at) VALUES (?,?,?,?,?)",
            (name, status, source_url, source_key, now))
        return cur.lastrowid


def get_song(song_id: int) -> dict | None:
    with _conn() as con:
        row = con.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    return dict(row) if row else None


def list_songs() -> list[dict]:
    with _conn() as con:
        rows = con.execute("SELECT * FROM songs ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


def update_song(song_id: int, **fields) -> None:
    bad = set(fields) - _FIELDS
    if bad:
        raise ValueError(f"Kolom tidak dikenal: {bad}")
    if not fields:
        return
    sets = ", ".join(f"{k}=?" for k in fields)
    with _conn() as con:
        con.execute(f"UPDATE songs SET {sets} WHERE id=?", (*fields.values(), song_id))


def claim_for_analysis(song_id: int) -> bool:
    """Atomik: tandai 'analyzing' kalau belum ada proses lain. False kalau sudah sibuk."""
    marks = ",".join("?" * len(BUSY_STATUSES))
    with _conn() as con:
        cur = con.execute(
            f"UPDATE songs SET status='analyzing', error=NULL WHERE id=? AND status NOT IN ({marks})",
            (song_id, *BUSY_STATUSES))
        return cur.rowcount == 1


def delete_song(song_id: int) -> None:
    """Hapus record, file audio, dan semua label lagu ini. Cache wav tidak disentuh (dipakai bersama)."""
    song = get_song(song_id)
    with _conn() as con:
        con.execute("DELETE FROM songs WHERE id=?", (song_id,))
    if song and song["audio_file"]:
        (config.AUDIO_DIR / song["audio_file"]).unlink(missing_ok=True)
    # "<id>.*.lab" tidak cocok dengan id lain (11.auto.lab tidak cocok untuk id 1).
    for p in config.LABELS_DIR.glob(f"{song_id}.*.lab"):
        p.unlink(missing_ok=True)


def label_path(song_id: int, version: str):
    if not re.fullmatch(r"[a-z0-9_]+", version):  # jaga-jaga path traversal
        raise ValueError(f"Nama versi label tidak valid: {version!r}")
    return config.LABELS_DIR / f"{song_id}.{version}.lab"


def has_corrected(song_id: int) -> bool:
    return label_path(song_id, "corrected").exists()


def load_chords(song_id: int, version: str) -> tuple[str, list[Segment]] | None:
    """Baca label versi tertentu. 'corrected' yang belum ada jatuh ke salinan 'auto'.

    Mengembalikan (versi yang sebenarnya dibaca, segmen) atau None bila belum ada label.
    """
    path = label_path(song_id, version)
    if not path.exists() and version == "corrected":
        version = "auto"
        path = label_path(song_id, "auto")
    if not path.exists():
        return None
    return version, read_lab(path)
