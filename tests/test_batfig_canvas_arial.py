"""Real local Arial, font rejection, vector embedding and canonical PNG replay.

These tests inspect exported font programs, not dropdown labels. Real-font cases
explicitly skip where Arial is absent; rejection cases always run.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
from dataclasses import replace

import pytest

from tavotto import pdfbackend
from tavotto.rendercore import facade, fonts, plan, typography
from tavotto.rendercore.hbshaper import HbFace
from tests.support import pdfread


@pytest.fixture
def arial():
    try:
        return fonts.local_arial_records()
    except fonts.FontsUnavailable as exc:
        pytest.skip(f"Real local Arial unavailable; not verified: {exc}")


def text_obj(**kw):
    return {
        "id": "arial-text",
        "type": "text",
        "text": "(a) H_{2}O α β γ Δ μ Ω Å °C mA h g^{-1}",
        "font_family": "Arial",
        "x_mm": 3,
        "y_mm": 3,
        "w_mm": 94,
        "h_mm": 10,
        "size_pt": 11,
        "color": "#000000",
        "padding_mm": 1,
        "interpretation": "auto",
        **kw,
    }


def test_missing_arial_is_explicit_and_does_not_use_packaged_sans(monkeypatch, tmp_path):
    monkeypatch.setenv(fonts.ARIAL_ENV, str(tmp_path / "absent"))
    with pytest.raises(fonts.FontsUnavailable) as exc:
        fonts.FontRegistry.discover().record_for("Arial")
    assert exc.value.code == "arial_missing"
    status = pdfbackend.canvas_font_status()
    assert status["available"] is False and status["code"] == "arial_missing"
    with pytest.raises(pdfbackend.CanvasTextError) as preview_error:
        pdfbackend.canvas_text_preview(text_obj())
    assert preview_error.value.code == "arial_missing"


def test_a_liberation_file_named_arial_is_rejected(monkeypatch, tmp_path):
    reg = fonts.FontRegistry.discover()
    if reg.missing:
        pytest.skip("Approved OFL fonts missing; run fetch_fonts")
    (tmp_path / "arial.ttf").write_bytes(reg.record_for("sans-serif").path.read_bytes())
    monkeypatch.setenv(fonts.ARIAL_ENV, str(tmp_path))
    with pytest.raises(fonts.FontsUnavailable) as exc:
        fonts.local_arial_records()
    assert exc.value.code == "arial_invalid"


@pytest.mark.parametrize("flag", [0x0002, 0x0100, 0x0200])
def test_restricted_embedding_or_subsetting_is_rejected(arial, monkeypatch, flag):
    original = fonts.read_sfnt
    monkeypatch.setattr(
        fonts, "read_sfnt", lambda p, **kw: replace(original(p, **kw), embedding_flags=flag)
    )
    with pytest.raises(fonts.FontsUnavailable) as exc:
        fonts.local_arial_records()
    assert exc.value.code == "arial_embedding_restricted"


def test_four_real_faces_match_independently_read_metadata_and_runtime_coverage(arial):
    from fontTools.ttLib import TTFont

    status = pdfbackend.canvas_font_status()
    assert status["available"] and len(status["faces"]) == 4
    for rec in arial.values():
        with TTFont(rec.path) as tt:
            assert tt["name"].getDebugName(1) == "Arial"
            assert tt["name"].getDebugName(6) == rec.info.postscript_name
            assert bool(tt["OS/2"].fsSelection & 0x20) == rec.approved.bold
            assert bool(tt["OS/2"].fsSelection & 1) == rec.approved.italic
        fact = next(f for f in status["faces"] if f["postscript_name"] == rec.info.postscript_name)
        assert fact["sha256"] == hashlib.sha256(rec.path.read_bytes()).hexdigest()
        cps = {cp for lo, hi in fact["primary"] for cp in range(lo, hi + 1)}
        assert cps == {cp for cp in rec.info.cmap if 0x20 <= cp < typography.COVERAGE_MAX_CP}


def test_arial_has_no_cjk_fallback_and_missing_glyph_blocks_export(arial, tmp_path):
    fs = typography.faces_for(facade.provider(), "Arial", False, False)
    assert fs.cjk is None
    assert pdfbackend.missing_glyphs("样品", family="Arial") == ["样", "品"]
    output = tmp_path / "must-not-exist.pdf"
    with pdfbackend.compose(100, 30) as canvas:
        canvas.place(text_obj(text="样品"), 288, lambda o, d: None)
        with pytest.raises(plan.PlanError) as exc:
            canvas.save_pdf(output)
    assert exc.value.params["font_code"] == "glyph_missing"
    assert not output.exists()
    with pytest.raises(pdfbackend.CanvasTextError) as exc:
        pdfbackend.canvas_text_preview(text_obj(text="样品"))
    assert exc.value.code == "glyph_missing" and exc.value.params["chars"] == ["样", "品"]


def test_the_shaper_rejects_changed_bytes_after_font_discovery(arial, monkeypatch):
    rec = next(iter(arial.values()))
    with pytest.raises(fonts.FontsUnavailable) as exc:
        HbFace(replace(rec, approved=replace(rec.approved, sha256="0" * 64)))
    assert exc.value.code == "font_file_invalid"


def test_saved_reopened_styles_embed_actual_arial_programs_and_png_matches_pdf(arial, tmp_path):
    from fontTools.ttLib import TTFont

    objects = [
        text_obj(id=f"text-{i}", y_mm=3 + 14 * i, bold=r.approved.bold, italic=r.approved.italic)
        for i, r in enumerate(arial.values())
    ]
    saved = tmp_path / "canvas.json"
    saved.write_text(json.dumps(objects, ensure_ascii=False), encoding="utf-8")
    reopened = json.loads(saved.read_text(encoding="utf-8"))
    for label, items in (("hot", objects), ("reopened", reopened)):
        with pdfbackend.compose(100, 66) as canvas:
            for obj in items:
                canvas.place(obj, 288, lambda o, d: None)
            canvas.save_pdf(tmp_path / f"{label}.pdf")
            canvas.save_png(tmp_path / f"{label}.png", 288)
            assert canvas.problems == []
    assert pdfread.decode_png_any((tmp_path / "hot.png").read_bytes()) == pdfread.decode_png_any(
        (tmp_path / "reopened.png").read_bytes()
    )
    parsed = pdfread.objects((tmp_path / "reopened.pdf").read_bytes())
    page, _ = pdfread.page(parsed)
    records = pdfread.fonts(parsed, page)
    assert {r["base"] for r in records.values()} == set(arial)
    for rec in records.values():
        assert rec["program"] and rec["tounicode"] and rec["kind"] == "truetype"
        with TTFont(io.BytesIO(rec["program"])) as tt:
            assert tt["name"].getDebugName(1) == "Arial"
            assert tt["name"].getDebugName(6) == rec["base"]
    direct = tmp_path / "direct.png"
    pdfbackend.original_png(tmp_path / "reopened.pdf", direct, 288)
    assert pdfread.decode_png_any(
        (tmp_path / "reopened.png").read_bytes()
    ) == pdfread.decode_png_any(direct.read_bytes())
    assert pdfread.media_box(page)[2:] == pytest.approx([100 * 72 / 25.4, 66 * 72 / 25.4], abs=1e-4)


def test_preview_uses_the_same_pixels_and_measured_wrap_height_as_export(arial, tmp_path):
    obj = text_obj(w_mm=40, rotation=27)
    result = pdfbackend.canvas_text_preview(obj)
    assert result["height_mm"] > 10
    normalized = dict(
        obj,
        x_mm=-result["offset_x_mm"],
        y_mm=-result["offset_y_mm"],
        h_mm=result["height_mm"],
        rotation=0,
    )
    preview = tmp_path / "preview.png"
    preview.write_bytes(base64.b64decode(result["png_base64"]))
    exported = tmp_path / "export.png"
    with pdfbackend.compose(
        result["image_width_mm"], result["image_height_mm"], transparent=True
    ) as canvas:
        canvas.place(normalized, 288, lambda o, d: None)
        canvas.save_png(exported, 288)
    assert pdfread.decode_png_any(preview.read_bytes()) == pdfread.decode_png_any(
        exported.read_bytes()
    )


@pytest.mark.parametrize(
    "patch",
    [
        {"w_mm": float("inf")},
        {"size_pt": float("nan")},
        {"w_mm": 501},
        {"size_pt": 145},
        {"w_mm": -1},
        {"text": "a" * 4097},
        {"font_family": "sans-serif"},
    ],
)
def test_preview_refuses_unbounded_or_non_arial_requests_before_font_loading(monkeypatch, patch):
    def no_fonts(*a, **kw):
        raise AssertionError("Validation must happen before font work")

    monkeypatch.setattr(facade, "_faces", no_fonts)
    with pytest.raises(pdfbackend.CanvasTextError) as exc:
        pdfbackend.canvas_text_preview(text_obj(**patch))
    assert exc.value.code == "text_preview_invalid"


def test_multiline_controls_are_layout_instructions_not_missing_glyphs(arial):
    from tavotto import glyphplan

    cov = fonts.arial_coverage()
    assert glyphplan.text_diagnostics("H_{2}O\r\nα\tβ", cov, "auto")[0] == []
    result = pdfbackend.canvas_text_preview(text_obj(text="H_{2}O\r\nα\tβ"))
    assert result["height_mm"] > 10


@pytest.mark.parametrize(
    "patch",
    [
        {"text": "f", "italic": True, "align": "right"},
        {"text": "^{Á}", "italic": True, "line_height": 0.5},
        {"text": "a_{2}", "underline": True, "line_height": 0.5},
        {"text": "(a)", "border_color": "#123456", "border_pt": 2},
    ],
)
def test_preview_keeps_ink_outside_object_bounds_without_clipping(arial, tmp_path, patch):
    obj = text_obj(padding_mm=0, w_mm=10, **patch)
    result = pdfbackend.canvas_text_preview(obj)
    assert result["offset_x_mm"] < 0 and result["offset_y_mm"] < 0
    # Render the same object on a larger independent page, at a pixel-aligned
    # origin. Cropping that page must recover every preview pixel, including bleed.
    px_mm = 25.4 / 288
    extra_px = 40
    extra = extra_px * px_mm
    larger = tmp_path / "larger.png"
    with pdfbackend.compose(
        result["image_width_mm"] + 2 * extra,
        result["image_height_mm"] + 2 * extra,
        transparent=True,
    ) as canvas:
        canvas.place(
            dict(
                obj,
                x_mm=extra - result["offset_x_mm"],
                y_mm=extra - result["offset_y_mm"],
                h_mm=result["height_mm"],
            ),
            288,
            lambda o, d: None,
        )
        canvas.save_png(larger, 288)
    from PIL import Image

    preview = Image.open(io.BytesIO(base64.b64decode(result["png_base64"]))).convert("RGBA")
    full = Image.open(larger).convert("RGBA")
    crop = full.crop((extra_px, extra_px, extra_px + preview.width, extra_px + preview.height))
    assert crop.tobytes() == preview.tobytes()
    outside = full.copy()
    outside.paste(
        (0, 0, 0, 0), (extra_px, extra_px, extra_px + preview.width, extra_px + preview.height)
    )
    assert not any(outside.getchannel("A").tobytes()), "The preview crop lost exported ink"
    assert not any(preview.getchannel("A").crop((0, 0, preview.width, 1)).tobytes())
    assert not any(
        preview.getchannel("A")
        .crop((0, preview.height - 1, preview.width, preview.height))
        .tobytes()
    )
