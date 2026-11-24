"""Detector baseline: chroma CQT + template matching + Viterbi.

Alur: audio -> komponen harmonik -> chroma -> kemiripan ke template chord
-> softmax jadi probabilitas -> Viterbi (haluskan) -> segmen.

Keterbatasan yang disadari:
- sus2 dan sus4 punya nada yang sama (Dsus4 = Gsus2 = D G A), jadi root-nya
  tidak bisa dibedakan dari chroma saja. Perlu info bass atau model terlatih.
- Slash chord tidak dideteksi (butuh estimasi bass).
"""
import numpy as np
import librosa

from .. import config
from ..audio import load_audio
from ..labels import CHORD_QUALITIES, SHARP_NAMES
from .base import ChordDetector, Segment

# Kosakata awal (urutan menentukan prioritas bila skor seri).
VOCAB_SUFFIXES = ["", "m", "sus2", "sus4", "7", "maj7", "m7"]
NO_CHORD = "N"


def build_templates() -> tuple[list[str], np.ndarray, np.ndarray]:
    """Kembalikan (label, template [n_state, 12] ter-L2-normalisasi, bias per state)."""
    labels, rows, bias = [], [], []
    for suffix in VOCAB_SUFFIXES:
        _, intervals = CHORD_QUALITIES[suffix]
        for root in range(12):
            t = np.zeros(12)
            for iv in intervals:
                t[(root + iv) % 12] = 1.0
            rows.append(t / np.linalg.norm(t))
            labels.append(SHARP_NAMES[root] + suffix)
            bias.append(config.QUALITY_BIAS.get(suffix, 0.0))
    rows.append(np.ones(12) / np.sqrt(12))  # N = chroma datar
    labels.append(NO_CHORD)
    bias.append(config.NO_CHORD_BIAS)
    return labels, np.array(rows), np.array(bias)


def chroma_to_probs(chroma: np.ndarray, templates: np.ndarray, bias: np.ndarray,
                    temperature: float, silence_ratio: float) -> np.ndarray:
    """chroma mentah [12, T] -> probabilitas state [n_state, T]."""
    norms = np.linalg.norm(chroma, axis=0)
    ref = np.percentile(norms, 95)
    silent = norms <= max(silence_ratio * ref, 1e-8)
    chroma_n = chroma / np.maximum(norms, 1e-8)
    chroma_n[:, silent] = 1.0 / np.sqrt(12)  # frame hening -> chroma datar -> N

    sim = templates @ chroma_n + bias[:, None]
    z = sim / temperature
    z -= z.max(axis=0, keepdims=True)  # stabilitas numerik
    p = np.exp(z)
    return p / p.sum(axis=0, keepdims=True)


def viterbi_smooth(probs: np.ndarray, p_stay: float) -> np.ndarray:
    n_states = probs.shape[0]
    transition = librosa.sequence.transition_loop(n_states, p_stay)
    return librosa.sequence.viterbi_discriminative(probs, transition)


def states_to_segments(states: np.ndarray, labels: list[str],
                       hop_length: int, sr: int, duration: float) -> list[Segment]:
    """Gabung frame berurutan berlabel sama jadi segmen.

    Frame t berpusat di t*hop, jadi batas antar frame ada di (t-0.5)*hop.
    """
    n = len(states)
    if n == 0:
        return []
    cuts = np.flatnonzero(np.diff(states)) + 1
    starts = np.concatenate([[0], cuts])
    ends = np.concatenate([cuts, [n]])
    frame_sec = hop_length / sr
    segs = []
    for s, e in zip(starts, ends):
        t0 = 0.0 if s == 0 else (s - 0.5) * frame_sec
        t1 = duration if e == n else (e - 0.5) * frame_sec
        segs.append(Segment(float(t0), float(min(t1, duration)), labels[states[s]]))
    return segs


def _join_equal(segs: list[Segment]) -> list[Segment]:
    out: list[Segment] = []
    for s in segs:
        if out and out[-1].label == s.label:
            out[-1].end = s.end
        else:
            out.append(s)
    return out


def merge_short_segments(segs: list[Segment], min_len: float) -> list[Segment]:
    """Segmen terpendek yang < min_len diserap tetangga yang lebih panjang; ulangi."""
    segs = _join_equal([Segment(s.start, s.end, s.label) for s in segs])
    dur = lambda s: s.end - s.start
    while len(segs) > 1:
        short = [i for i, s in enumerate(segs) if dur(s) < min_len]
        if not short:
            break
        i = min(short, key=lambda k: dur(segs[k]))
        if i == 0:
            j = 1
        elif i == len(segs) - 1:
            j = i - 1
        else:
            j = i - 1 if dur(segs[i - 1]) >= dur(segs[i + 1]) else i + 1
        if j < i:
            segs[j].end = segs[i].end
        else:
            segs[j].start = segs[i].start
        del segs[i]
        segs = _join_equal(segs)
    return segs


class BaselineDetector(ChordDetector):
    name = "baseline"

    def detect(self, wav_path) -> list[Segment]:
        cfg = config
        y, sr = load_audio(wav_path)
        if y.size == 0:
            return []
        duration = len(y) / sr

        y_harm = librosa.effects.harmonic(y)
        chroma = librosa.feature.chroma_cqt(y=y_harm, sr=sr, hop_length=cfg.HOP_LENGTH, norm=None)

        labels, templates, bias = build_templates()
        probs = chroma_to_probs(chroma, templates, bias,
                                cfg.SOFTMAX_TEMPERATURE, cfg.SILENCE_RATIO)
        states = viterbi_smooth(probs, cfg.TRANSITION_LOOP)
        segs = states_to_segments(states, labels, cfg.HOP_LENGTH, sr, duration)
        return merge_short_segments(segs, cfg.MIN_SEGMENT_SEC)
