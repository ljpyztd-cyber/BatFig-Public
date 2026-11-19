"""Tick字号包含实际绘出的科学计数倍率，但撤销保留其独立的脚本字号。

探针在科学解释器里直接读取真正的 offset Text，并对拍完整 RGBA；manifest
没有独立注册 offset 元素，单看字段回显会漏掉这个回归。pytest 进程不导入 MPL。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from tavotto.engine import pool

try:
    WORKER_PY = pool.find_worker_python()
except pool.WorkerError:
    WORKER_PY = None

pytestmark = pytest.mark.skipif(WORKER_PY is None, reason="No matplotlib worker interpreter")
ENGINE = Path(__file__).resolve().parents[1] / "src" / "tavotto" / "engine"

PROBE = """
import hashlib, json, sys
sys.path.insert(0, ENGINE)
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import manifest, overrides

def make():
    fig, ax = plt.subplots(figsize=(5, 4), dpi=100)
    ax.plot([1000000, 1000001, 1000002], [0.00002, 0.00003, 0.00004])
    ax.ticklabel_format(axis="x", style="plain", useOffset=True)
    ax.ticklabel_format(axis="y", style="sci", scilimits=(0, 0), useOffset=False)
    ax.tick_params(axis="x", which="both", labelsize=9, labelcolor="#123456")
    ax.tick_params(axis="y", which="both", labelsize=10, labelcolor="#654321")
    ax.xaxis.get_offset_text().set_fontsize(5)
    ax.yaxis.get_offset_text().set_fontsize(6)
    ax.set_xlabel("Time (s)", fontsize=11)
    ax.set_ylabel("Current (A)", fontsize=13)
    note = ax.text(0.4, 0.5, "note", transform=ax.transAxes, fontsize=7)
    image = ax.imshow([[0, 1], [2, 3]], visible=False, aspect="auto")
    cb = fig.colorbar(image, ax=ax)
    cb.ax.tick_params(labelsize=8)
    cb.ax.yaxis.get_offset_text().set_fontsize(4)
    ax.set_xlim(999999.9, 1000002.1)
    ax.set_ylim(0.000019, 0.000041)
    state = overrides.FigState(fig)
    manifest.instrument(state)
    return state, ax, cb, note

def draw(state):
    state.fig.canvas.draw()
    return hashlib.sha256(state.fig.canvas.buffer_rgba()).hexdigest()

def values(ax):
    return {
        which: {
            "ticks": [t.get_fontsize() for t in getattr(ax, f"get_{which}ticklabels")()],
            "offset_size": getattr(ax, f"{which}axis").get_offset_text().get_fontsize(),
            "offset_text": getattr(ax, f"{which}axis").get_offset_text().get_text(),
        }
        for which in ("x", "y")
    }

def apply(state, patches):
    warnings = overrides.apply(state, patches)
    assert not warnings, warnings
    return draw(state)

def field(state, which):
    result = manifest.build_manifest(state, "offset")
    element = next(e for e in result["elements"] if e["gid"] == f"axes_0.{which}ticks")
    return next(f for f in element["editable"] if f["prop"] == "fontsize")
"""


def _run(body: str, which: str) -> dict:
    result = subprocess.run(
        [WORKER_PY, "-c", f"ENGINE = {str(ENGINE)!r}\n" + PROBE + body, which],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=90,
    )
    assert result.returncode == 0, result.stderr[-4000:]
    return json.loads(result.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("which", ["x", "y"])
def test_real_scientific_offset_follows_ticks_and_restores_distinct_original(which):
    got = _run(
        """
which = sys.argv[1]
state, ax, cb, note = make()
baseline_png = draw(state)
baseline = values(ax)
other = "y" if which == "x" else "x"
colorbar_before = values(cb.ax)
limits = [list(ax.get_xlim()), list(ax.get_ylim())]
colors = [t.get_color() for t in getattr(ax, f"get_{which}ticklabels")()]
patch = [{"gid": f"axes_0.{which}ticks", "prop": "fontsize", "value": 12}]
changed_png = apply(state, patch)
changed = values(ax)
changed_field = field(state, which)
assert values(cb.ax) == colorbar_before
assert [list(ax.get_xlim()), list(ax.get_ylim())] == limits
assert [t.get_color() for t in getattr(ax, f"get_{which}ticklabels")()] == colors
assert [ax.xaxis.label.get_fontsize(), ax.yaxis.label.get_fontsize(), note.get_fontsize()] == [11, 13, 7]
restored_png = apply(state, [])
print(json.dumps({"baseline": baseline, "changed": changed, "restored": values(ax),
                  "field": changed_field, "restored_field": field(state, which),
                  "changed_pixels": changed_png != baseline_png,
                  "restored_pixels": restored_png == baseline_png}))
""",
        which,
    )
    before, after = got["baseline"][which], got["changed"][which]
    assert before["offset_text"]  # The regression concerns text that is actually drawn.
    assert before["offset_size"] != before["ticks"][0]
    assert set(after["ticks"]) == {12}
    assert after["offset_size"] == 12
    assert after["offset_text"] == before["offset_text"]
    other = "y" if which == "x" else "x"
    assert got["changed"][other] == got["baseline"][other]
    assert got["field"]["value"] == 12
    assert got["field"]["value_original"] == before["ticks"][0]
    assert "value_original" not in got["restored_field"]
    assert got["changed_pixels"] and got["restored_pixels"]
    assert got["restored"] == got["baseline"]


@pytest.mark.parametrize("which", ["x", "y"])
def test_offset_fontsize_hot_edit_and_undo_match_cold_replay(which):
    hot = _run(
        """
which = sys.argv[1]
hot, hot_ax, _, _ = make()
draw(hot)
patch = {"gid": f"axes_0.{which}ticks", "prop": "fontsize", "value": 12}
apply(hot, [{**patch, "value": 15}])
apply(hot, [])
hot_png = apply(hot, [patch])
print(json.dumps({"pixels": hot_png, "values": values(hot_ax),
                  "field": field(hot, which)}))
""",
        which,
    )
    # Separate interpreter: no surviving Figure, rc state, or originals table.
    cold = _run(
        """
which = sys.argv[1]
cold, cold_ax, _, _ = make()
patch = {"gid": f"axes_0.{which}ticks", "prop": "fontsize", "value": 12}
cold_png = apply(cold, [patch])
print(json.dumps({"pixels": cold_png, "values": values(cold_ax),
                  "field": field(cold, which)}))
""",
        which,
    )
    assert hot["values"][which]["offset_text"]
    assert hot["values"][which]["offset_size"] == 12
    assert hot == cold


@pytest.mark.parametrize("order", ["broad-first", "narrow-first"])
def test_colorbar_control_and_its_tickset_still_restore_independently(order):
    got = _run(
        """
order = sys.argv[1]
broad = {"gid": "axes_1.colorbar", "prop": "tick_fontsize", "value": 11}
narrow = {"gid": "axes_1.yticks", "prop": "fontsize", "value": 14}
both = [broad, narrow] if order == "broad-first" else [narrow, broad]
restored = []
for survivor in (broad, narrow):
    hot, ax, cb, _ = make()
    baseline = draw(hot)
    main_before = values(ax)
    for patches in (both, [survivor], []):
        hot_png = apply(hot, patches)
        cold, _, cold_cb, _ = make()
        cold_png = apply(cold, patches)
        assert hot_png == cold_png, patches
        assert values(cb.ax) == values(cold_cb.ax), patches
        assert values(ax) == main_before, patches
        plt.close(cold.fig)
    restored.append(draw(hot) == baseline)
    plt.close(hot.fig)
print(json.dumps({"restored_pixels": all(restored)}))
""",
        order,
    )
    assert got["restored_pixels"]
