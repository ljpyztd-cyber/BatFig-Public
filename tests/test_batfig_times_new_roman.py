"""Actual TNR programs, precise family failures, preview/export and worker replay.

Font-dependent cases explicitly skip without local licensed fonts. Rejection tests
remain meaningful independently of a UI label or requested family string.
"""

import base64
import io
import json
import math
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pikepdf
import pytest
from fontTools.ttLib import TTFont

from tavotto import pdfbackend
from tavotto.engine import pool
from tavotto.engine.fontpolicy import LOCAL_FONT_FAMILIES
from tavotto.rendercore import fonts, identity
from tests.support import pdfread

FAMILY = "Times New Roman"
ENV = "BATFIG_TIMES_NEW_ROMAN_DIR"


@pytest.fixture
def tnr():
    try:
        return fonts.local_font_records(FAMILY)
    except fonts.FontsUnavailable as exc:
        pytest.skip(f"Actual TNR not installed: {exc}")


def text_obj(**kw):
    return {
        "type": "text",
        "text": "(a) Li_{2}O α β μ Ω Δ Å mAh g^{-1}",
        "font_family": FAMILY,
        "interpretation": "auto",
        "x_mm": 3,
        "y_mm": 3,
        "w_mm": 86,
        "h_mm": 12,
        "size_pt": 10,
        "padding_mm": 1,
        **kw,
    }


def test_missing_family_does_not_use_serif_or_arial(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV, str(tmp_path / "missing"))
    status = pdfbackend.canvas_font_status(FAMILY)
    assert not status["available"] and status["code"] == "local_font_missing"
    with pytest.raises(pdfbackend.CanvasTextError) as caught:
        pdfbackend.canvas_text_preview(text_obj())
    assert caught.value.code == "local_font_missing"
    assert caught.value.params == {"family": FAMILY}


def test_a_renamed_substitute_cannot_claim_tnr(monkeypatch, tmp_path):
    substitute = fonts.FontRegistry.discover().record_for("serif")
    (tmp_path / "times.ttf").write_bytes(substitute.path.read_bytes())
    monkeypatch.setenv(ENV, str(tmp_path))
    with pytest.raises(fonts.FontsUnavailable) as caught:
        fonts.local_font_records(FAMILY)
    assert caught.value.code == "local_font_invalid"


@pytest.mark.parametrize("flag", [2, 0x100, 0x200])
def test_tnr_embedding_and_subsetting_restrictions_fail(tnr, monkeypatch, flag):
    original = fonts.read_sfnt
    monkeypatch.setattr(
        fonts, "read_sfnt", lambda path, **kw: replace(original(path, **kw), embedding_flags=flag)
    )
    with pytest.raises(fonts.FontsUnavailable) as caught:
        fonts.local_font_records(FAMILY)
    assert caught.value.code == "local_font_embedding_restricted"


def test_family_metadata_and_missing_face_are_not_inferred_from_filenames(
    tnr, monkeypatch, tmp_path
):
    assert len(tnr) == 4
    for rec in tnr.values():
        with TTFont(rec.path) as tt:
            assert tt["name"].getDebugName(1) == FAMILY
            assert tt["name"].getDebugName(6) == rec.info.postscript_name
        if not rec.approved.bold or not rec.approved.italic:
            (tmp_path / rec.path.name).write_bytes(rec.path.read_bytes())
    monkeypatch.setenv(ENV, str(tmp_path))
    with pytest.raises(fonts.FontsUnavailable) as caught:
        fonts.local_font_records(FAMILY)
    assert caught.value.code == "local_font_missing"


def test_missing_glyph_is_blocked_and_local_font_bytes_change_cache_identity(tnr, monkeypatch):
    with pytest.raises(pdfbackend.CanvasTextError) as caught:
        pdfbackend.canvas_text_preview(text_obj(text="\U0010ffff"))
    assert caught.value.code == "glyph_missing"
    assert caught.value.params["family"] == FAMILY
    original = identity.local_font_records
    before = identity.fonts_policy_version()

    def changed(family):
        records = original(family)
        if family == FAMILY:
            return {
                key: replace(rec, approved=replace(rec.approved, sha256="0" * 64))
                for key, rec in records.items()
            }
        return records

    monkeypatch.setattr(identity, "local_font_records", changed)
    assert identity.fonts_policy_version() != before


@pytest.mark.parametrize(
    "bold,italic", [(False, False), (True, False), (False, True), (True, True)]
)
def test_tnr_preview_exactly_matches_export_in_all_styles(tnr, tmp_path, bold, italic):
    obj = text_obj(bold=bold, italic=italic, w_mm=35)
    preview = pdfbackend.canvas_text_preview(obj)
    assert preview["font_family"] == FAMILY
    normalized = dict(
        obj, x_mm=-preview["offset_x_mm"], y_mm=-preview["offset_y_mm"], h_mm=preview["height_mm"]
    )
    output = tmp_path / "export.png"
    with pdfbackend.compose(
        preview["image_width_mm"], preview["image_height_mm"], transparent=True
    ) as canvas:
        canvas.place(normalized, 288, lambda o, d: None)
        canvas.save_png(output, 288)
    assert pdfread.decode_png_any(
        base64.b64decode(preview["png_base64"])
    ) == pdfread.decode_png_any(output.read_bytes())


def test_preview_wrap_uses_selected_face_metrics(tnr):
    """Repeated i has no kerning/ligatures; independent hmtx fixes its line count."""
    regular = next(rec for rec in tnr.values() if not rec.approved.bold and not rec.approved.italic)
    with TTFont(regular.path) as tt:
        advance = tt["hmtx"][tt.getBestCmap()[ord("i")]][0] / tt["head"].unitsPerEm
    obj = text_obj(text="i" * 35, w_mm=12, padding_mm=1, size_pt=10, line_height=1.25)
    chars_per_line = math.floor((12 - 2) * 72 / 25.4 / (advance * 10))
    expected_height = math.ceil(35 / chars_per_line) * 10 * 1.25 * 25.4 / 72 + 2
    preview = pdfbackend.canvas_text_preview(obj)
    assert preview["height_mm"] == pytest.approx(expected_height)


def test_saved_mixed_canvas_embeds_eight_actual_faces_and_png_matches_pdf(tnr, tmp_path):
    try:
        arial = fonts.local_arial_records()
    except fonts.FontsUnavailable as exc:
        pytest.skip(f"Actual Arial not installed: {exc}")
    records = [*arial.values(), *tnr.values()]
    objects = [
        text_obj(
            font_family=rec.approved.family,
            y_mm=3 + i * 10,
            bold=rec.approved.bold,
            italic=rec.approved.italic,
        )
        for i, rec in enumerate(records)
    ]
    saved = tmp_path / "saved.json"
    saved.write_text(json.dumps(objects), encoding="utf-8")
    for label, data in (
        ("hot", objects),
        ("reopened", json.loads(saved.read_text(encoding="utf-8"))),
    ):
        with pdfbackend.compose(95, 88) as canvas:
            for obj in data:
                canvas.place(obj, 288, lambda o, d: None)
            canvas.save_pdf(tmp_path / f"{label}.pdf")
            canvas.save_png(tmp_path / f"{label}.png", 288)
    parsed = pdfread.objects((tmp_path / "reopened.pdf").read_bytes())
    page, _ = pdfread.page(parsed)
    embedded = pdfread.fonts(parsed, page)
    assert {rec["base"] for rec in embedded.values()} == set(arial) | set(tnr)
    for rec in embedded.values():
        assert rec["program"] and rec["tounicode"]
        with TTFont(io.BytesIO(rec["program"])) as tt:
            assert tt["name"].getDebugName(1) in LOCAL_FONT_FAMILIES
            assert tt["name"].getDebugName(6) == rec["base"]
    pdfbackend.original_png(tmp_path / "reopened.pdf", tmp_path / "direct.png", 288)
    assert (
        pdfread.decode_png_any((tmp_path / "hot.png").read_bytes())
        == pdfread.decode_png_any((tmp_path / "reopened.png").read_bytes())
        == pdfread.decode_png_any((tmp_path / "direct.png").read_bytes())
    )


def test_worker_tnr_mathtext_edit_cold_replay_and_mixed_math_refusal(tnr, monkeypatch, tmp_path):
    monkeypatch.setenv("TAVOTTO_WORKER_PYTHON", sys.executable)
    monkeypatch.setattr(pool, "ENGINE_CACHE", tmp_path / "engine-cache")
    script = tmp_path / "tnr.py"
    script.write_text(
        "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nmatplotlib.rcParams['font.family']=['Times New Roman']\ndef main():\n    fig,ax=plt.subplots(figsize=(3,2))\n    ax.plot([0,1],[0,1])\n    ax.set_xlabel(r'$Li_{2}O$ / $mAh\\ g^{-1}$')\n    ax.set_ylabel('Signal')\n    ax.set_title('α β Δ μ Ω')\n    fig.savefig('tnr.pdf')\n",
        encoding="utf-8",
    )
    root = str(tmp_path)
    patches = [
        {"gid": "axes_0.title", "prop": "weight", "value": "bold"},
        {"gid": "axes_0.ylabel", "prop": "style", "value": "italic"},
    ]
    try:
        worker, _ = pool.build(script.name, root, "main", allow_project_env=False)
        hot = worker.override("tnr", patches)
        assert hot["warnings"] == []
        worker.export("tnr", patches, str(tmp_path / "hot.pdf"), "pdf", 288)
        pool.shutdown_all(root, wait=True)
        worker, _ = pool.build(script.name, root, "main", allow_project_env=False)
        cold = worker.override("tnr", patches)
        assert cold["manifest"] == hot["manifest"]
        worker.export("tnr", patches, str(tmp_path / "cold.pdf"), "pdf", 288)
        for name in ("hot", "cold"):
            with pikepdf.open(tmp_path / f"{name}.pdf") as document:
                embedded = document.pages[0].Resources.Font.values()
                for rec in embedded:
                    descriptor = rec.DescendantFonts[0].FontDescriptor
                    with TTFont(io.BytesIO(descriptor.FontFile2.read_bytes())) as tt:
                        assert tt["name"].getDebugName(1) == FAMILY
        invalid = [{"gid": "axes_0.ylabel", "prop": "text", "value": "\U0010ffff"}]
        with pytest.raises(pool.WorkerError, match="local_font_missing_glyph"):
            worker.override("tnr", invalid)
        mixed = [
            {"gid": "axes_0.ylabel", "prop": "fontfamily", "value": "Arial"},
            {"gid": "axes_0.ylabel", "prop": "text", "value": "$x^2$"},
        ]
        with pytest.raises(pool.WorkerError, match="local_font_mixed_mathtext"):
            worker.override("tnr", mixed)
        assert worker.override("tnr", [])["warnings"] == []
    finally:
        pool.shutdown_all(root, wait=True)


def test_mathtext_bold_face_cannot_silently_resolve_to_same_family_regular(tnr):
    """Outer text is normal; only the embedded math asks for bold."""
    driver = r"""
import sys
sys.path.insert(0, sys.argv[1])
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
import overrides

family = "Times New Roman"
regular = font_manager.findfont(font_manager.FontProperties(family=[family]), fallback_to_default=False)
fig = plt.figure()
text = fig.text(.1, .1, r"$\mathbf{ABC}$", fontfamily=family, fontweight="normal")
assert text.get_fontproperties().get_weight() == "normal"
original = font_manager.findfont
intercepted = []
def missing_bold(properties, *a, **kw):
    if properties.get_family() == [family] and properties.get_weight() == "bold":
        intercepted.append(properties.get_weight())
        return regular
    return original(properties, *a, **kw)
font_manager.findfont = missing_bold
try:
    with overrides.local_font_render_context(fig):
        pass
except ValueError as exc:
    assert "local_font_missing_face" in str(exc), str(exc)
    assert intercepted == ["bold"], intercepted
else:
    raise AssertionError("MathText accepted a regular face for its bold request")
"""
    engine = Path(__file__).resolve().parents[1] / "src" / "tavotto" / "engine"
    result = subprocess.run(
        [sys.executable, "-c", driver, str(engine)], capture_output=True, text=True, timeout=45
    )
    assert result.returncode == 0, result.stdout + result.stderr
