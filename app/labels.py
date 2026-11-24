"""Baca/tulis file .lab dan konversi notasi chord aplikasi <-> Harte.

Notasi aplikasi : C, Dm, Dsus2, C7, Cmaj7, Am7, Cadd9, G/B, N
Notasi Harte    : C:maj, D:min, D:sus2, C:7, C:maj7, A:min7, C:maj(9), G:maj/3, N
"""
import logging
import re
from pathlib import Path
from typing import NamedTuple

from .detectors.base import Segment

log = logging.getLogger(__name__)

SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
_NATURAL_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# suffix aplikasi -> (kualitas Harte, interval dalam semiton dari root)
CHORD_QUALITIES: dict[str, tuple[str, tuple[int, ...]]] = {
    "": ("maj", (0, 4, 7)),
    "m": ("min", (0, 3, 7)),
    "sus2": ("sus2", (0, 2, 7)),
    "sus4": ("sus4", (0, 5, 7)),
    "7": ("7", (0, 4, 7, 10)),
    "maj7": ("maj7", (0, 4, 7, 11)),
    "m7": ("min7", (0, 3, 7, 10)),
    "add9": ("maj(9)", (0, 4, 7, 2)),
    # Di bawah ini tidak dideteksi baseline, tapi boleh dipakai saat koreksi manual.
    "madd9": ("min(9)", (0, 3, 7, 2)),
    "dim": ("dim", (0, 3, 6)),
    "aug": ("aug", (0, 4, 8)),
    "6": ("maj6", (0, 4, 7, 9)),
    "m6": ("min6", (0, 3, 7, 9)),
    "9": ("9", (0, 4, 7, 10, 2)),
    "maj9": ("maj9", (0, 4, 7, 11, 2)),
    "m9": ("min9", (0, 3, 7, 10, 2)),
    "m7b5": ("hdim7", (0, 3, 6, 10)),
    "dim7": ("dim7", (0, 3, 6, 9)),
}
_HARTE_TO_SUFFIX = {harte: suffix for suffix, (harte, _) in CHORD_QUALITIES.items()}

# Interval bass dalam semiton <-> derajat Harte
_SEMITONE_TO_DEGREE = {0: "1", 1: "b2", 2: "2", 3: "b3", 4: "3", 5: "4",
                       6: "b5", 7: "5", 8: "b6", 9: "6", 10: "b7", 11: "7"}
_DEGREE_TO_SEMITONE = {d: s for s, d in _SEMITONE_TO_DEGREE.items()}
_DEGREE_TO_SEMITONE["#4"] = 6

_CHORD_RE = re.compile(r"^([A-G])([#b]?)([^/]*)(?:/([A-G][#b]?))?$")


class ParsedChord(NamedTuple):
    root: str  # ejaan asli, mis. "Bb"
    root_pc: int
    suffix: str  # "", "m", "sus2", ...
    bass: str | None
    bass_pc: int | None


def _note_pc(letter: str, acc: str) -> int:
    return (_NATURAL_PC[letter] + {"#": 1, "b": -1, "": 0}[acc]) % 12


def parse_chord(name: str, strict: bool = True) -> ParsedChord:
    """Urai nama chord. strict=True menolak suffix yang tidak dikenal."""
    m = _CHORD_RE.match(name.strip())
    if not m:
        raise ValueError(f"Nama chord tidak valid: {name!r}")
    letter, acc, suffix, bass = m.groups()
    if strict and suffix not in CHORD_QUALITIES:
        raise ValueError(f"Jenis chord tidak dikenal: {name!r}")
    bass_pc = _note_pc(bass[0], bass[1:]) if bass else None
    return ParsedChord(letter + acc, _note_pc(letter, acc), suffix, bass, bass_pc)


def is_valid_chord(name: str) -> bool:
    if name == "N":
        return True
    try:
        parse_chord(name)
    except ValueError:
        return False
    return True


def app_to_harte(name: str) -> str:
    """Notasi aplikasi -> Harte. Chord yang tak terpetakan jatuh ke triad terdekat."""
    if name == "N":
        return "N"
    p = parse_chord(name, strict=False)
    if p.suffix in CHORD_QUALITIES:
        quality = CHORD_QUALITIES[p.suffix][0]
    else:
        # Fallback: minor kalau diawali "m" (bukan "maj"), selain itu mayor.
        quality = "min" if p.suffix.startswith("m") and not p.suffix.startswith("maj") else "maj"
        log.warning("Chord %r tidak terpetakan ke Harte, dipakai triad %s", name, quality)
    out = f"{p.root}:{quality}"
    if p.bass_pc is not None and p.bass_pc != p.root_pc:
        out += "/" + _SEMITONE_TO_DEGREE[(p.bass_pc - p.root_pc) % 12]
    return out


def harte_to_app(label: str) -> str:
    """Harte -> notasi aplikasi. Ekstensi yang tak dikenal dibuang (triad terdekat)."""
    label = label.strip()
    if label in ("N", "X", ""):
        return "N"
    main, _, bass_degree = label.partition("/")
    root, _, quality = main.partition(":")
    quality = quality or "maj"
    m = re.match(r"^([A-G])([#b]?)$", root)
    if not m:
        raise ValueError(f"Root Harte tidak valid: {label!r}")
    root_pc = _note_pc(*m.groups())

    if quality in _HARTE_TO_SUFFIX:
        suffix = _HARTE_TO_SUFFIX[quality]
    else:
        base = quality.split("(")[0]
        if base in _HARTE_TO_SUFFIX:
            suffix = _HARTE_TO_SUFFIX[base]
        else:
            suffix = "m" if base.startswith("min") else ""
        log.warning("Harte %r tidak terpetakan penuh, dipakai %r", label, root + suffix)

    out = root + suffix
    if bass_degree:
        if bass_degree not in _DEGREE_TO_SEMITONE:
            raise ValueError(f"Derajat bass tidak valid: {label!r}")
        semi = _DEGREE_TO_SEMITONE[bass_degree]
        if semi:
            names = FLAT_NAMES if ("b" in root or root == "F") else SHARP_NAMES
            out += "/" + names[(root_pc + semi) % 12]
    return out


def read_lab(path: str | Path) -> list[Segment]:
    """Baca .lab: tiap baris 'start<TAB>end<TAB>chord'. Baris kosong dan '#' dilewati."""
    segments = []
    for n, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 3:
            raise ValueError(f"{path}:{n}: butuh 3 kolom (start, end, chord), dapat {line!r}")
        try:
            start, end = float(parts[0]), float(parts[1])
        except ValueError:
            raise ValueError(f"{path}:{n}: waktu bukan angka: {line!r}") from None
        if end < start:
            raise ValueError(f"{path}:{n}: end < start")
        segments.append(Segment(start, end, parts[2]))
    return segments


def write_lab(path: str | Path, segments: list[Segment]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{s.start:.3f}\t{s.end:.3f}\t{s.label}\n" for s in segments]
    # Tulis ke file sementara lalu ganti, supaya simpan otomatis tidak pernah meninggalkan file setengah jadi.
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("".join(lines), encoding="utf-8", newline="")
    tmp.replace(path)
