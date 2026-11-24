"""Bangkitkan ikon aplikasi (web/icons/*.png) tanpa dependensi: huruf "C" berujung bulat di atas persegi biru.

Hanya stdlib (zlib + struct). Jalankan ulang bila mau mengubah desain:  python scripts/make_icons.py
web/icon.svg ditulis tangan dengan geometri yang sama.
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
BG = (0x1F, 0x5F, 0xBF)  # sama dengan --accent mode terang
FG = (255, 255, 255)
SS = 4  # supersampling SS x SS per piksel (antialias)


def render(size: int, rounded: bool, glyph_scale: float) -> bytes:
    """RGBA mentah. rounded=False -> persegi penuh (maskable/apple-touch). glyph_scale mengecilkan huruf (zona aman maskable)."""
    cx = cy = size / 2
    big_r = 0.25 * size * glyph_scale  # jari-jari garis tengah cincin
    half = 0.085 * size * glyph_scale  # setengah tebal garis
    gap = math.radians(42)  # setengah lebar celah "C" (menghadap ke kanan)
    caps = [(cx + big_r * math.cos(a), cy + big_r * math.sin(a)) for a in (gap, -gap)]
    corner = 0.22 * size

    def in_glyph(x: float, y: float) -> bool:
        dx, dy = x - cx, y - cy
        ang = math.atan2(dy, dx)  # 0 = kanan
        if abs(ang) >= gap:  # di luar celah: jarak ke lingkaran garis tengah
            return abs(math.hypot(dx, dy) - big_r) <= half
        return any(math.hypot(x - px, y - py) <= half for px, py in caps)  # ujung bulat

    def in_shape(x: float, y: float) -> bool:
        if not rounded:
            return True
        qx, qy = abs(x - cx) - (cx - corner), abs(y - cy) - (cy - corner)  # persegi bersudut bulat
        return math.hypot(max(qx, 0), max(qy, 0)) <= corner

    rows = bytearray()
    for py in range(size):
        rows.append(0)  # filter none
        for px in range(size):
            a_shape = a_glyph = 0
            for sy in range(SS):
                for sx in range(SS):
                    x, y = px + (sx + 0.5) / SS, py + (sy + 0.5) / SS
                    if in_shape(x, y):
                        a_shape += 1
                        a_glyph += in_glyph(x, y)
            n = SS * SS
            alpha = a_shape / n
            mix = a_glyph / a_shape if a_shape else 0
            rows += bytes((round(BG[i] + (FG[i] - BG[i]) * mix) for i in range(3))) + bytes((round(255 * alpha),))
    return bytes(rows)


def png(size: int, raw: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 bit, RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    specs = {
        "icon-192.png": (192, True, 1.0),
        "icon-512.png": (512, True, 1.0),
        "icon-maskable-512.png": (512, False, 0.72),  # persegi penuh; huruf di zona aman 80% tengah
        "apple-touch-icon.png": (180, False, 1.0),  # iOS membulatkan sendiri
    }
    for name, (size, rounded, scale) in specs.items():
        data = png(size, render(size, rounded, scale))
        (OUT / name).write_bytes(data)
        print(f"{name}: {size}x{size}, {len(data) // 1024} KB")


if __name__ == "__main__":
    main()
