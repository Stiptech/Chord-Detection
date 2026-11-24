"""FastAPI app + semua route. Dokumentasi interaktif: http://localhost:8000/docs"""
import logging
import math
import mimetypes
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, storage
from .audio import AudioError, to_wav
from .detectors.base import Segment
from .detectors.registry import DETECTORS, get_detector
from .labels import is_valid_chord, write_lab

log = logging.getLogger(__name__)

# mimetypes bawaan Python tidak konsisten untuk m4a/mp4; Safari butuh tipe yang benar.
MEDIA_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4",
               ".wav": "audio/wav", ".webm": "video/webm", ".ogg": "audio/ogg"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    for d in (config.AUDIO_DIR, config.LABELS_DIR, config.CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)
    storage.init_db()
    yield


app = FastAPI(title="Chord Finder", lifespan=lifespan)


# ---------- helper ----------

def _song_or_404(song_id: int) -> dict:
    song = storage.get_song(song_id)
    if song is None:
        raise HTTPException(404, "Lagu tidak ditemukan.")
    return song


def _public(song: dict) -> dict:
    """Bentuk JSON untuk klien (tanpa nama file internal)."""
    return {
        "id": song["id"], "name": song["name"], "status": song["status"],
        "error": song["error"], "detector": song["detector"],
        "source_url": song["source_url"], "created_at": song["created_at"],
        "has_corrected": storage.has_corrected(song["id"]),
    }


def _check_version(version: str) -> None:
    if version not in ("auto", "corrected") and version not in DETECTORS:
        raise HTTPException(400, f"Versi '{version}' tidak dikenal. Pakai auto, corrected, "
                                 f"atau nama detector ({', '.join(sorted(DETECTORS))}).")


def _attachment(filename: str) -> dict:
    ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", filename) or "export"
    return {"Content-Disposition":
            f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"}


# ---------- upload & daftar ----------

@app.post("/api/songs", status_code=201)
def upload_song(file: UploadFile = File(...)):
    original = re.split(r"[\\/]", file.filename or "")[-1]
    stem, dot, ext = original.rpartition(".")
    if not dot:
        stem, ext = original, ""
    name = re.sub(r"[\x00-\x1f]", "", stem).strip()[:200] or "Tanpa judul"
    ext = ("." + ext.lower()) if re.fullmatch(r"[A-Za-z0-9]{1,5}", ext) else ""

    song_id = storage.create_song(name)
    dest = config.AUDIO_DIR / f"{song_id}{ext}"
    try:
        with open(dest, "wb") as out:
            shutil.copyfileobj(file.file, out)
        if dest.stat().st_size == 0:
            raise HTTPException(400, "File kosong.")
        storage.update_song(song_id, audio_file=dest.name)
    except BaseException:
        dest.unlink(missing_ok=True)
        storage.delete_song(song_id)
        raise
    return _public(storage.get_song(song_id))


@app.get("/api/songs")
def list_songs():
    return [_public(s) for s in storage.list_songs()]


@app.get("/api/songs/{song_id}")
def get_song(song_id: int):
    return _public(_song_or_404(song_id))


# ---------- analisis ----------

def run_analysis(song_id: int, detector_name: str) -> None:
    """Berjalan di background task. Hasil/galat dicatat di status lagu (bisa dipoll)."""
    try:
        song = storage.get_song(song_id)
        if song is None:
            return
        wav = to_wav(config.AUDIO_DIR / song["audio_file"])
        segments = get_detector(detector_name).detect(wav)
        write_lab(storage.label_path(song_id, detector_name), segments)
        # 'auto' = hasil analisis terakhir. Tidak pernah disentuh oleh koreksi.
        write_lab(storage.label_path(song_id, "auto"), segments)
        storage.update_song(song_id, status="ready", error=None, detector=detector_name)
    except AudioError as e:
        storage.update_song(song_id, status="error", error=str(e))
    except Exception as e:  # jangan biarkan status menggantung di 'analyzing'
        log.exception("Analisis lagu %s gagal", song_id)
        storage.update_song(song_id, status="error", error=f"Analisis gagal: {e}")


@app.post("/api/songs/{song_id}/analyze", status_code=202)
def analyze(song_id: int, background: BackgroundTasks, detector: str = "baseline"):
    song = _song_or_404(song_id)
    if detector not in DETECTORS:
        raise HTTPException(400, f"Detector '{detector}' tidak dikenal. "
                                 f"Tersedia: {', '.join(sorted(DETECTORS))}")
    if not song["audio_file"] or not (config.AUDIO_DIR / song["audio_file"]).is_file():
        raise HTTPException(409, "Audio belum tersedia untuk lagu ini.")
    if not storage.claim_for_analysis(song_id):
        raise HTTPException(409, "Lagu ini sedang diproses. Tunggu sampai selesai.")
    background.add_task(run_analysis, song_id, detector)
    return _public(storage.get_song(song_id))


# ---------- chord ----------

class SegmentIn(BaseModel):
    start: float
    end: float
    label: str


class ChordsIn(BaseModel):
    segments: list[SegmentIn]


def validate_segments(items: list[SegmentIn]) -> list[Segment]:
    """Waktu dibulatkan ke milidetik (sama dengan isi .lab), lalu dicek urut & tak tumpang tindih."""
    if not items:
        raise ValueError("Minimal harus ada 1 segmen.")
    segs: list[Segment] = []
    for n, it in enumerate(items, 1):
        if not (math.isfinite(it.start) and math.isfinite(it.end)):
            raise ValueError(f"Segmen {n}: waktu harus berupa angka biasa.")
        start, end, label = round(it.start, 3), round(it.end, 3), it.label.strip()
        if start < 0:
            raise ValueError(f"Segmen {n}: waktu mulai tidak boleh negatif.")
        if end <= start:
            raise ValueError(f"Segmen {n}: waktu akhir harus setelah waktu mulai.")
        if not is_valid_chord(label):
            raise ValueError(f"Segmen {n}: chord '{label}' tidak valid.")
        if segs and start < segs[-1].end:
            raise ValueError(f"Segmen {n}: tumpang tindih atau tidak berurutan dengan segmen sebelumnya.")
        segs.append(Segment(start, end, label))
    return segs


@app.get("/api/songs/{song_id}/chords")
def get_chords(song_id: int, version: str = "auto"):
    _song_or_404(song_id)
    _check_version(version)
    loaded = storage.load_chords(song_id, version)
    if loaded is None:
        raise HTTPException(404, "Belum ada hasil analisis untuk lagu ini.")
    actual, segs = loaded  # 'version' bisa 'auto' bila corrected belum ada
    return {"version": actual,
            "segments": [{"start": s.start, "end": s.end, "label": s.label} for s in segs]}


@app.put("/api/songs/{song_id}/chords")
def put_chords(song_id: int, body: ChordsIn):
    _song_or_404(song_id)
    try:
        segs = validate_segments(body.segments)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    write_lab(storage.label_path(song_id, "corrected"), segs)
    return {"saved": len(segs)}


# ---------- audio, ekspor, hapus ----------

@app.get("/api/songs/{song_id}/audio")
def get_audio(song_id: int):
    song = _song_or_404(song_id)
    path = config.AUDIO_DIR / song["audio_file"] if song["audio_file"] else None
    if path is None or not path.is_file():
        raise HTTPException(404, "File audio tidak ada.")
    media = MEDIA_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] \
        or "application/octet-stream"
    # FileResponse (Starlette) menangani header Range -> 206, yang dibutuhkan seek di Safari.
    return FileResponse(path, media_type=media)


@app.get("/api/songs/{song_id}/export")
def export_chords(song_id: int, format: str = Query("lab", pattern="^(lab|txt)$"),
                  version: str = "corrected"):
    song = _song_or_404(song_id)
    _check_version(version)
    loaded = storage.load_chords(song_id, version)
    if loaded is None:
        raise HTTPException(404, "Belum ada hasil analisis untuk lagu ini.")
    _, segs = loaded
    if format == "lab":
        text = "".join(f"{s.start:.3f}\t{s.end:.3f}\t{s.label}\n" for s in segs)
    else:
        # Teks sederhana: 4 chord per baris, tanpa 'N'.
        chords = [s.label for s in segs if s.label != "N"]
        text = "".join(" ".join(chords[i:i + 4]) + "\n" for i in range(0, len(chords), 4))
    return PlainTextResponse(text, headers=_attachment(f"{song['name']}.{format}"))


@app.delete("/api/songs/{song_id}", status_code=204)
def delete_song(song_id: int):
    song = _song_or_404(song_id)
    if song["status"] in storage.BUSY_STATUSES:
        raise HTTPException(409, "Lagu sedang diproses. Tunggu sampai selesai sebelum menghapus.")
    storage.delete_song(song_id)
    return Response(status_code=204)


# Frontend (fase 3) disajikan dari app/static. Dipasang paling akhir supaya /api menang.
app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
