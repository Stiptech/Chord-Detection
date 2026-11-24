from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Segment:
    start: float  # detik
    end: float  # detik
    label: str  # notasi aplikasi: "C", "Dm", "G/B", "N", ...


class ChordDetector(ABC):
    """Semua detector (baseline, pretrained, ...) mengikuti interface ini."""

    # Nama dipakai di nama file label: <id>.<name>.lab
    name: str

    @abstractmethod
    def detect(self, wav_path: str | Path) -> list[Segment]:
        """Baca wav (mono 22050 Hz) dan kembalikan segmen chord berurutan."""
