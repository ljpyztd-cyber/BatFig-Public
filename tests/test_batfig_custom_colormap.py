"""DIY color stops must color real data and replay in a fresh worker without a registry."""

from __future__ import annotations

import json
from io import BytesIO

import pikepdf
import pytest
from PIL import Image

from tavotto.engine import pool

SCRIPT = "custom_palette.py"
SPEC = {
    "type": "custom",
    "colors": ["#103a71", "#ffffe5", "#bd0026"],
    "positions": [0.0, 0.35, 1.0],
}
LIBRARY = """\
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap, Normalize

def main():
    z = np.linspace(0, 1, 25).reshape(5, 5)
    for kind in ('Image', 'Mesh'):
        for expected in (False, True):
            fig, ax = plt.subplots(figsize=(3, 2.5))
            cmap = (LinearSegmentedColormap.from_list('native_expected', [
                (0, '#103a71'), (0.35, '#ffffe5'), (1, '#bd0026')
            ]) if expected else 'coolwarm')
            if kind == 'Image':
                m = ax.imshow(z, cmap=cmap, vmin=0, vmax=1, interpolation='nearest')
            else:
                m = ax.pcolormesh(z, cmap=cmap, vmin=0, vmax=1, rasterized=False)
            cb = fig.colorbar(m, ax=ax)
            cb.n_rasterize = 100000
            cb.solids.set_rasterized(False)
            fig.savefig(kind + ('Expected' if expected else '') + '.pdf')
    fig, axes = plt.subplots(1, 2, figsize=(5, 2.5))
    norm = Normalize(0, 1)
    a = axes[0].pcolormesh(z, norm=norm, cmap='viridis')
    axes[1].pcolormesh(z, norm=norm, cmap='plasma')
    fig.colorbar(a, ax=list(axes))
    fig.savefig('Shared.pdf')
    for expected in (False, True):
        fig, axes = plt.subplots(1, 2, figsize=(5, 2.5))
        fig.patch.set_facecolor('#aabbcc')
        for ax in axes:
            ax.set_facecolor('#ffdd99')
            ax.plot([0, 1], [0, 1], color='#ff0000', linewidth=3)
        axes[1].patch.set_visible(False)
        inset = axes[0].inset_axes([0.1, 0.65, 0.2, 0.2])
        inset.set_facecolor('#99ccff')
        inset.plot([0, 1], [0, 1], color='#0000ff')
        if expected:
            fig.patch.set_visible(False)
            for ax in [*axes, inset]:
                ax.patch.set_visible(False)
        fig.savefig('BackgroundExpected.pdf' if expected else 'Background.pdf')
    fig = plt.figure(figsize=(3, 2.5))
    ax = fig.add_subplot(projection='3d')
    ax.plot([0, 1], [0, 1], [0, 1])
    fig.savefig('ThreeD.pdf')
"""


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    directory = tmp_path_factory.mktemp("custom-colormap")
    (directory / SCRIPT).write_text(LIBRARY, encoding="utf-8")
    return directory


@pytest.fixture(scope="module")
def worker(library):
    w = pool.one_shot(SCRIPT, str(library), "main")
    w.ensure_built()
    try:
        yield w
    finally:
        pool.discard(w)


def _patch(gid, value=SPEC):
    # Same transport boundary as a saved/reopened document, no Colormap object survives.
    return json.loads(json.dumps([{"gid": gid, "prop": "cmap", "value": value}]))


def _field(manifest, gid):
    element = next(e for e in manifest["elements"] if e["gid"] == gid)
    return next(f for f in element["editable"] if f["prop"] == "cmap")


def _render(worker, stem, patches):
    response = worker.override(stem, patches)
    assert response.get("warnings") == []
    return response["manifest"], worker.render_png(stem, 600).read_bytes()


@pytest.mark.parametrize("stem,kind", [("Image", "images"), ("Mesh", "collections")])
def test_diy_matches_native_pixels_aliases_undo_and_cold_replay(worker, library, stem, kind):
    gid, cb = f"axes_0.{kind}_0", "axes_1.colorbar"
    _, baseline = _render(worker, stem, [])
    _, expected = _render(worker, stem + "Expected", [])
    assert expected != baseline, "The pixel oracle must distinguish the original palette"
    for target in (gid, cb):
        patches = _patch(target)
        manifest, actual = _render(worker, stem, patches)
        assert actual == expected
        for alias in (gid, cb):
            field = _field(manifest, alias)
            assert field["value"] == SPEC
            assert field["cmap_current"]["custom"] is True
            assert field["cmap_current"]["discrete"] is False
            assert len(field["cmap_current"]["stops"]) == 9
        cold = pool.one_shot(SCRIPT, str(library), "main")
        try:
            replay_manifest, replay = _render(cold, stem, patches)
            assert replay == actual
            assert replay_manifest == manifest
        finally:
            pool.discard(cold)
        _, undone = _render(worker, stem, [])
        assert undone == baseline


def test_named_to_diy_to_named_and_implicit_positions(worker):
    gid = "axes_0.collections_0"
    _render(worker, "Mesh", [])
    _, named = _render(worker, "Mesh", _patch(gid, "viridis"))
    implicit = {"type": "custom", "colors": ["#103A71", "#FFFFFF", "#BD0026"]}
    manifest, custom = _render(worker, "Mesh", _patch(gid, implicit))
    assert custom != named
    assert _field(manifest, gid)["value"] == {
        "type": "custom",
        "colors": ["#103a71", "#ffffff", "#bd0026"],
        "positions": [0.0, 0.5, 1.0],
    }
    _, restored = _render(worker, "Mesh", _patch(gid, "viridis"))
    assert restored == named
    _render(worker, "Mesh", [])


def test_colorbar_broadcast_and_narrow_override_keep_each_original(worker, library):
    cb, a, b = "axes_2.colorbar", "axes_0.collections_0", "axes_1.collections_0"
    _, baseline = _render(worker, "Shared", [])
    broadcast = _patch(cb)
    narrow = _patch(b, "magma")
    for patches, expected_b in (
        (broadcast, SPEC),
        (broadcast + narrow, "magma"),
        (broadcast, SPEC),
    ):
        manifest, pixels = _render(worker, "Shared", patches)
        assert _field(manifest, a)["value"] == SPEC
        assert _field(manifest, b)["value"] == expected_b
        cold = pool.one_shot(SCRIPT, str(library), "main")
        try:
            cold_manifest, cold_pixels = _render(cold, "Shared", patches)
            assert cold_manifest == manifest
            assert cold_pixels == pixels
        finally:
            pool.discard(cold)
    manifest, undone = _render(worker, "Shared", [])
    assert undone == baseline
    assert _field(manifest, a)["value"] == "viridis"
    assert _field(manifest, b)["value"] == "plasma"


def test_invalid_stops_warn_without_recoloring_data_or_colorbar(worker):
    cb, gid = "axes_1.colorbar", "axes_0.collections_0"
    _, baseline = _render(worker, "Mesh", [])
    bad_values = [
        {"type": "unknown", "colors": SPEC["colors"]},
        {"type": "custom", "colors": SPEC["colors"][:2]},
        {"type": "custom", "colors": SPEC["colors"] * 11},
        {"type": "custom", "colors": ["red", "#ffffff", "#000000"]},
        {"type": "custom", "colors": ["#abcd", "#ffffff", "#000000"]},
        {**SPEC, "positions": [0, 0.5]},
        {**SPEC, "positions": [0, True, 1]},
        {**SPEC, "positions": [0, "0.5", 1]},
        {**SPEC, "positions": [0.1, 0.5, 1]},
        {**SPEC, "positions": [0, 0, 1]},
        {**SPEC, "positions": [0, 1.2, 1]},
        {**SPEC, "positions": [0, 0.5, 0.9]},
        {**SPEC, "extra": "not-supported"},
    ]
    for bad in bad_values:
        response = worker.override("Mesh", _patch(cb, bad))
        assert response.get("warnings"), bad
        assert _field(response["manifest"], gid)["value"] == "coolwarm", bad
        assert _field(response["manifest"], cb)["value"] == "coolwarm", bad
        assert worker.render_png("Mesh", 600).read_bytes() == baseline, bad
        _render(worker, "Mesh", [])


def test_diy_quadmesh_exports_vector_pdf_and_matching_png(worker, tmp_path):
    patches = _patch("axes_1.colorbar")
    _render(worker, "Mesh", patches)
    pdf, png = tmp_path / "mesh.pdf", tmp_path / "mesh.png"
    for output, fmt in ((pdf, "pdf"), (png, "png")):
        response = worker.export("Mesh", patches, str(output), fmt=fmt, dpi=200)
        assert not response.get("warnings"), response
        assert output.stat().st_size > 1000
    # Scalar QuadMesh cells and the colorbar must remain PDF paths, not one bitmap.
    with pikepdf.open(pdf) as document:
        xobjects = document.pages[0].Resources.get("/XObject", {})
        assert all(obj.get("/Subtype") != "/Image" for obj in xobjects.values())
        operators = [
            str(instruction.operator)
            for instruction in pikepdf.parse_content_stream(document.pages[0])
        ]
        assert operators.count("f") >= 25
    native_png = tmp_path / "native.png"
    worker.export("MeshExpected", [], str(native_png), fmt="png", dpi=200)
    assert png.read_bytes() == native_png.read_bytes()


def test_transparent_backgrounds_keep_data_and_restore_each_axes(worker, library):
    patches = [
        {"gid": "figure", "prop": "transparent", "value": True},
        {"gid": "figure", "prop": "axes_transparent", "value": True},
    ]
    _, baseline = _render(worker, "Background", [])
    _, expected = _render(worker, "BackgroundExpected", [])
    manifest, transparent = _render(worker, "Background", patches)
    assert transparent == expected
    assert transparent != baseline
    fields = next(e for e in manifest["elements"] if e["gid"] == "figure")["editable"]
    field = next(f for f in fields if f["prop"] == "axes_transparent")
    assert field["value"] is True
    assert field["value_original"] is False
    with Image.open(BytesIO(transparent)) as image:
        rgba = image.convert("RGBA")
        assert rgba.getpixel((1, 1))[3] == 0
        axes = next(e for e in manifest["elements"] if e["gid"] == "axes_0")
        x, y, w, h = axes["bbox"]
        assert (
            rgba.getpixel((round((x + 0.6 * w) * rgba.width), round((y + 0.2 * h) * rgba.height)))[
                3
            ]
            == 0
        )
        pixels = rgba.load()
        assert any(
            r > 200 and g < 50 and b < 50 and a > 200
            for y in range(rgba.height)
            for x in range(rgba.width)
            for r, g, b, a in [pixels[x, y]]
        )
    cold = pool.one_shot(SCRIPT, str(library), "main")
    try:
        cold_manifest, cold_png = _render(cold, "Background", json.loads(json.dumps(patches)))
        assert cold_png == transparent
        assert cold_manifest == manifest
    finally:
        pool.discard(cold)
    # Explicit fills remain underneath the transparent switch, then become visible.
    fill = {"gid": "axes_0", "prop": "facecolor", "value": "#008855"}
    _, hidden_fill = _render(worker, "Background", patches + [fill])
    assert hidden_fill == transparent
    _, revealed_fill = _render(worker, "Background", patches[:1] + [fill])
    assert revealed_fill != transparent
    _, restored = _render(worker, "Background", [])
    assert restored == baseline, "Undo must preserve originally hidden axes backgrounds"


def test_legacy_transparent_only_hides_figure_and_3d_backgrounds_are_unchanged(worker):
    _render(worker, "Background", [])
    _, legacy = _render(
        worker, "Background", [{"gid": "figure", "prop": "transparent", "value": True}]
    )
    _, both = _render(
        worker,
        "Background",
        [
            {"gid": "figure", "prop": "transparent", "value": True},
            {"gid": "figure", "prop": "axes_transparent", "value": True},
        ],
    )
    assert legacy != both
    _, baseline3d = _render(worker, "ThreeD", [])
    _, unchanged3d = _render(
        worker, "ThreeD", [{"gid": "figure", "prop": "axes_transparent", "value": True}]
    )
    assert unchanged3d == baseline3d
    _render(worker, "Background", [])
