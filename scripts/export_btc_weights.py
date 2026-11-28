"""Ekspor bobot BTC (large voca) ke satu berkas biner yang dibaca langsung oleh JavaScript (web/js/btc.js).

Format `btc-large-voca.bin`:
  uint32 little-endian  = panjang header (N)
  N byte                = header JSON (UTF-8), diisi spasi sampai kelipatan 4
  sisanya               = tensor, dipadatkan berurutan; `offset` di header dihitung dalam ELEMEN (bukan byte)
Header: {v, dtype: 'f32'|'f16', mean, std, labels[170] (notasi proyek), tensors: {nama: {shape, offset}}}
Bobot konvolusi diubah dari [keluar][masuk][k] menjadi [keluar][k][masuk] supaya tiga irisan baris bisa dikalikan berurutan.

Opsional `--fixture`: tulis juga masukan/keluaran referensi PyTorch (fp32) untuk tes paritas JS (js-tests/fixtures/btc_model.json).

Pemakaian (venv BTC, lihat README):
  python export_btc_weights.py --btc-dir <BTC-ISMIR19> --out web/models/btc-large-voca.bin [--dtype f16] [--fixture js-tests/fixtures/btc_model.json]
"""
import argparse
import base64
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from btc_prototype import to_project_label  # noqa: E402  (pemetaan label BTC -> notasi proyek yang sama)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--btc-dir', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--dtype', default='f16', choices=['f16', 'f32'])
    ap.add_argument('--fixture', type=Path)
    ap.add_argument('--fixture-audio', type=Path, help='wav 22050 Hz untuk fixture (default: nada sintetis)')
    args = ap.parse_args()

    sys.path.insert(0, str(args.btc_dir))
    import numpy as np
    import torch
    import yaml
    if not hasattr(np, 'float'):
        np.float = float
    from btc_model import BTC_model
    from utils.hparams import HParams
    from utils.mir_eval_modules import idx2voca_chord

    config = HParams(**yaml.safe_load((args.btc_dir / 'run_config.yaml').read_text(encoding='utf-8')))
    config.feature['large_voca'] = True
    config.model['num_chords'] = 170
    allowed = [np.dtype, type(np.dtype('float64')), np.float64, np.float32, (np._core.multiarray.scalar, 'numpy.core.multiarray.scalar')]
    with torch.serialization.safe_globals(allowed):
        ckpt = torch.load(args.btc_dir / 'test' / 'btc_model_large_voca.pt', map_location='cpu', weights_only=True)
    sd = {k: v.numpy().astype(np.float32) for k, v in ckpt['model'].items()}

    tensors = {}  # nama pendek -> array
    tensors['embed'] = sd['self_attn_layers.embedding_proj.weight']
    for i in range(config.model['num_layers']):
        base = f'self_attn_layers.self_attn_layers.{i}.'
        for tag, blk in (('f', 'attn_block'), ('b', 'backward_attn_block')):
            p = f'{base}{blk}.'
            for short, long in (('q', 'query_linear'), ('k', 'key_linear'), ('v', 'value_linear'), ('o', 'output_linear')):
                tensors[f'l{i}.{tag}.{short}'] = sd[f'{p}multi_head_attention.{long}.weight']
            for n in (0, 1):
                w = sd[f'{p}positionwise_convolution.layers.{n}.conv.weight']  # [keluar][masuk][3]
                tensors[f'l{i}.{tag}.c{n + 1}w'] = np.ascontiguousarray(w.transpose(0, 2, 1))  # [keluar][3][masuk]
                tensors[f'l{i}.{tag}.c{n + 1}b'] = sd[f'{p}positionwise_convolution.layers.{n}.conv.bias']
            for ln, name in (('1', 'layer_norm_mha'), ('2', 'layer_norm_ffn')):
                tensors[f'l{i}.{tag}.ln{ln}g'] = sd[f'{p}{name}.gamma']
                tensors[f'l{i}.{tag}.ln{ln}b'] = sd[f'{p}{name}.beta']
        tensors[f'l{i}.lin.w'] = sd[f'{base}linear.weight']
        tensors[f'l{i}.lin.b'] = sd[f'{base}linear.bias']
    tensors['ln.g'] = sd['self_attn_layers.layer_norm.gamma']
    tensors['ln.b'] = sd['self_attn_layers.layer_norm.beta']
    tensors['out.w'] = sd['output_layer.output_projection.weight']
    tensors['out.b'] = sd['output_layer.output_projection.bias']

    idx2chord = idx2voca_chord()
    labels = [to_project_label(idx2chord[i]) for i in range(170)]

    np_dtype = np.float16 if args.dtype == 'f16' else np.float32
    header = {'v': 1, 'dtype': args.dtype, 'mean': float(ckpt['mean']), 'std': float(ckpt['std']), 'labels': labels,
              'timestep': config.model['timestep'], 'tensors': {}}
    chunks, offset = [], 0
    for name, arr in tensors.items():
        header['tensors'][name] = {'shape': list(arr.shape), 'offset': offset}
        chunks.append(arr.astype(np_dtype).tobytes())
        offset += arr.size
    head = json.dumps(header, separators=(',', ':')).encode('utf-8')
    head += b' ' * (-len(head) % 4)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(struct.pack('<I', len(head)) + head + b''.join(chunks))
    print(f'{len(tensors)} tensor, {offset} nilai {args.dtype} -> {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)')

    if args.fixture:
        import librosa
        model = BTC_model(config=config.model)
        model.load_state_dict(ckpt['model'])
        model.eval()
        # fixture bobot: fitur nyata (dari audio) 2 blok x 108 langkah, sudah dinormalisasi seperti di inferensi
        if args.fixture_audio:
            wav, _ = librosa.load(str(args.fixture_audio), sr=22050, mono=True)
        else:
            t = np.arange(22050 * 20) / 22050.0
            wav = sum(np.sin(2 * np.pi * f * t) / (i + 1) for chord in (261.63, 329.63, 392.0) for i, f in enumerate([chord, 2 * chord, 3 * chord]))
            wav = (0.1 * wav * (1 + 0.5 * np.sin(2 * np.pi * 0.5 * t))).astype(np.float32)
        feats = np.concatenate([librosa.cqt(wav[i:i + 220500], sr=22050, n_bins=144, bins_per_octave=24, hop_length=2048)[:, :108]
                                for i in (0, 220500)], axis=1)
        feats = ((np.log(np.abs(feats) + 1e-6)).T - ckpt['mean']) / ckpt['std']
        x = torch.tensor(feats.reshape(2, 108, 144), dtype=torch.float32)
        with torch.no_grad():
            attn, _ = model.self_attn_layers(x)
            logits = model.output_layer.output_projection(attn)
        b64 = lambda a: base64.b64encode(np.ascontiguousarray(a, dtype='<f4').tobytes()).decode('ascii')
        args.fixture.parent.mkdir(parents=True, exist_ok=True)
        args.fixture.write_text(json.dumps({'batch': 2, 'timestep': 108, 'features': 144, 'input': b64(x.numpy()), 'logits': b64(logits.numpy()),
                                            'argmax': logits.argmax(-1).flatten().tolist()}), encoding='utf-8')
        print('fixture ->', args.fixture)


if __name__ == '__main__':
    main()
