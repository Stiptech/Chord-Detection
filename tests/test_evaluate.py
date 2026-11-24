import json

import pytest

from app.detectors.base import Segment
from app.evaluate import (Evaluation, canon, chord_class, evaluate_segments, format_report, load_backup_pairs,
                          load_dir_pairs, merge, normalize)
from app.labels import write_lab


def S(*rows):
    return [Segment(a, b, l) for a, b, l in rows]


def approx(x):
    return pytest.approx(x, abs=1e-9)


def test_identical_labels_score_one():
    segs = S((0, 2, "C"), (2, 4, "G"), (4, 6, "Am7"), (6, 8, "N"))
    ev = evaluate_segments(segs, segs)
    assert [ev.score(m) for m in ("root", "majmin", "thirds", "sevenths")] == [approx(1.0)] * 4
    assert ev.seconds == 8 and not ev.confusions


def test_wrong_chord_halves_the_score():
    ev = evaluate_segments(S((0, 4, "C"), (4, 8, "G")), S((0, 4, "C"), (4, 8, "Am")))
    for m in ("root", "majmin", "thirds"):
        assert ev.score(m) == approx(0.5), m
    assert ev.confusions == {("G", "Am"): approx(4)}


def test_sus_vs_major_thirds_equal_but_majmin_and_sevenths_exclude_sus_reference():
    ev = evaluate_segments(S((0, 4, "Dsus2")), S((0, 4, "D")))
    assert ev.score("root") == approx(1.0)
    assert ev.score("thirds") == approx(1.0)  # keduanya tanpa terts minor
    assert ev.score("majmin") is None and ev.comparable["majmin"] == 0  # acuan sus dikecualikan
    assert ev.score("sevenths") is None
    exact, root = ev.class_accuracy("sus")
    assert (exact, root) == (approx(0.0), approx(1.0))
    assert ev.confusions == {("Dsus2", "D"): approx(4)}


def test_mir_eval_ignores_the_ninth_but_exact_accuracy_does_not():
    ev = evaluate_segments(S((0, 4, "Cadd9")), S((0, 4, "C")))
    assert all(ev.score(m) == approx(1.0) for m in ("root", "majmin", "thirds", "sevenths"))
    assert ev.class_accuracy("add9") == (approx(0.0), approx(1.0))
    assert ev.confusions == {("Cadd9", "C"): approx(4)}


def test_slash_chords():
    ev = evaluate_segments(S((0, 4, "G/B")), S((0, 4, "G")))
    assert ev.score("root") == approx(1.0) and ev.score("majmin") == approx(1.0)  # B adalah nada terts G
    assert ev.class_accuracy("slash") == (approx(0.0), approx(1.0))
    # Am/G: bass b7 menyalakan bit 7 -> bagi 'sevenths' acuan dihitung sebagai m7, jadi Am biasa salah
    ev = evaluate_segments(S((0, 4, "Am/G")), S((0, 4, "Am")))
    assert ev.score("majmin") == approx(1.0)
    assert ev.score("sevenths") == approx(0.0) and ev.comparable["sevenths"] == approx(4)


def test_estimate_is_cropped_or_padded_to_reference_span():
    short = evaluate_segments(S((0, 8, "C")), S((0, 4, "C")))  # sisanya dianggap N
    assert short.score("root") == approx(0.5)
    long = evaluate_segments(S((0, 4, "C")), S((0, 4, "C"), (4, 8, "G")))  # kelebihan dibuang
    assert long.score("root") == approx(1.0) and long.seconds == 4


def test_gaps_become_no_chord():
    ev = evaluate_segments(S((0, 2, "C"), (4, 6, "C")), S((0, 6, "C")))  # acuan kosong 2-4 = N, mesin mengira C
    assert ev.score("root") == approx(4 / 6)
    assert ev.cls_total["N"] == approx(2)
    assert ev.confusions == {("N", "C"): approx(2)}


def test_normalize_and_merge():
    n = normalize(S((1, 3, "C"), (2, 5, "G"), (7, 9, "F")), 0, 8)
    assert [(s.start, s.end, s.label) for s in n] == [(0, 1, "N"), (1, 3, "C"), (3, 5, "G"), (5, 7, "N"), (7, 8, "F")]
    assert normalize([], 0, 4) == S((0, 4, "N"))
    m = merge(normalize(S((0, 4, "C")), 0, 6), normalize(S((0, 2, "C"), (2, 6, "G")), 0, 6))
    assert [(d, r, e) for d, r, e in m] == [(2, "C", "C"), (2, "C", "G"), (2, "N", "G")]


def test_enharmonic_spelling_is_not_an_error():
    ev = evaluate_segments(S((0, 4, "Bb"), (4, 8, "Ebm")), S((0, 4, "A#"), (4, 8, "D#m")))
    assert all(ev.score(m) == approx(1.0) for m in ("root", "majmin", "thirds"))
    assert not ev.confusions
    assert canon("Bb") == canon("A#") == "A#" and canon("G/G") == "G" and canon("N") == "N"


def test_chord_classes():
    cases = {"C": "maj", "Dm": "min", "Dsus2": "sus", "Gsus4": "sus", "Cadd9": "add9", "C7": "seventh", "Am7": "seventh",
             "Cmaj7": "seventh", "G/B": "slash", "C/C": "maj", "Cdim": "other", "C6": "other", "N": "N"}
    for label, cls in cases.items():
        assert chord_class(label) == cls, label


def test_micro_average_weights_by_duration():
    a = evaluate_segments(S((0, 4, "C")), S((0, 4, "C")))
    b = evaluate_segments(S((0, 6, "C"), (6, 12, "G")), S((0, 6, "C"), (6, 12, "D")))
    total = Evaluation()
    total.add(a)
    total.add(b)
    assert total.score("root") == approx((4 + 6) / 16)
    assert total.seconds == 16
    assert total.confusions == {("G", "D"): approx(6)}


def test_empty_reference_is_rejected():
    with pytest.raises(ValueError, match="acuan"):
        evaluate_segments([], S((0, 1, "C")))


def test_report_lists_confusions_and_classes():
    ev = evaluate_segments(S((0, 4, "Dsus2"), (4, 8, "G")), S((0, 4, "D"), (4, 8, "G")))
    text = format_report([("lagu-1", ev)], top=5)
    assert "TOTAL (1 lagu)" in text and "lagu-1" in text
    assert "Dsus2 -> D" in text
    assert "sus2/sus4" in text and "mayor" in text
    assert "mengabaikan nada ke-9" in text


def test_load_dir_pairs(tmp_path):
    write_lab(tmp_path / "7.corrected.lab", S((0, 2, "C")))
    write_lab(tmp_path / "7.auto.lab", S((0, 2, "Am")))
    write_lab(tmp_path / "7.baseline.lab", S((0, 2, "C")))
    write_lab(tmp_path / "8.auto.lab", S((0, 2, "G")))  # tanpa corrected: dilewati
    write_lab(tmp_path / "9.corrected.lab", S((0, 2, "G")))  # tanpa versi mesin: dilewati
    auto = load_dir_pairs(tmp_path, "auto")
    assert [p[0] for p in auto] == ["7"] and auto[0][2][0].label == "Am"
    assert load_dir_pairs(tmp_path, "baseline")[0][2][0].label == "C"
    assert load_dir_pairs(tmp_path, "tidakada") == []


def test_load_backup_pairs(tmp_path):
    seg = lambda l: [{"start": 0, "end": 2, "label": l}]
    f = tmp_path / "b.json"
    f.write_text(json.dumps({"format": "chordfinder-backup", "version": 1, "songs": [
        {"id": "a", "name": "Lagu A", "labels": {"auto": seg("Am"), "corrected": seg("C")}},
        {"id": "b", "name": "Lagu B", "labels": {"auto": seg("G")}},  # belum dikoreksi
    ]}), encoding="utf-8")
    pairs = load_backup_pairs(f)
    assert [p[0] for p in pairs] == ["Lagu A"]
    assert pairs[0][1][0].label == "C" and pairs[0][2][0].label == "Am"
    bad = tmp_path / "x.json"
    bad.write_text(json.dumps({"format": "lain"}), encoding="utf-8")
    with pytest.raises(ValueError, match="bukan cadangan"):
        load_backup_pairs(bad)


def test_report_hides_boundary_noise():
    ev = evaluate_segments(S((0, 3, "C"), (3, 6, "G")), S((0, 3.04, "C"), (3.04, 6, "D")))
    text = format_report([("x", ev)])
    assert "G -> D" in text
    assert "G -> C" not in text  # 0.04 dtk: selisih batas, bukan salah baca
