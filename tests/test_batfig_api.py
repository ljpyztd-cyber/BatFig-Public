"""CSV HTTP boundaries and Arial preview/export through the public API."""

import base64
import hashlib
import io
import json

import pytest

from tavotto import app as m
from tavotto.engine import batfigcsv, pool


@pytest.fixture
def client(tmp_path):
    m.app.config["TESTING"] = True
    m.reset_projects()
    project = tmp_path / "figures"
    project.mkdir()
    m.open_project(str(project))
    yield m.app.test_client(), project
    pool.shutdown_all(str(project), wait=True)
    m.reset_projects()


def upload(raw=b"Time,Voltage\n0,3.1\n1,3.2\n", **extra):
    return {"file": (io.BytesIO(raw), "sample.csv"), **extra}


def test_inspect_is_read_only_and_import_keeps_original_bytes(client):
    c, root = client
    raw = b"\xef\xbb\xbfTime,Voltage\r\n0,3.1\r\n1,3.2\r\n"
    before = sorted(root.iterdir())
    response = c.post("/api/batfig/csv/inspect", data=upload(raw))
    assert response.status_code == 200
    assert response.json["row_count"] == 2
    assert response.json["sha256"] == hashlib.sha256(raw).hexdigest()
    assert sorted(root.iterdir()) == before
    imported = c.post(
        "/api/batfig/csv/import",
        data=upload(raw, mapping=json.dumps({"x": "Time", "ys": ["Voltage"]})),
    )
    assert imported.status_code == 201, imported.json
    bundle = imported.json
    assert (root / bundle["data"]).read_bytes() == raw
    assert (root / bundle["script"]).is_file()
    assert (root / bundle["spec"]).is_file()
    assert not list(root.rglob("*.pdf")), "Import must not bypass safe worker execution"


@pytest.mark.parametrize("path", ["inspect", "import"])
def test_unknown_project_never_writes_to_default(client, path):
    c, root = client
    before = sorted(root.iterdir())
    response = c.post(f"/api/batfig/csv/{path}?pj=missing", data=upload())
    assert response.status_code == 409
    assert response.json["code"] == "no_project"
    assert sorted(root.iterdir()) == before


@pytest.mark.parametrize("mapping", ["{", "[]", '{"x":"Time","ys":["missing"]}'])
def test_bad_mapping_is_reported_without_partial_bundle(client, mapping):
    c, root = client
    response = c.post("/api/batfig/csv/import", data=upload(mapping=mapping))
    assert response.status_code == 422, response.json
    assert response.json["code"].startswith("csv_")
    assert not list(root.rglob("figure.py"))


@pytest.mark.parametrize("path", ["inspect", "import"])
def test_oversize_upload_rejected_before_file_spooling(client, monkeypatch, path):
    c, root = client
    spooled = []
    original = m.app.request_class._get_file_stream

    def record_spool(self, *args, **kwargs):
        spooled.append(True)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(m.app.request_class, "_get_file_stream", record_spool)
    response = c.post(f"/api/batfig/csv/{path}", data=upload(b"x" * (batfigcsv.MAX_BYTES + 65536)))
    assert response.status_code == 422, response.json
    assert response.json["code"] == "csv_too_large"
    assert spooled == [], "Reject the request body before multipart file spooling"
    assert not list(root.rglob("figure.py"))


def test_large_valid_csv_still_streams_within_upload_limit(client):
    c, _ = client
    raw = b"Time,Voltage\n" + (b"0," + b"1" * 50 + b"\n") * 90000
    assert 4 * 1024 * 1024 < len(raw) < batfigcsv.MAX_BYTES
    response = c.post("/api/batfig/csv/inspect", data=upload(raw))
    assert response.status_code == 200, response.json
    assert response.json["row_count"] == 90000
    assert response.json["sha256"] == hashlib.sha256(raw).hexdigest()


def text_obj(**kwargs):
    return {
        "type": "text",
        "text": "a) α β μ Ω Δ mAh g^{-1} Li_{2}O",
        "font_family": "Arial",
        "interpretation": "scientific",
        "size_pt": 10,
        "x_mm": 5,
        "y_mm": 5,
        "w_mm": 90,
        "h_mm": 12,
        **kwargs,
    }


def test_arial_preview_is_png_and_uses_real_local_font(client):
    c, _ = client
    facts = c.get("/api/canvas/fonts").json["Arial"]
    if not facts["available"]:
        pytest.skip("Real Arial not installed: preview/font acceptance not verified on this host")
    assert facts["available"], facts
    assert len(facts["faces"]) == 4
    assert all("Arial" in face["postscript_name"] for face in facts["faces"])
    assert all(len(face["sha256"]) == 64 for face in facts["faces"])
    response = c.post("/api/canvas/text-preview", json={"object": text_obj()})
    assert response.status_code == 200, response.json
    assert base64.b64decode(response.json["png_base64"]).startswith(b"\x89PNG\r\n\x1a\n")
    assert response.json["font_family"] == "Arial"


def test_arial_missing_glyph_preview_fails_explicitly(client):
    c, _ = client
    if not c.get("/api/canvas/fonts").json["Arial"]["available"]:
        pytest.skip("Real Arial not installed: missing-glyph acceptance not verified on this host")
    response = c.post("/api/canvas/text-preview", json={"object": text_obj(text="\U0001f9ea")})
    assert response.status_code == 422, response.json
    assert response.json["code"] == "glyph_missing"


def test_unavailable_arial_is_an_explicit_api_failure(client, monkeypatch):
    c, root = client
    monkeypatch.setenv("BATFIG_ARIAL_DIR", str(root / "missing-fonts"))
    facts = c.get("/api/canvas/fonts").json["Arial"]
    assert facts["available"] is False
    response = c.post("/api/canvas/text-preview", json={"object": text_obj()})
    assert response.status_code == 422, response.json
    assert response.json["code"] == "arial_missing"
