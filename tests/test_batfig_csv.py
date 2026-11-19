"""CSV provenance, strict validation and an actual Arial worker round trip.

Scientific imports stay in the generated-source subprocess. The PDF reader is
independent of Matplotlib and checks the embedded font program, not UI labels.
"""

import hashlib
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pikepdf
import pytest
from fontTools.ttLib import TTFont

from tavotto.engine import batfigcsv

RAW = b"Time,Current,Voltage\r\n0,1,3.1\r\n1,2,3.2\r\n2,3,3.3\r\n"
MAPPING = {"x": "Time", "ys": ["Current", "Voltage"], "x_label": "Time (s)", "y_label": "Signal"}


def test_inspection_and_immutable_bundle(tmp_path):
    raw = b"\xef\xbb\xbf" + RAW
    inspected = batfigcsv.inspect_csv(raw)
    assert inspected["row_count"] == 3
    assert [column["numeric"] for column in inspected["columns"]] == [True, True, True]
    assert inspected["sha256"] == hashlib.sha256(raw).hexdigest()
    first = batfigcsv.create_bundle(tmp_path, raw, "../../original.csv", MAPPING)
    second = batfigcsv.create_bundle(tmp_path, raw, "original.csv", MAPPING)
    assert first["stem"] != second["stem"]
    assert Path(first["directory"]).parent == tmp_path
    assert Path(first["data"]).read_bytes() == raw
    spec = json.loads(Path(first["spec"]).read_text(encoding="utf-8"))
    assert spec["source"]["original_filename"] == "original.csv"
    assert spec["source"]["sha256"] == inspected["sha256"]
    assert spec["series"] == [
        {"column": "Current", "gid": "csv-line-1"},
        {"column": "Voltage", "gid": "csv-line-2"},
    ]
    assert set(spec) == {"schema", "source", "mapping", "style", "output_stem", "series"}
    assert all(path.is_dir() for path in tmp_path.iterdir())


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        (b"", "csv_empty"),
        (b"x,y\n\xff,1\n", "csv_encoding"),
        (b"x,x\n1,2\n", "csv_headers"),
        (b"x, x \n1,2\n", "csv_headers"),
        (b"x,\n1,2\n", "csv_headers"),
        (b"x;y\n1;2\n", "csv_columns"),
        (b"x,y\n", "csv_no_data"),
        (b"x,y\n1,2\n\n3,4\n", "csv_row_width"),
        (b"x,y\n1,2,3\n", "csv_row_width"),
        (b'x,y\n1,"unclosed\n', "csv_invalid"),
        (b"x,y\n1,\x00\n", "csv_invalid"),
    ],
)
def test_rejects_invalid_csv_without_writing(tmp_path, raw, code):
    with pytest.raises(batfigcsv.BatfigCSVError) as caught:
        batfigcsv.create_bundle(tmp_path, raw, "test.csv", {"x": "x", "ys": ["y"]})
    assert caught.value.code == code
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("value", ["", "NaN", "inf", "-inf", "1e999", "text"])
def test_selected_column_must_be_numeric_and_finite(tmp_path, value):
    raw = f"x,y\n0,1\n1,{value}\n".encode()
    inspected = batfigcsv.inspect_csv(raw)
    assert inspected["columns"][0]["numeric"] is True
    assert inspected["columns"][1]["numeric"] is False
    with pytest.raises(batfigcsv.BatfigCSVError) as caught:
        batfigcsv.create_bundle(tmp_path, raw, "test.csv", {"x": "x", "ys": ["y"]})
    assert caught.value.code == "csv_non_numeric"
    assert "3" in str(caught.value)
    assert list(tmp_path.iterdir()) == []


def test_unselected_text_columns_are_preserved(tmp_path):
    raw = b'sample,x,y\n"alpha, one",1,2\n"beta",2,3\n'
    metadata = batfigcsv.create_bundle(tmp_path, raw, "test.csv", {"x": "x", "ys": ["y"]})
    assert Path(metadata["data"]).read_bytes() == raw
    assert batfigcsv.inspect_csv(raw)["columns"][0]["numeric"] is False


@pytest.mark.parametrize(
    "mapping",
    [
        {},
        {"x": "Time", "ys": []},
        {"x": "Time", "ys": ["Time"]},
        {"x": "Time", "ys": ["Current", "Current"]},
        {"x": "missing", "ys": ["Current"]},
        {"x": "Time", "ys": "Current"},
        {"x": "Time", "ys": ["Current"], "sort": True},
    ],
)
def test_mapping_is_explicit_and_unambiguous(tmp_path, mapping):
    with pytest.raises(batfigcsv.BatfigCSVError, match="."):
        batfigcsv.create_bundle(tmp_path, RAW, "curve.csv", mapping)
    assert list(tmp_path.iterdir()) == []


def test_size_and_record_limits(monkeypatch):
    monkeypatch.setattr(batfigcsv, "MAX_BYTES", 8)
    with pytest.raises(batfigcsv.BatfigCSVError) as caught:
        batfigcsv.inspect_csv(RAW)
    assert caught.value.code == "csv_too_large"
    monkeypatch.setattr(batfigcsv, "MAX_BYTES", 1024)
    monkeypatch.setattr(batfigcsv, "MAX_ROWS", 2)
    with pytest.raises(batfigcsv.BatfigCSVError) as caught:
        batfigcsv.inspect_csv(RAW)
    assert caught.value.code == "csv_too_many_rows"


def test_failed_bundle_does_not_publish_partial_files(tmp_path, monkeypatch):
    original = batfigcsv.atomicio.write_bytes

    def fail_script(path, *args, **kwargs):
        if path.name == "figure.py":
            raise OSError("synthetic disk failure")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(batfigcsv.atomicio, "write_bytes", fail_script)
    with pytest.raises(OSError, match="synthetic disk failure"):
        batfigcsv.create_bundle(tmp_path, RAW, "curve.csv", MAPPING)
    assert list(tmp_path.iterdir()) == []


@pytest.fixture
def arial_python():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from matplotlib import font_manager, ft2font; "
            "p=font_manager.findfont('Arial', fallback_to_default=False); "
            "assert ft2font.FT2Font(p).family_name.casefold() == 'arial'",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    if result.returncode:
        pytest.skip("Actual licensed Arial and Matplotlib are required for this integration check")
    return sys.executable


def _run(python, script, wrapper=None):
    args = [python, str(script)] if wrapper is None else [python, "-c", wrapper, str(script)]
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        env={**os.environ, "PYTHONUTF8": "1"},
    )


def _assert_embedded_arial(pdf_path):
    with pikepdf.open(pdf_path) as pdf:
        fonts = list(pdf.pages[0].Resources.Font.values())
        assert fonts, "A text-bearing PDF must contain a font resource"
        for font in fonts:
            descendant = font.DescendantFonts[0]
            program = descendant.FontDescriptor.FontFile2.read_bytes()
            with TTFont(io.BytesIO(program)) as face:
                families = {
                    record.toUnicode() for record in face["name"].names if record.nameID == 1
                }
                assert families == {"Arial"}


def test_standalone_embeds_actual_arial_and_detects_source_changes(tmp_path, arial_python):
    metadata = batfigcsv.create_bundle(
        tmp_path,
        RAW,
        "curve.csv",
        {**MAPPING, "title": "α β Δ μ Ω", "y_label": "Area (cm²)"},
    )
    result = _run(arial_python, metadata["script"])
    assert result.returncode == 0, result.stderr
    directory = Path(metadata["directory"])
    _assert_embedded_arial(directory / (metadata["stem"] + ".pdf"))
    assert (directory / (metadata["stem"] + ".png")).stat().st_size > 1000
    # The predicate is the generated program's next execution, after raw bytes
    # change; a path existing or a hash merely being written cannot pass it.
    Path(metadata["data"]).write_bytes(RAW.replace(b"3.1", b"9.1"))
    result = _run(arial_python, metadata["script"])
    assert result.returncode != 0
    assert "csv_source_changed" in result.stderr


@pytest.mark.parametrize("scenario", ["absent", "substituted", "glyph"])
def test_generated_source_refuses_font_failure(tmp_path, arial_python, scenario):
    metadata = batfigcsv.create_bundle(tmp_path, RAW, "curve.csv", MAPPING)
    wrapper = "import runpy, sys; ns=runpy.run_path(sys.argv[1]); "
    if scenario == "absent":
        wrapper += (
            "ns['font_manager'].findfont=lambda *a,**kw: "
            "(_ for _ in ()).throw(ValueError('missing')); ns['main']()"
        )
        expected = "arial_missing:"
    elif scenario == "substituted":
        wrapper += (
            "p=ns['font_manager'].findfont('DejaVu Sans'); "
            "ns['font_manager'].findfont=lambda *a,**kw: p; ns['main']()"
        )
        expected = "arial_substituted:"
    else:
        wrapper += "ns['_check_glyphs']('\\U0010ffff', ns['_arial']()[1])"
        expected = "arial_missing_glyph:"
    result = _run(arial_python, metadata["script"], wrapper)
    assert result.returncode != 0
    assert expected in result.stderr
    assert list(Path(metadata["directory"]).glob("*.pdf")) == []


def test_worker_capture_edit_and_cold_replay_preserve_source(tmp_path, monkeypatch, arial_python):
    from tavotto.engine import pool

    monkeypatch.setenv("TAVOTTO_WORKER_PYTHON", arial_python)
    monkeypatch.setattr(pool, "ENGINE_CACHE", tmp_path / "engine-cache")
    metadata = batfigcsv.create_bundle(tmp_path, RAW, "curve.csv", MAPPING)
    root = str(tmp_path)
    script = str(Path(metadata["script"]).relative_to(tmp_path))
    stem = metadata["stem"]
    source_before = Path(metadata["data"]).read_bytes()
    spec_before = Path(metadata["spec"]).read_bytes()
    try:
        worker, response = pool.build(script, root, "main", allow_project_env=False)
        assert list(response["stems"]) == [stem]
        assert list(Path(metadata["directory"]).glob("*.pdf")) == []
        patches = [{"gid": "axes_0.ylabel", "prop": "text", "value": "Current (mA)"}]
        hot = worker.override(stem, patches)
        assert hot["warnings"] == []
        first_png = worker.render_png(stem, 600).read_bytes()
        hot_pdf = tmp_path / "hot.pdf"
        worker.export(stem, patches, str(hot_pdf), "pdf", 300)
        _assert_embedded_arial(hot_pdf)
        # Persist only overrides, then recreate the real worker and replay them.
        saved = tmp_path / "overrides.json"
        saved.write_text(json.dumps(patches), encoding="utf-8")
        pool.shutdown_all(root, wait=True)
        reopened, response = pool.build(script, root, "main", allow_project_env=False)
        cold = reopened.override(stem, json.loads(saved.read_text(encoding="utf-8")))
        assert cold["warnings"] == []
        assert reopened.render_png(stem, 600).read_bytes() == first_png
        assert Path(metadata["data"]).read_bytes() == source_before
        assert Path(metadata["spec"]).read_bytes() == spec_before
    finally:
        pool.shutdown_all(root, wait=True)


def test_worker_arial_mathtext_faces_and_missing_glyph_block(tmp_path, monkeypatch, arial_python):
    from tavotto.engine import pool

    monkeypatch.setenv("TAVOTTO_WORKER_PYTHON", arial_python)
    monkeypatch.setattr(pool, "ENGINE_CACHE", tmp_path / "engine-cache")
    script = tmp_path / "arial_math.py"
    script.write_text(
        "import matplotlib\n"
        "matplotlib.use('Agg')\n"
        "import matplotlib.pyplot as plt\n"
        "matplotlib.rcParams['font.family'] = ['Arial']\n"
        "def main():\n"
        "    fig, ax = plt.subplots(figsize=(3, 2))\n"
        "    ax.plot([0, 1], [0, 1])\n"
        "    ax.set_xlabel(r'$Li_{2}O$ / $mAh\\ g^{-1}$')\n"
        "    ax.set_ylabel('Signal')\n"
        "    ax.set_title('α β Δ μ Ω')\n"
        "    fig.savefig('arial_math.pdf')\n",
        encoding="utf-8",
    )
    root = str(tmp_path)
    try:
        worker, _ = pool.build(script.name, root, "main", allow_project_env=False)
        # Both regular and styled MathText glyphs must really embed Arial faces.
        patches = [
            {"gid": "axes_0.title", "prop": "weight", "value": "bold"},
            {"gid": "axes_0.ylabel", "prop": "style", "value": "italic"},
        ]
        hot = worker.override("arial_math", patches)
        assert hot["warnings"] == []
        pdf = tmp_path / "math-export.pdf"
        worker.export("arial_math", patches, str(pdf), "pdf", 300)
        _assert_embedded_arial(pdf)
        with pikepdf.open(pdf) as document:
            font_names = {str(font.BaseFont) for font in document.pages[0].Resources.Font.values()}
            assert any("Bold" in name for name in font_names)
            assert any("Italic" in name for name in font_names)
        invalid = [{"gid": "axes_0.ylabel", "prop": "text", "value": "Missing \U0010ffff"}]
        with pytest.raises(pool.WorkerError, match="arial_missing_glyph"):
            worker.override("arial_math", invalid)
        blocked_pdf = tmp_path / "must-not-exist.pdf"
        with pytest.raises(pool.WorkerError, match="arial_missing_glyph"):
            worker.export("arial_math", invalid, str(blocked_pdf), "pdf", 300)
        assert not blocked_pdf.exists()
        # A subsequent valid complete list restores the failed hot edit normally.
        restored = worker.override("arial_math", [])
        assert restored["warnings"] == []
    finally:
        pool.shutdown_all(root, wait=True)
