"""Fixture paritas CQT: fitur log-CQT acuan dari librosa untuk sinyal sintetis deterministik (js-tests/fixtures/cqt.json).

Sinyalnya dirumuskan sama persis di js-tests/cqt.test.js (jangan ubah salah satunya saja):
  x[n] = 0.15*(sin(2pi*261.63 n/sr) + 0.5 sin(2pi*329.63 n/sr) + 0.5 sin(2pi*392 n/sr) + 0.3 sin(2pi*130.81 n/sr)) * (0.6 + 0.4 sin(2pi*0.7 n/sr))
         + 0.01 * (hash(n) - 0.5), hash(n) = ((n * 2654435761) mod 2^32) / 2^32
Panjang 10,5 dtk: satu potongan penuh 10 dtk + sisa 0,5 dtk, jadi pemotongan ala BTC ikut teruji.

Pakai (venv dengan librosa): python scripts/make_cqt_fixture.py js-tests/fixtures/cqt.json
"""
import base64
import json
import sys

import librosa
import numpy as np

SR, SECONDS = 22050, 10.5


def signal() -> np.ndarray:
    n = np.arange(int(SR * SECONDS))
    t = n / SR
    tone = (np.sin(2 * np.pi * 261.63 * t) + 0.5 * np.sin(2 * np.pi * 329.63 * t) + 0.5 * np.sin(2 * np.pi * 392.0 * t)
            + 0.3 * np.sin(2 * np.pi * 130.81 * t)) * 0.15 * (0.6 + 0.4 * np.sin(2 * np.pi * 0.7 * t))
    noise = ((n.astype(np.uint64) * np.uint64(2654435761)) % np.uint64(2 ** 32)).astype(np.float64) / 2 ** 32
    return (tone + 0.01 * (noise - 0.5)).astype(np.float32)


def features(y: np.ndarray) -> np.ndarray:
    chunk, cur, parts = SR * 10, 0, []
    kw = dict(sr=SR, n_bins=144, bins_per_octave=24, hop_length=2048)
    while len(y) > cur + chunk:
        parts.append(librosa.cqt(y[cur:cur + chunk], **kw))
        cur += chunk
    parts.append(librosa.cqt(y[cur:], **kw))
    return np.log(np.abs(np.concatenate(parts, axis=1)) + 1e-6)


if __name__ == '__main__':
    f = features(signal())
    out = {'frames': f.shape[1], 'logCqt': base64.b64encode(np.ascontiguousarray(f.T, dtype='<f4').tobytes()).decode('ascii')}
    open(sys.argv[1], 'w', encoding='utf-8').write(json.dumps(out))
    print(f.shape, '->', sys.argv[1])
