"""Endpoint from-url dengan download.fetch_info/download_audio dipalsukan (tanpa jaringan)."""
import pytest

from app import config, download, storage
from app.audio import AudioError
from app.download import DownloadError, VideoInfo

URL = "https://youtu.be/abc123"


@pytest.fixture
def fake_net(client, monkeypatch):
    """Palsukan yt-dlp dan ffmpeg; catat panggilan dan status lagu saat tiap tahap berjalan."""
    state = {"downloads": 0, "converts": [], "status_during_download": None,
             "info": VideoInfo(key="youtube:abc123", title="Bagi Mu Tuhan", duration=240),
             "download_error": None, "convert_error": None}

    def fetch_info(url):
        if isinstance(state["info"], Exception):
            raise state["info"]
        return state["info"]

    def download_audio(url, dest_dir):
        state["downloads"] += 1
        state["status_during_download"] = storage.get_song(_only_id())["status"]
        if state["download_error"]:
            raise state["download_error"]
        f = dest_dir / "abc123.m4a"
        f.write_bytes(b"fake-audio")
        return f

    def to_wav(path):
        state["converts"].append((path, storage.get_song(_only_id())["status"]))
        if state["convert_error"]:
            raise state["convert_error"]
        return path

    def _only_id():
        return storage.list_songs()[0]["id"]

    monkeypatch.setattr(download, "fetch_info", fetch_info)
    monkeypatch.setattr(download, "download_audio", download_audio)
    monkeypatch.setattr("app.main.to_wav", to_wav)
    return state


def post(client, url=URL):
    return client.post("/api/songs/from-url", json={"url": url})


def test_happy_path_stages_and_result(client, fake_net):
    r = post(client)
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "downloading" and body["name"] == "Bagi Mu Tuhan"
    assert body["duplicate"] is False and body["source_url"] == URL

    # TestClient menjalankan background task sebelum request berikutnya
    assert fake_net["status_during_download"] == "downloading"
    (path, status_at_convert), = fake_net["converts"]
    assert status_at_convert == "converting"
    assert path == config.AUDIO_DIR / f"{body['id']}.m4a" and path.read_bytes() == b"fake-audio"

    song = client.get(f"/api/songs/{body['id']}").json()
    assert song["status"] == "uploaded" and song["error"] is None
    assert not [p for p in config.CACHE_DIR.iterdir() if p.is_dir()]  # folder sementara dibersihkan


def test_same_link_is_not_downloaded_twice(client, fake_net):
    first = post(client).json()
    second = post(client)
    assert second.status_code == 200
    assert second.json()["id"] == first["id"] and second.json()["duplicate"] is True
    assert fake_net["downloads"] == 1
    assert len(client.get("/api/songs").json()) == 1


def test_same_link_after_delete_downloads_again(client, fake_net):
    first = post(client).json()
    assert client.delete(f"/api/songs/{first['id']}").status_code == 204
    second = post(client).json()
    assert second["id"] != first["id"] and fake_net["downloads"] == 2


@pytest.mark.parametrize("url", ["", "ftp://x.com/a", "file:///etc/passwd", "bukan link"])
def test_invalid_url_rejected_without_creating_song(client, fake_net, url):
    r = post(client, url)
    assert r.status_code == 400 and r.json()["detail"]
    assert client.get("/api/songs").json() == []


def test_playlist_and_too_long_rejected_with_message(client, fake_net):
    fake_net["info"] = DownloadError("Link ini playlist atau kumpulan video. Tempel link satu video saja.")
    r = post(client)
    assert r.status_code == 400 and "playlist" in r.json()["detail"]
    assert client.get("/api/songs").json() == [] and fake_net["downloads"] == 0


def test_body_without_url_is_422(client, fake_net):
    assert client.post("/api/songs/from-url", json={}).status_code == 422


def test_download_failure_sets_error_and_retry_reuses_record(client, fake_net):
    fake_net["download_error"] = DownloadError("Video ini diblokir di wilayahmu.")
    first = post(client).json()
    song = client.get(f"/api/songs/{first['id']}").json()
    assert song["status"] == "error" and "diblokir" in song["error"]
    assert list(config.AUDIO_DIR.iterdir()) == []

    fake_net["download_error"] = None
    retry = post(client)  # tidak dianggap duplikat: tak ada audio
    assert retry.status_code == 202 and retry.json()["id"] == first["id"]
    song = client.get(f"/api/songs/{first['id']}").json()
    assert song["status"] == "uploaded" and song["error"] is None
    assert len(client.get("/api/songs").json()) == 1


def test_conversion_failure_sets_error(client, fake_net):
    fake_net["convert_error"] = AudioError("ffmpeg tidak ditemukan. Pasang dulu: ...")
    sid = post(client).json()["id"]
    song = client.get(f"/api/songs/{sid}").json()
    assert song["status"] == "error" and "ffmpeg" in song["error"]


def test_unexpected_error_does_not_leave_status_stuck(client, fake_net):
    fake_net["download_error"] = ZeroDivisionError("boom")
    sid = post(client).json()["id"]
    assert client.get(f"/api/songs/{sid}").json()["status"] == "error"


def test_busy_duplicate_returns_existing_and_cannot_be_deleted(client, fake_net):
    sid = storage.create_song("Sedang diunduh", status="downloading", source_url=URL, source_key="youtube:abc123")
    r = post(client)
    assert r.status_code == 200 and r.json()["id"] == sid and r.json()["duplicate"] is True
    assert client.delete(f"/api/songs/{sid}").status_code == 409
    assert client.post(f"/api/songs/{sid}/analyze").status_code == 409


def test_stale_downloading_is_reset_on_startup(client):
    sid = storage.create_song("x", status="downloading")
    storage.init_db()
    assert storage.get_song(sid)["status"] == "error"


def test_title_is_cleaned_and_falls_back(client, fake_net):
    fake_net["info"] = VideoInfo(key=None, title="  \x00\x07  ", duration=None)
    assert post(client).json()["name"] == "Tanpa judul"
    # tanpa key -> tidak ada dedupe, link yang sama membuat lagu baru
    assert post(client).json()["duplicate"] is False
    assert len(client.get("/api/songs").json()) == 2
