#!/usr/bin/env bash
# Menjalankan server di 0.0.0.0:8000 (bisa dibuka dari iPad). Baru berfungsi mulai Fase 2.
cd "$(dirname "$0")"
exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
