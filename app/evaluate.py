"""Evaluasi detector: label mesin dibandingkan dengan label koreksi (acuan).

Empat skor standar dihitung dengan mir_eval, berbobot durasi:
  root     nada dasar sama
  majmin   mayor/minor (acuan di luar mayor/minor/N dikecualikan)
  thirds   nada dasar + ada/tidaknya terts minor
  sevenths mayor, minor, maj7, 7, m7 (acuan di luar kosakata itu dikecualikan)

PENTING: mir_eval (tanpa mereduksi chord extended) mengabaikan nada ke-9, jadi add9 = mayor, 9 = 7, maj9 = maj7,
m9 = m7, madd9 = minor. Akibatnya skor di atas tidak menghukum salah baca Cadd9 menjadi C. Karena itu ada juga
akurasi "persis sama" per jenis chord dan daftar salah-baca di bawah, yang membedakan chord sampai ke sufiksnya.

Perlakuan rentang waktu: rentang evaluasi = rentang acuan. Segmen mesin dipotong/diisi 'N' mengikuti rentang itu,
dan celah (gap) pada kedua sisi diisi 'N'. Implementasi JS yang setara ada di web/js/evaluate.js (diuji paritas).
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

import mir_eval.chord as mc
import numpy as np

from .detectors.base import Segment
from .labels import SHARP_NAMES, app_to_harte, parse_chord

METRICS = ("root", "majmin", "thirds", "sevenths")
CLASSES = ("maj", "min", "sus", "add9", "seventh", "slash", "other", "N")
SEVENTH_SUFFIXES = {"7", "maj7", "m7", "9", "maj9", "m9", "m7b5", "dim7"}
_EPS = 1e-9

_METRIC_FUNCS = {"root": mc.root, "majmin": mc.majmin, "thirds": mc.thirds, "sevenths": mc.sevenths}


def chord_class(label: str) -> str:
    """Kelompok chord acuan untuk akurasi per jenis (saling lepas; slash didahulukan)."""
    if label == "N":
        return "N"
    try:
        p = parse_chord(label, strict=False)
    except ValueError:
        return "other"
    if p.bass_pc is not None and p.bass_pc != p.root_pc:
        return "slash"
    s = p.suffix
    if s == "":
        return "maj"
    if s == "m":
        return "min"
    if s in ("sus2", "sus4"):
        return "sus"
    if s in ("add9", "madd9"):
        return "add9"
    if s in SEVENTH_SUFFIXES:
        return "seventh"
    return "other"


def canon(label: str) -> str:
    """Nama baku (ejaan sharp, slash dengan bass = root dibuang) supaya Bb dan A# dianggap sama."""
    if label == "N":
        return "N"
    try:
        p = parse_chord(label, strict=False)
    except ValueError:
        return label
    bass = f"/{SHARP_NAMES[p.bass_pc]}" if p.bass_pc is not None and p.bass_pc != p.root_pc else ""
    return f"{SHARP_NAMES[p.root_pc]}{p.suffix}{bass}"


def root_pc(label: str) -> int | None:
    if label == "N":
        return None
    try:
        return parse_chord(label, strict=False).root_pc
    except ValueError:
        return None


def normalize(segs: list[Segment], t0: float, t1: float) -> list[Segment]:
    """Segmen berurutan yang menutupi [t0, t1] tanpa celah: dipotong ke rentang, celah diisi 'N'."""
    out: list[Segment] = []
    cursor = t0
    for s in sorted(segs, key=lambda x: (x.start, x.end)):
        start, end = max(s.start, t0, cursor), min(s.end, t1)
        if end - start <= _EPS:
            continue
        if start - cursor > _EPS:
            out.append(Segment(cursor, start, "N"))
        out.append(Segment(start, end, s.label))
        cursor = end
    if t1 - cursor > _EPS:
        out.append(Segment(cursor, t1, "N"))
    return out or [Segment(t0, t1, "N")]


def merge(ref: list[Segment], est: list[Segment]) -> list[tuple[float, str, str]]:
    """(durasi, label acuan, label mesin) untuk tiap interval antar batas gabungan. Keduanya sudah dinormalkan."""
    bounds = sorted({round(b, 9) for s in (*ref, *est) for b in (s.start, s.end)})
    out = []
    i = j = 0
    for t0, t1 in zip(bounds, bounds[1:]):
        while ref[i].end <= t0 + _EPS and i < len(ref) - 1:
            i += 1
        while est[j].end <= t0 + _EPS and j < len(est) - 1:
            j += 1
        if t1 - t0 > _EPS:
            out.append((t1 - t0, ref[i].label, est[j].label))
    return out


@dataclass
class Evaluation:
    """Penjumlahan detik, bukan rasio, supaya beberapa lagu bisa digabung (rata-rata mikro berbobot durasi)."""
    seconds: float = 0.0
    correct: dict[str, float] = field(default_factory=lambda: {m: 0.0 for m in METRICS})
    comparable: dict[str, float] = field(default_factory=lambda: {m: 0.0 for m in METRICS})
    cls_total: dict[str, float] = field(default_factory=lambda: {c: 0.0 for c in CLASSES})
    cls_exact: dict[str, float] = field(default_factory=lambda: {c: 0.0 for c in CLASSES})
    cls_root: dict[str, float] = field(default_factory=lambda: {c: 0.0 for c in CLASSES})
    confusions: Counter = field(default_factory=Counter)  # (acuan, mesin) -> detik, hanya yang tidak persis sama

    def score(self, metric: str) -> float | None:
        c = self.comparable[metric]
        return self.correct[metric] / c if c > 0 else None

    def class_accuracy(self, cls: str) -> tuple[float | None, float | None]:
        """(persis sama, nada dasar sama) sebagai pecahan dari durasi kelas itu."""
        t = self.cls_total[cls]
        return (self.cls_exact[cls] / t, self.cls_root[cls] / t) if t > 0 else (None, None)

    def add(self, other: "Evaluation") -> None:
        self.seconds += other.seconds
        for m in METRICS:
            self.correct[m] += other.correct[m]
            self.comparable[m] += other.comparable[m]
        for c in CLASSES:
            self.cls_total[c] += other.cls_total[c]
            self.cls_exact[c] += other.cls_exact[c]
            self.cls_root[c] += other.cls_root[c]
        self.confusions.update(other.confusions)


def evaluate_segments(ref: list[Segment], est: list[Segment]) -> Evaluation:
    if not ref:
        raise ValueError("Tidak ada label acuan (koreksi) untuk dievaluasi.")
    t0, t1 = min(s.start for s in ref), max(s.end for s in ref)
    if t1 - t0 <= _EPS:
        raise ValueError("Label acuan tidak punya durasi.")
    triples = merge(normalize(ref, t0, t1), normalize(est, t0, t1))

    ev = Evaluation(seconds=t1 - t0)
    durs = np.array([d for d, _, _ in triples])
    ref_h = [app_to_harte(r) for _, r, _ in triples]
    est_h = [app_to_harte(e) for _, _, e in triples]
    for m in METRICS:
        cmp = _METRIC_FUNCS[m](ref_h, est_h)
        ev.correct[m] = float(durs[cmp == 1.0].sum())
        ev.comparable[m] = float(durs[cmp >= 0].sum())

    for d, r, e in triples:
        cls = chord_class(r)
        ev.cls_total[cls] += d
        exact = canon(r) == canon(e)
        if exact:
            ev.cls_exact[cls] += d
            ev.cls_root[cls] += d
        else:
            ev.confusions[(canon(r), canon(e))] += d
            rr, er = root_pc(r), root_pc(e)
            if rr is not None and rr == er:
                ev.cls_root[cls] += d
    return ev


# ---------- memuat pasangan label ----------

def load_dir_pairs(directory, est_version: str = "auto") -> list[tuple[str, list[Segment], list[Segment]]]:
    """Cari <id>.corrected.lab dan pasangannya <id>.<est_version>.lab di sebuah folder. Lagu tanpa pasangan dilewati."""
    from pathlib import Path

    from .labels import read_lab

    out = []
    for ref_path in sorted(Path(directory).glob("*.corrected.lab")):
        song = ref_path.name[: -len(".corrected.lab")]
        est_path = ref_path.with_name(f"{song}.{est_version}.lab")
        if not est_path.exists():
            continue
        out.append((song, read_lab(ref_path), read_lab(est_path)))
    return out


def load_backup_pairs(json_path, est_version: str = "auto") -> list[tuple[str, list[Segment], list[Segment]]]:
    """Baca cadangan JSON dari tombol 'Ekspor semua label' di aplikasi web."""
    import json
    from pathlib import Path

    data = json.loads(Path(json_path).read_text(encoding="utf-8"))
    if data.get("format") != "chordfinder-backup":
        raise ValueError("Berkas ini bukan cadangan Chord Finder (format tidak dikenal).")
    out = []
    for song in data.get("songs", []):
        labels = song.get("labels", {})
        if "corrected" not in labels or est_version not in labels:
            continue
        to_segs = lambda rows: [Segment(float(r["start"]), float(r["end"]), r["label"]) for r in rows]
        out.append((song.get("name") or song.get("id", "?"), to_segs(labels["corrected"]), to_segs(labels[est_version])))
    return out


# ---------- laporan teks ----------

CLASS_NAMES = {"maj": "mayor", "min": "minor", "sus": "sus2/sus4", "add9": "add9", "seventh": "7th (7/maj7/m7/...)",
               "slash": "slash (G/B)", "other": "lainnya (dim/aug/6)", "N": "tanpa chord (N)"}


def _pct(v: float | None) -> str:
    return "   -  " if v is None else f"{100 * v:5.1f}%"


def format_report(songs: list[tuple[str, Evaluation]], top: int = 15) -> str:
    """Tabel per lagu + total, akurasi per jenis chord, dan salah-baca terbanyak."""
    total = Evaluation()
    for _, ev in songs:
        total.add(ev)
    w = min(34, max([len(n) for n, _ in songs] + [10]))
    lines = [f"{'Lagu':<{w}} {'Durasi':>7} {'root':>7} {'majmin':>7} {'thirds':>7} {'sevenths':>8}"]
    for name, ev in songs:
        lines.append(f"{name[:w]:<{w}} {ev.seconds:6.0f}s " + " ".join(f"{_pct(ev.score(m)):>7}" for m in METRICS[:3]) + f" {_pct(ev.score('sevenths')):>8}")
    lines.append("-" * len(lines[0]))
    lines.append(f"{'TOTAL (' + str(len(songs)) + ' lagu)':<{w}} {total.seconds:6.0f}s " + " ".join(f"{_pct(total.score(m)):>7}" for m in METRICS[:3]) + f" {_pct(total.score('sevenths')):>8}")

    lines += ["", "Akurasi per jenis chord acuan (persis sama / nada dasar sama):"]
    for c in CLASSES:
        if total.cls_total[c] > 0:
            exact, rt = total.class_accuracy(c)
            lines.append(f"  {CLASS_NAMES[c]:<22} {total.cls_total[c]:7.1f} dtk   {_pct(exact)} / {_pct(rt)}")

    lines += ["", f"Salah baca terbanyak (acuan -> mesin), {top} teratas:"]
    # sembunyikan selisih < 0.1 dtk (pergeseran batas segmen, bukan salah baca sungguhan)
    common = [(k, v) for k, v in total.confusions.most_common() if v >= 0.1][:top]
    lines += [f"  {sec:7.1f} dtk   {r} -> {e}" for (r, e), sec in common] or ["  (tidak ada)"]
    lines += ["", "Catatan: skor mir_eval mengabaikan nada ke-9 (add9 = mayor, 9 = 7). Bagian per jenis dan salah baca membedakannya."]
    return "\n".join(lines)
