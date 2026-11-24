import numpy as np
import pytest
import soundfile as sf

from app import config
from app.detectors.base import Segment
from app.detectors.baseline import BaselineDetector, merge_short_segments

SR = config.SAMPLE_RATE
_NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def freq(note: str, octave: int) -> float:
    semis = _NOTE[note[0]] + (1 if "#" in note else 0) - 9 + 12 * (octave - 4)
    return 440.0 * 2 ** (semis / 12)


def chord_tone(notes: list[str], seconds: float = 2.0) -> np.ndarray:
    """Sinus bertumpuk: tiap nada + oktaf di atasnya (oktaf tidak menambah pitch class)."""
    t = np.arange(int(SR * seconds)) / SR
    y = np.zeros_like(t)
    for n in notes:
        f = freq(n, 4)
        y += np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 2 * f * t)
    fade = int(0.01 * SR)  # fade 10 ms supaya pergantian tidak berklik
    y[:fade] *= np.linspace(0, 1, fade)
    y[-fade:] *= np.linspace(1, 0, fade)
    return y / np.abs(y).max() * 0.5


def write_progression(path, chords: list[list[str]]):
    y = np.concatenate([chord_tone(c) for c in chords])
    sf.write(path, y, SR)


def test_triad_progression(tmp_path):
    wav = tmp_path / "c_am_f_g.wav"
    write_progression(wav, [["C", "E", "G"], ["A", "C", "E"], ["F", "A", "C"], ["G", "B", "D"]])
    segs = BaselineDetector().detect(wav)

    assert [s.label for s in segs] == ["C", "Am", "F", "G"]
    # batas segmen mendekati 2, 4, 6 detik
    for seg, expected_start in zip(segs, [0, 2, 4, 6]):
        assert seg.start == pytest.approx(expected_start, abs=0.25)
    assert segs[-1].end == pytest.approx(8.0, abs=0.1)


def test_seventh_chords(tmp_path):
    wav = tmp_path / "sevenths.wav"
    write_progression(wav, [
        ["C", "E", "G", "B"],   # Cmaj7
        ["D", "F", "A", "C"],   # Dm7
        ["G", "B", "D", "F"],   # G7
        ["A", "C", "E"],        # Am
    ])
    segs = BaselineDetector().detect(wav)
    assert [s.label for s in segs] == ["Cmaj7", "Dm7", "G7", "Am"]


def test_silence_is_no_chord(tmp_path):
    wav = tmp_path / "silence_between.wav"
    y = np.concatenate([chord_tone(["C", "E", "G"]), np.zeros(SR * 2), chord_tone(["G", "B", "D"])])
    sf.write(wav, y, SR)
    labels = [s.label for s in BaselineDetector().detect(wav)]
    assert labels == ["C", "N", "G"]


def test_merge_short_segments_absorbs_blip():
    segs = [Segment(0, 2, "C"), Segment(2, 2.1, "F"), Segment(2.1, 4, "C"), Segment(4, 6, "G")]
    out = merge_short_segments(segs, 0.3)
    assert [(s.start, s.end, s.label) for s in out] == [(0, 4, "C"), (4, 6, "G")]


def test_merge_short_segments_keeps_times_contiguous():
    segs = [Segment(0, 1, "C"), Segment(1, 1.1, "D"), Segment(1.1, 1.2, "E"), Segment(1.2, 3, "G")]
    out = merge_short_segments(segs, 0.3)
    assert out[0].start == 0 and out[-1].end == 3
    assert all(a.end == b.start for a, b in zip(out, out[1:]))
    assert all(s.end - s.start >= 0.3 for s in out)
