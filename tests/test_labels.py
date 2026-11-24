import pytest

from app.detectors.base import Segment
from app.labels import (app_to_harte, harte_to_app, is_valid_chord, parse_chord,
                        read_lab, write_lab)


def test_lab_roundtrip(tmp_path):
    segs = [Segment(0.0, 1.5, "C"), Segment(1.5, 3.25, "G/B"), Segment(3.25, 4.0, "N")]
    p = tmp_path / "sub" / "x.lab"
    write_lab(p, segs)
    assert p.read_text().splitlines()[1] == "1.500\t3.250\tG/B"  # tab-separated
    assert read_lab(p) == segs


def test_read_lab_skips_blank_and_comments(tmp_path):
    p = tmp_path / "x.lab"
    p.write_text("# komentar\n\n0.0 1.0 C\n1.0\t2.0\tAm7\n", encoding="utf-8")
    assert [s.label for s in read_lab(p)] == ["C", "Am7"]


@pytest.mark.parametrize("text", ["0.0 1.0\n", "a b C\n", "2.0 1.0 C\n"])
def test_read_lab_rejects_bad_lines(tmp_path, text):
    p = tmp_path / "bad.lab"
    p.write_text(text)
    with pytest.raises(ValueError):
        read_lab(p)


HARTE_PAIRS = [
    ("C", "C:maj"), ("Dm", "D:min"), ("Dsus2", "D:sus2"), ("Dsus4", "D:sus4"),
    ("C7", "C:7"), ("Cmaj7", "C:maj7"), ("Am7", "A:min7"), ("Cadd9", "C:maj(9)"),
    ("G/B", "G:maj/3"), ("D/F#", "D:maj/3"), ("C/E", "C:maj/3"), ("Am/G", "A:min/b7"),
    ("Bb", "Bb:maj"), ("Ebmaj7/D", "Eb:maj7/7"), ("N", "N"),
]


@pytest.mark.parametrize("app,harte", HARTE_PAIRS)
def test_app_to_harte(app, harte):
    assert app_to_harte(app) == harte


@pytest.mark.parametrize("app,harte", HARTE_PAIRS)
def test_harte_to_app(app, harte):
    assert harte_to_app(harte) == app


def test_slash_with_root_bass_is_plain_chord():
    assert app_to_harte("C/C") == "C:maj"


def test_unmappable_chord_falls_back_to_triad(caplog):
    assert app_to_harte("Cm13") == "C:min"
    assert app_to_harte("C13") == "C:maj"
    assert "tidak terpetakan" in caplog.text


def test_harte_unknown_quality_falls_back(caplog):
    assert harte_to_app("C:min7(b9)") == "Cm7"  # ekstensi dibuang, kualitas dasar tetap dipakai
    assert harte_to_app("C:minmaj7") == "Cm"
    assert "tidak terpetakan" in caplog.text


@pytest.mark.parametrize("name", ["C", "C#m7", "Bbmaj7", "G/B", "Dsus2", "N", "Cadd9"])
def test_valid_chords(name):
    assert is_valid_chord(name)


@pytest.mark.parametrize("name", ["", "H", "Cxyz", "C/H", "c", "C//E"])
def test_invalid_chords(name):
    assert not is_valid_chord(name)


def test_parse_chord_pitch_classes():
    p = parse_chord("Bb/D")
    assert (p.root_pc, p.suffix, p.bass_pc) == (10, "", 2)
    assert parse_chord("C#m").root_pc == 1
