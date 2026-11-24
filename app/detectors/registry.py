"""Daftar detector yang tersedia. Detector baru (fase 6) cukup didaftarkan di sini."""
from .base import ChordDetector
from .baseline import BaselineDetector

DETECTORS: dict[str, type[ChordDetector]] = {
    "baseline": BaselineDetector,
}


def get_detector(name: str) -> ChordDetector:
    try:
        return DETECTORS[name]()
    except KeyError:
        available = ", ".join(sorted(DETECTORS))
        raise ValueError(f"Detector '{name}' tidak dikenal. Tersedia: {available}") from None
