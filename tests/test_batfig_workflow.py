"""A real worker round trip: source bytes -> edited document -> reopen -> PDF/PNG."""

import hashlib
import io
import json
from pathlib import Path

import pikepdf
import pytest
from PIL import Image, ImageChops

from tavotto import app as m, pdfbackend
from tavotto.engine import pool


def fonts_in_pdf(path):
    result = []

    def visit(resources):
        for font in resources.get("/Font", {}).values():
            base = str(font.get("/BaseFont", ""))
            descendants = font.get("/DescendantFonts", [font])
            for face in descendants:
                descriptor = face.get("/FontDescriptor", {})
                embedded = "/FontFile2" in descriptor or "/FontFile3" in descriptor
                result.append({"base": base, "embedded": embedded})
        for obj in resources.get("/XObject", {}).values():
            if str(obj.get("/Subtype", "")) == "/Form":
                visit(obj.get("/Resources", {}))

    with pikepdf.open(path) as pdf:
        page = pdf.pages[0]
        visit(page["/Resources"])
        size = [float(v) for v in page.MediaBox]
    return result, size


def test_csv_canvas_save_reopen_and_real_pdf_png(tmp_path):
    if not pdfbackend.canvas_font_status()["available"]:
        pytest.skip("Real Arial not installed: complete workflow not verified on this host")
    root = tmp_path / "csv-acceptance"
    root.mkdir()
    m.app.config["TESTING"] = True
    m.reset_projects()
    m.open_project(str(root))
    c = m.app.test_client()
    raw = b"Voltage,Current A,Current B\n0,0.1,0.2\n1,0.5,0.4\n2,0.8,0.9\n"
    mapping = {
        "x": "Voltage",
        "ys": ["Current A", "Current B"],
        "x_label": "Voltage (V)",
        "y_label": "Current (mA)",
    }
    try:
        response = c.post(
            "/api/batfig/csv/import",
            data={
                "file": (io.BytesIO(raw), "synthetic.csv"),
                "mapping": json.dumps(mapping),
            },
        )
        assert response.status_code == 201, response.json
        bundle = response.json
        source_path = root / bundle["data"]
        spec_path = root / bundle["spec"]
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (source_path, spec_path)}
        probe = c.post("/api/registry/probe", json={"script": bundle["script"]})
        assert probe.status_code == 200 and probe.json.get("error") is None, probe.json
        (descriptor,) = probe.json["descriptors"]
        asset = descriptor["asset_id"]
        first = c.post("/api/engine/render", json={"id": asset, "patches": []})
        assert first.status_code == 200, first.json
        xlabel = next(e for e in first.json["manifest"]["elements"] if e["role"] == "axis_label")
        patches = [{"gid": xlabel["gid"], "prop": "color", "value": "#b74141"}]
        edited = c.post("/api/engine/render", json={"id": asset, "patches": patches})
        assert edited.status_code == 200, edited.json
        canvas_texts = [
            {
                "type": "text",
                "id": f"text-{i}",
                "text": value,
                "font_family": "Arial",
                "interpretation": "scientific",
                "size_pt": 11,
                "bold": bold,
                "italic": italic,
                "x_mm": 8,
                "y_mm": 75 + i * 8,
                "w_mm": 102,
                "h_mm": 7,
            }
            for i, (value, bold, italic) in enumerate(
                [
                    ("a) Arial α β γ Δ μ Ω ± × °C", False, False),
                    ("b) Li_{2}O mAh g^{-1}", True, False),
                    ("c) cm⁻² Zn^{2+}", False, True),
                    ("d) 10^{-3} S cm^{-1}", True, True),
                ]
            )
        ]
        export_objects = [
            {
                "type": "panel",
                "id": asset,
                "x_mm": 8,
                "y_mm": 5,
                "w_mm": 90,
                "h_mm": 65,
                "overrides": patches,
            },
            *canvas_texts,
        ]
        # Persist a real schema-3 document; then use data read back from disk.
        document = {
            "schema": 3,
            "project": {"id": "acceptance", "name": "Arial CSV"},
            "activeCanvasId": "canvas",
            "createdAt": 0,
            "updatedAt": 1,
            "canvases": [
                {
                    "id": "canvas",
                    "name": "Arial CSV",
                    "page": {"w": 120, "h": 112},
                    "objects": [
                        {
                            "id": "panel",
                            "type": "panel",
                            "fileId": asset,
                            "fileKind": "runtime",
                            "x": 8,
                            "y": 5,
                            "w": 90,
                            "h": 65,
                            "nativeW": 90,
                            "nativeH": 65,
                            "overrides": patches,
                            "source": {
                                "script": descriptor["script"],
                                "entry": descriptor["entry"],
                                "stem": descriptor["stem"],
                                "captureSource": descriptor["capture_source"],
                                "fingerprint": descriptor["source_fingerprint"],
                                "sizeMm": descriptor["size_mm"],
                            },
                        }
                    ],
                    "guides": [],
                }
            ],
        }
        document["canvases"][0]["objects"].extend(
            [
                {
                    "id": t["id"],
                    "type": "text",
                    "text": t["text"],
                    "fontFamily": "Arial",
                    "interpretation": t["interpretation"],
                    "sizePt": t["size_pt"],
                    "color": "#000000",
                    "align": "left",
                    "bold": t["bold"],
                    "italic": t["italic"],
                    "x": t["x_mm"],
                    "y": t["y_mm"],
                    "w": t["w_mm"],
                    "h": t["h_mm"],
                }
                for t in canvas_texts
            ]
        )
        saved = c.post("/api/layouts/Arial CSV", json=document)
        assert saved.status_code == 200, saved.json
        reopened = c.get("/api/layouts/Arial CSV")
        assert reopened.status_code == 200
        assert reopened.json == document
        reopened_patches = reopened.json["canvases"][0]["objects"][0]["overrides"]
        pool.shutdown_all(str(root), wait=True)
        fresh = c.post("/api/engine/render", json={"id": asset, "patches": reopened_patches})
        assert fresh.status_code == 200, fresh.json
        assert fresh.json["manifest"]["elements"] == edited.json["manifest"]["elements"]
        exported = c.post(
            "/api/export",
            json={
                "stem": "arial-csv",
                "page_w_mm": 120,
                "page_h_mm": 112,
                "formats": ["pdf", "png"],
                "dpi": 288,
                "objects": export_objects,
            },
        )
        assert exported.status_code == 200, exported.json
        files = {
            Path(f["name"]).suffix: Path(exported.json["export_dir"]) / f["name"]
            for f in exported.json["files"]
        }
        assert set(files) == {".pdf", ".png"}, exported.json
        font_facts, size = fonts_in_pdf(files[".pdf"])
        assert font_facts and all(f["embedded"] and "Arial" in f["base"] for f in font_facts), (
            font_facts
        )
        assert size[2:] == pytest.approx([120 * 72 / 25.4, 112 * 72 / 25.4], abs=0.01)
        reraster = root / "pdf-raster.png"
        pdfbackend.original_png(files[".pdf"], reraster, 288)
        with Image.open(files[".png"]) as png, Image.open(reraster) as pdf_png:
            assert png.size == pdf_png.size
            assert (
                ImageChops.difference(png.convert("RGB"), pdf_png.convert("RGB")).getbbox() is None
            )
        assert {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before} == before
        (root / "acceptance.json").write_text(
            json.dumps(
                {
                    "source_sha256": bundle["sha256"],
                    "fonts": font_facts,
                    "page_pt": size,
                    "reopen_manifest_equal": True,
                    "pdf_png_pixels_equal": True,
                    "exports": {ext: str(path) for ext, path in files.items()},
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    finally:
        pool.shutdown_all(str(root), wait=True)
        m.reset_projects()
