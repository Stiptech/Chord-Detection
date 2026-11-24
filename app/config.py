"""Semua parameter yang bisa dituning ada di sini."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
AUDIO_DIR = DATA_DIR / "audio"
LABELS_DIR = DATA_DIR / "labels"
CACHE_DIR = DATA_DIR / "cache"
DB_PATH = DATA_DIR / "chordfinder.db"
STATIC_DIR = ROOT / "app" / "static"

FFMPEG_BIN = "ffmpeg"

# --- Unduhan dari link (yt-dlp) ---
MAX_DOWNLOAD_SEC = 15 * 60  # video lebih panjang ditolak (menghindari livestream/video berjam-jam)
DOWNLOAD_SOCKET_TIMEOUT = 20  # detik; supaya tidak menggantung bila koneksi mati
# Utamakan m4a (AAC): bisa diputar Safari/iPad. webm/opus tidak selalu bisa.
DOWNLOAD_FORMAT = "bestaudio[ext=m4a]/bestaudio/best"

# --- Audio ---
SAMPLE_RATE = 22050
HOP_LENGTH = 2048  # ~93 ms per frame pada 22050 Hz

# --- Detector baseline ---
# Suhu softmax: kecil = keputusan tegas, besar = distribusi landai.
SOFTMAX_TEMPERATURE = 0.1
# Probabilitas bertahan di chord yang sama antar frame (Viterbi).
# Makin tinggi, makin halus tapi makin lambat menangkap chord lewat yang cepat.
TRANSITION_LOOP = 0.9
# Segmen lebih pendek dari ini digabung ke tetangganya.
MIN_SEGMENT_SEC = 0.3
# Frame dengan energi < SILENCE_RATIO * (persentil 95 energi) dianggap tanpa chord (N).
SILENCE_RATIO = 0.05

# Bias tambahan pada skor kemiripan. Kualitas yang lebih "kompleks" diberi
# penalti kecil supaya triad tidak sering kalah oleh chord 4 nada hanya karena
# nada melodi/pad ikut tertangkap. Nilai negatif = lebih sulit terpilih.
QUALITY_BIAS = {
    "": 0.0,
    "m": 0.0,
    "sus2": -0.03,
    "sus4": -0.03,
    "7": -0.03,
    "maj7": -0.03,
    "m7": -0.03,
}
# Chroma yang datar (tidak ada nada dominan) mirip semua chord; penalti ini
# mencegah N terpilih pada audio berpad tebal yang chroma-nya kabur.
NO_CHORD_BIAS = -0.1
