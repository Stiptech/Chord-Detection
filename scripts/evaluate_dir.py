"""Evaluasi semua lagu yang punya koreksi: label mesin vs koreksi (acuan).

Dua sumber data:
  --dir folder/        berisi <id>.corrected.lab dan <id>.<versi>.lab (mis. data/labels)
  --backup berkas.json cadangan dari tombol "Ekspor semua label (JSON)" di aplikasi web

Contoh:  python scripts/evaluate_dir.py --backup chordfinder-backup-2026-11-24.json
         python scripts/evaluate_dir.py --dir data/labels --est baseline
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.evaluate import evaluate_segments, format_report, load_backup_pairs, load_dir_pairs  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dir", help="folder berisi *.corrected.lab")
    src.add_argument("--backup", help="berkas cadangan JSON dari aplikasi web")
    ap.add_argument("--est", default="auto", help="versi mesin yang dievaluasi: auto (default), baseline, ...")
    ap.add_argument("--top", type=int, default=15, help="jumlah salah-baca teratas yang ditampilkan")
    args = ap.parse_args()

    try:
        pairs = load_backup_pairs(args.backup, args.est) if args.backup else load_dir_pairs(args.dir, args.est)
    except (OSError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    if not pairs:
        print(f"Tidak ada lagu yang punya koreksi (corrected) dan versi '{args.est}'. "
              "Koreksi dulu satu lagu di mode edit.", file=sys.stderr)
        return 1

    songs = []
    for name, ref, est in pairs:
        try:
            songs.append((name, evaluate_segments(ref, est)))
        except ValueError as e:
            print(f"Dilewati {name}: {e}", file=sys.stderr)
    print(format_report(songs, args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())
