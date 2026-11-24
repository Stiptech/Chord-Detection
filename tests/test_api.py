import pytest

from app import config, storage
from app.audio import AudioError


# ---------- upload & daftar ----------

def test_upload_and_list(client, upload, wav_bytes):
    song = upload(wav_bytes, "Bagi Mu Tuhan.wav")
    assert song["name"] == "Bagi Mu Tuhan"
    assert song["status"] == "uploaded"
    assert song["has_corrected"] is False
    assert (config.AUDIO_DIR / f"{song['id']}.wav").exists()

    listed = client.get("/api/songs").json()
    assert [s["id"] for s in listed] == [song["id"]]
    assert client.get(f"/api/songs/{song['id']}").json()["name"] == "Bagi Mu Tuhan"


def test_upload_empty_file_rejected_and_cleaned(client):
    r = client.post("/api/songs", files={"file": ("kosong.mp3", b"", "audio/mpeg")})
    assert r.status_code == 400
    assert client.get("/api/songs").json() == []
    assert list(config.AUDIO_DIR.iterdir()) == []


def test_upload_sanitizes_path_and_extension(client, upload):
    song = upload(b"abc", "..\\..\\evil/../lagu.MP3")
    assert song["name"] == "lagu"
    assert [p.name for p in config.AUDIO_DIR.iterdir()] == [f"{song['id']}.mp3"]


def test_unknown_song_is_404(client):
    for method, url in [("get", "/api/songs/99"), ("post", "/api/songs/99/analyze"),
                        ("get", "/api/songs/99/chords"), ("get", "/api/songs/99/audio"),
                        ("get", "/api/songs/99/export"), ("delete", "/api/songs/99")]:
        assert getattr(client, method)(url).status_code == 404, url


# ---------- analisis ----------

def test_analyze_then_get_chords(client, upload, wav_bytes, no_ffmpeg_needed):
    sid = upload(wav_bytes)["id"]
    r = client.post(f"/api/songs/{sid}/analyze?detector=baseline")
    assert r.status_code == 202

    song = client.get(f"/api/songs/{sid}").json()  # background task sudah selesai di TestClient
    assert song["status"] == "ready" and song["detector"] == "baseline"

    auto = client.get(f"/api/songs/{sid}/chords?version=auto").json()
    assert auto["version"] == "auto"
    assert [s["label"] for s in auto["segments"]] == ["C", "Am"]
    assert (config.LABELS_DIR / f"{sid}.baseline.lab").exists()

    # corrected belum ada -> salinan auto
    corrected = client.get(f"/api/songs/{sid}/chords?version=corrected").json()
    assert corrected["version"] == "auto"
    assert corrected["segments"] == auto["segments"]
    # versi menurut nama detector juga bisa dibaca
    assert client.get(f"/api/songs/{sid}/chords?version=baseline").json()["segments"] == auto["segments"]


def test_chords_before_analysis_is_404(client, upload, wav_bytes):
    sid = upload(wav_bytes)["id"]
    assert client.get(f"/api/songs/{sid}/chords").status_code == 404


def test_analyze_unknown_detector_is_400(client, upload, wav_bytes):
    sid = upload(wav_bytes)["id"]
    r = client.post(f"/api/songs/{sid}/analyze?detector=ngawur")
    assert r.status_code == 400 and "baseline" in r.json()["detail"]
    assert client.get(f"/api/songs/{sid}").json()["status"] == "uploaded"


def test_analyze_error_is_recorded_not_raised(client, upload, wav_bytes, monkeypatch):
    def boom(path):
        raise AudioError("File rusak atau formatnya tidak didukung.")
    monkeypatch.setattr("app.main.to_wav", boom)
    sid = upload(wav_bytes)["id"]
    assert client.post(f"/api/songs/{sid}/analyze").status_code == 202
    song = client.get(f"/api/songs/{sid}").json()
    assert song["status"] == "error" and "rusak" in song["error"]


def test_analyze_unexpected_error_does_not_leave_status_stuck(client, upload, wav_bytes, monkeypatch):
    monkeypatch.setattr("app.main.to_wav", lambda p: 1 / 0)
    sid = upload(wav_bytes)["id"]
    client.post(f"/api/songs/{sid}/analyze")
    assert client.get(f"/api/songs/{sid}").json()["status"] == "error"


def test_analyze_while_busy_is_409(client, upload, wav_bytes):
    sid = upload(wav_bytes)["id"]
    storage.update_song(sid, status="analyzing")
    assert client.post(f"/api/songs/{sid}/analyze").status_code == 409


def test_interrupted_jobs_are_reset_on_startup(client, upload, wav_bytes):
    sid = upload(wav_bytes)["id"]
    storage.update_song(sid, status="analyzing")
    storage.init_db()  # yang dijalankan saat server start
    song = storage.get_song(sid)
    assert song["status"] == "error" and "berhenti" in song["error"]


# ---------- koreksi ----------

def seg(start, end, label):
    return {"start": start, "end": end, "label": label}


def test_put_chords_saves_corrected_and_keeps_auto(client, upload, wav_bytes, no_ffmpeg_needed):
    sid = upload(wav_bytes)["id"]
    client.post(f"/api/songs/{sid}/analyze")
    auto_file = config.LABELS_DIR / f"{sid}.auto.lab"
    auto_before = auto_file.read_text()

    body = {"segments": [seg(0, 1.5, "Dsus2"), seg(1.5, 4, "G/B")]}
    r = client.put(f"/api/songs/{sid}/chords", json=body)
    assert r.status_code == 200 and r.json() == {"saved": 2}

    got = client.get(f"/api/songs/{sid}/chords?version=corrected").json()
    assert got["version"] == "corrected"
    assert [s["label"] for s in got["segments"]] == ["Dsus2", "G/B"]
    assert auto_file.read_text() == auto_before  # auto tidak tersentuh
    assert client.get(f"/api/songs/{sid}").json()["has_corrected"] is True

    # analisis ulang menimpa auto tapi bukan corrected
    client.post(f"/api/songs/{sid}/analyze")
    assert client.get(f"/api/songs/{sid}/chords?version=corrected").json()["version"] == "corrected"


@pytest.mark.parametrize("segments, fragment", [
    ([], "Minimal"),
    ([seg(0, 2, "C"), seg(1.5, 3, "G")], "tumpang tindih"),
    ([seg(2, 3, "C"), seg(0, 1, "G")], "tumpang tindih"),
    ([seg(1, 1, "C")], "setelah"),
    ([seg(2, 1, "C")], "setelah"),
    ([seg(-1, 1, "C")], "negatif"),
    ([seg(0, 1, "Hm")], "tidak valid"),
    ([seg(0, 1, "Cxyz")], "tidak valid"),
    ([seg(0, 1, "")], "tidak valid"),
    ([seg(0, 0.0004, "C")], "setelah"),  # jadi 0.000 setelah dibulatkan
])
def test_put_chords_validation(client, upload, wav_bytes, segments, fragment):
    sid = upload(wav_bytes)["id"]
    r = client.put(f"/api/songs/{sid}/chords", json={"segments": segments})
    assert r.status_code == 422
    assert fragment in r.json()["detail"]
    assert not storage.has_corrected(sid)


def test_put_chords_touching_segments_and_gaps_ok(client, upload, wav_bytes):
    sid = upload(wav_bytes)["id"]
    body = {"segments": [seg(0, 1, "C"), seg(1, 2, "N"), seg(3, 4, "Am7")]}
    assert client.put(f"/api/songs/{sid}/chords", json=body).status_code == 200


def test_put_chords_malformed_body_is_422(client, upload, wav_bytes):
    sid = upload(wav_bytes)["id"]
    assert client.put(f"/api/songs/{sid}/chords", json={"segments": [{"start": "a"}]}).status_code == 422


# ---------- audio (Range) ----------

@pytest.fixture
def audio_song(client, upload):
    data = bytes(range(256)) * 4  # 1024 byte, isi bisa dicek
    return upload(data, "x.mp3")["id"], data


def test_audio_full_advertises_ranges(client, audio_song):
    sid, data = audio_song
    r = client.get(f"/api/songs/{sid}/audio")
    assert r.status_code == 200
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == data


def test_audio_range_requests(client, audio_song):
    sid, data = audio_song
    url = f"/api/songs/{sid}/audio"

    r = client.get(url, headers={"Range": "bytes=0-1"})  # probe yang dikirim Safari
    assert r.status_code == 206
    assert r.headers["content-range"] == "bytes 0-1/1024"
    assert r.content == data[0:2]

    r = client.get(url, headers={"Range": "bytes=1000-"})
    assert r.status_code == 206 and r.content == data[1000:]
    assert r.headers["content-range"] == "bytes 1000-1023/1024"

    r = client.get(url, headers={"Range": "bytes=-24"})
    assert r.status_code == 206 and r.content == data[-24:]

    r = client.get(url, headers={"Range": "bytes=5000-6000"})
    assert r.status_code == 416


def test_audio_missing_file_is_404(client, audio_song):
    sid, _ = audio_song
    (config.AUDIO_DIR / f"{sid}.mp3").unlink()
    assert client.get(f"/api/songs/{sid}/audio").status_code == 404


# ---------- ekspor & hapus ----------

def test_export_lab_and_txt(client, upload, wav_bytes):
    sid = upload(wav_bytes, "Lagu Ku.wav")["id"]
    assert client.get(f"/api/songs/{sid}/export").status_code == 404  # belum ada label

    segs = [seg(0, 1, "C"), seg(1, 2, "N"), seg(2, 3, "G"), seg(3, 4, "Am"),
            seg(4, 5, "F"), seg(5, 6, "Dsus2")]
    client.put(f"/api/songs/{sid}/chords", json={"segments": segs})

    r = client.get(f"/api/songs/{sid}/export?format=lab")
    assert r.text.splitlines()[0] == "0.000\t1.000\tC"
    assert "Lagu%20Ku.lab" in r.headers["content-disposition"]

    r = client.get(f"/api/songs/{sid}/export?format=txt")
    assert r.text == "C G Am F\nDsus2\n"  # 'N' dibuang, 4 chord per baris

    assert client.get(f"/api/songs/{sid}/export?format=pdf").status_code == 422
    assert client.get(f"/api/songs/{sid}/export?version=ngawur").status_code == 400


def test_delete_removes_everything_but_only_this_song(client, upload, wav_bytes, no_ffmpeg_needed):
    a, b = upload(wav_bytes)["id"], upload(wav_bytes)["id"]
    for sid in (a, b):
        client.post(f"/api/songs/{sid}/analyze")
        client.put(f"/api/songs/{sid}/chords", json={"segments": [seg(0, 1, "C")]})

    assert client.delete(f"/api/songs/{a}").status_code == 204
    assert client.get(f"/api/songs/{a}").status_code == 404
    assert not list(config.AUDIO_DIR.glob(f"{a}.*"))
    assert not list(config.LABELS_DIR.glob(f"{a}.*"))
    assert client.get(f"/api/songs/{b}/chords").status_code == 200  # lagu lain utuh
    assert (config.AUDIO_DIR / f"{b}.wav").exists()


def test_delete_while_busy_is_409(client, upload, wav_bytes):
    sid = upload(wav_bytes)["id"]
    storage.update_song(sid, status="analyzing")
    assert client.delete(f"/api/songs/{sid}").status_code == 409
    assert client.get(f"/api/songs/{sid}").status_code == 200


def test_ids_are_not_reused(client, upload, wav_bytes):
    first = upload(wav_bytes)["id"]
    client.delete(f"/api/songs/{first}")
    assert upload(wav_bytes)["id"] > first
