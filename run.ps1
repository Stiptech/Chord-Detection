# Versi Windows dari run.sh. Baru berfungsi mulai Fase 2.
Set-Location $PSScriptRoot
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
