"""Analisis satu file audio/video -> cetak segmen chord dan tulis .lab.

Contoh:  python scripts/analyze_file.py lagu.mp3
         python scripts/analyze_file.py lagu.mp4 --detector baseline --out hasil.lab
"""
import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.audio import AudioError, to_wav  # noqa: E402
from app.detectors.registry import get_detector  # noqa: E402
from app.labels import write_lab  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", help="file mp3/mp4/m4a/wav (apa pun yang dibaca ffmpeg)")
    ap.add_argument("--detector", default="baseline")
    ap.add_argument("--out", help="path .lab keluaran (default: data/labels/<nama>.<detector>.lab)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")
    src = Path(args.audio)
    out = Path(args.out) if args.out else config.LABELS_DIR / f"{src.stem}.{args.detector}.lab"

    try:
        detector = get_detector(args.detector)
        wav = to_wav(src)
        segments = detector.detect(wav)
    except (AudioError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    for s in segments:
        print(f"{s.start:8.2f} {s.end:8.2f}  {s.label}")
    write_lab(out, segments)
    print(f"\n{len(segments)} segmen ditulis ke {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
