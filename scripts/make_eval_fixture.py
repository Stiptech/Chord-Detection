"""Bangkitkan js-tests/fixtures/eval-parity.json: kasus acak + hasil yang benar dari mir_eval (lewat app/evaluate.py).

Dipakai tes JS (js-tests/evaluate.test.js) untuk memastikan web/js/evaluate.js menghitung persis sama dengan mir_eval.
Jalankan ulang hanya bila logika evaluasi atau kosakata chord berubah:  python scripts/make_eval_fixture.py
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import mir_eval.chord as mc  # noqa: E402

from app.detectors.base import Segment  # noqa: E402
from app.evaluate import CLASSES, METRICS, evaluate_segments  # noqa: E402
from app.labels import CHORD_QUALITIES, FLAT_NAMES, SHARP_NAMES, app_to_harte  # noqa: E402

SEED = 20261124
N_CASES = 80


def random_label(rng: random.Random) -> str:
    r = rng.random()
    if r < 0.08:
        return "N"
    root = rng.choice(SHARP_NAMES if rng.random() < 0.5 else FLAT_NAMES)
    suffix = rng.choice(list(CHORD_QUALITIES) + ["m13", "13"])  # dua terakhir: sufiks tak dikenal -> fallback triad
    label = root + suffix
    if rng.random() < 0.2:
        label += "/" + rng.choice(SHARP_NAMES if rng.random() < 0.5 else FLAT_NAMES)
    return label


def random_segments(rng: random.Random, t0: float, t1: float, gaps: bool) -> list[dict]:
    segs, t = [], t0
    while t < t1 - 0.05:
        if gaps and rng.random() < 0.12:
            t += rng.uniform(0.1, 1.5)  # celah
            continue
        end = min(t1, t + rng.uniform(0.15, 4.0))
        segs.append({"start": round(t, 3), "end": round(end, 3), "label": random_label(rng)})
        t = end
    return segs


def noisy_copy(rng: random.Random, ref: list[dict]) -> list[dict]:
    """Mesin: mirip acuan, tapi batas bergeser dan sebagian label salah; rentang bisa lebih pendek/panjang."""
    out = []
    for s in ref:
        label = s["label"] if rng.random() < 0.6 else random_label(rng)
        out.append({"start": round(s["start"] + rng.uniform(-0.3, 0.3), 3), "end": round(s["end"] + rng.uniform(-0.3, 0.3), 3), "label": label})
    # buang yang tumpang tindih / tak berdurasi supaya valid seperti keluaran detector
    clean, cursor = [], -1.0
    for s in sorted(out, key=lambda x: x["start"]):
        start = max(s["start"], cursor, 0.0)
        if s["end"] - start > 0.05:
            clean.append({**s, "start": round(start, 3)})
            cursor = s["end"]
    cut = rng.random()
    if cut < 0.2 and clean:
        clean = clean[: max(1, len(clean) - rng.randint(1, 3))]  # mesin berhenti lebih awal
    elif cut < 0.35 and clean:
        clean.append({"start": clean[-1]["end"], "end": round(clean[-1]["end"] + rng.uniform(1, 5), 3), "label": random_label(rng)})
    return clean or [{"start": 0.0, "end": 1.0, "label": "N"}]


def to_segs(rows):
    return [Segment(r["start"], r["end"], r["label"]) for r in rows]


def main() -> None:
    rng = random.Random(SEED)
    bitmaps = {}
    for suffix in CHORD_QUALITIES:
        _, bm, _ = mc.encode(app_to_harte("C" + suffix))
        bitmaps[suffix] = "".join(str(int(b)) for b in bm)

    cases = []
    for i in range(N_CASES):
        t0 = round(rng.choice([0.0, 0.0, 0.0, rng.uniform(0.1, 2.0)]), 3)
        t1 = round(t0 + rng.uniform(4, 40), 3)
        ref = random_segments(rng, t0, t1, gaps=rng.random() < 0.4)
        if not ref:
            continue
        est = noisy_copy(rng, ref) if i % 8 else ref  # setiap kasus ke-8: mesin = acuan
        ev = evaluate_segments(to_segs(ref), to_segs(est))
        cases.append({
            "ref": ref, "est": est,
            "expected": {
                "seconds": ev.seconds,
                "correct": ev.correct, "comparable": ev.comparable,
                "clsTotal": ev.cls_total, "clsExact": ev.cls_exact, "clsRoot": ev.cls_root,
                "confusions": sorted(([r, e, sec] for (r, e), sec in ev.confusions.items()), key=lambda x: (-x[2], x[0], x[1])),
            },
        })

    out = ROOT / "js-tests" / "fixtures" / "eval-parity.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"seed": SEED, "metrics": list(METRICS), "classes": list(CLASSES), "bitmaps": bitmaps, "cases": cases}, indent=0), encoding="utf-8")
    print(f"{len(cases)} kasus ditulis ke {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
