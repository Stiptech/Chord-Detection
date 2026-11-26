"""Prototipe offline: chord dengan BTC (Bi-directional Transformer for Chord recognition, Park dkk., ISMIR 2019).

BUKAN bagian aplikasi. Menjalankan model pretrained BTC pada satu berkas audio dan menulis segmen chord sebagai JSON
([{start, end, label}], notasi proyek ini) supaya bisa dimasukkan sebagai versi label `btc` lalu dibandingkan dengan
`baseline` di halaman Statistik.

Kebutuhan (di venv TERPISAH, bukan venv proyek): torch (CPU), numpy, librosa, pyyaml, mir_eval, serta kode dan bobot dari
https://github.com/jayg996/BTC-ISMIR19 (kode MIT; bobot dilaporkan CC-BY-NC-SA 4.0 oleh pihak ketiga, jadi hanya untuk pemakaian pribadi nonkomersial).

Pemakaian:
  python btc_prototype.py --btc-dir <folder BTC-ISMIR19> --audio lagu22k.wav --out segs_btc.json [--voca true|false]
"""
import argparse
import json
import sys
from pathlib import Path

# Kualitas BTC (kosakata besar) -> notasi proyek (lihat web/js/labels.js). minmaj7 tidak ada di proyek: jatuh ke minor.
QUALITY_MAP = {
    'maj': '', 'min': 'm', 'dim': 'dim', 'aug': 'aug', 'min6': 'm6', 'maj6': '6', 'min7': 'm7', 'minmaj7': 'm',
    'maj7': 'maj7', '7': '7', 'dim7': 'dim7', 'hdim7': 'm7b5', 'sus2': 'sus2', 'sus4': 'sus4',
}


def to_project_label(btc_label: str) -> str:
    """'C#:min7' -> 'C#m7', 'G' -> 'G', 'N'/'X' -> 'N'."""
    if btc_label in ('N', 'X'):
        return 'N'
    root, _, quality = btc_label.partition(':')
    if not quality:
        return root
    return root + QUALITY_MAP.get(quality, '')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--btc-dir', required=True, type=Path)
    ap.add_argument('--audio', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--voca', default='true', choices=['true', 'false'])
    args = ap.parse_args()
    voca = args.voca == 'true'

    sys.path.insert(0, str(args.btc_dir))
    import numpy as np
    import torch
    if not hasattr(np, 'float'):
        np.float = float  # kode BTC lama memakai alias NumPy yang sudah dihapus; perilakunya sama
    from btc_model import BTC_model
    from utils.hparams import HParams
    from utils.mir_eval_modules import audio_file_to_features, idx2chord, idx2voca_chord

    import yaml
    # HParams.load bawaan BTC memakai API PyYAML lama; baca sendiri dengan safe_load.
    config = HParams(**yaml.safe_load((args.btc_dir / 'run_config.yaml').read_text(encoding='utf-8')))
    if voca:
        config.feature['large_voca'] = True
        config.model['num_chords'] = 170
        weights, idx_to_chord = args.btc_dir / 'test' / 'btc_model_large_voca.pt', idx2voca_chord()
    else:
        weights, idx_to_chord = args.btc_dir / 'test' / 'btc_model.pt', idx2chord

    device = torch.device('cpu')
    model = BTC_model(config=config.model).to(device)
    # weights_only=True menolak pickle sembarang; checkpoint ini hanya menyimpan tensor + mean/std berupa skalar NumPy,
    # jadi cukup izinkan skalar NumPy (tidak membuka eksekusi kode lain).
    # (NumPy 2 memindahkan modulnya ke numpy._core; berkas lama menyebut numpy.core, maka nama ditulis eksplisit.)
    allowed = [np.dtype, type(np.dtype('float64')), np.float64, np.float32, (np._core.multiarray.scalar, 'numpy.core.multiarray.scalar')]
    with torch.serialization.safe_globals(allowed):
        ckpt = torch.load(weights, map_location=device, weights_only=True)
    mean, std = ckpt['mean'], ckpt['std']
    model.load_state_dict(ckpt['model'])
    model.eval()

    feature, unit, _length = audio_file_to_features(str(args.audio), config)
    feature = (feature.T - mean) / std
    n_step = config.model['timestep']
    n_valid = feature.shape[0]
    pad = n_step - (n_valid % n_step)
    feature = np.pad(feature, ((0, pad), (0, 0)), mode='constant', constant_values=0)
    x = torch.tensor(feature, dtype=torch.float32).unsqueeze(0)

    preds = []
    with torch.no_grad():
        for t in range(feature.shape[0] // n_step):
            attn, _ = model.self_attn_layers(x[:, n_step * t:n_step * (t + 1), :])
            p, _ = model.output_layer(attn)
            preds.extend(p.squeeze().tolist())
    preds = preds[:n_valid]  # buang bingkai pengisi

    # bingkai -> segmen berurutan (gabung bingkai bertetangga yang sama)
    segs, start, prev = [], 0.0, preds[0]
    for i in range(1, len(preds)):
        if preds[i] != prev:
            segs.append({'start': round(start, 3), 'end': round(unit * i, 3), 'label': to_project_label(idx_to_chord[prev])})
            start, prev = unit * i, preds[i]
    segs.append({'start': round(start, 3), 'end': round(unit * len(preds), 3), 'label': to_project_label(idx_to_chord[prev])})

    # gabung segmen bertetangga yang kini berlabel sama (mis. X dan N, atau minmaj7 dan min)
    merged = []
    for s in segs:
        if merged and merged[-1]['label'] == s['label'] and abs(merged[-1]['end'] - s['start']) < 1e-6:
            merged[-1]['end'] = s['end']
        else:
            merged.append(s)
    args.out.write_text(json.dumps(merged), encoding='utf-8')
    print(f'{len(merged)} segmen, {merged[-1]["end"]:.1f} dtk, kosakata {"170" if voca else "25"} -> {args.out}')


if __name__ == '__main__':
    main()
