"""BatFig 的默认 Arial 行为；检查实际预检结果，不仅比较配置文本。"""

import pytest

from tavotto.engine import preflight, profiles, profilestore


def _font_findings(family):
    manifest = {
        "stem": "Arial probe",
        "size_mm": [95.25, 76.2],
        "elements": [
            {
                "gid": "axes_0.xlabel",
                "role": "axis_label",
                "bbox": [0.1, 0.1, 0.2, 0.1],
                "editable": [
                    {"prop": "fontfamily", "value": family},
                    {"prop": "fontsize", "value": 8.0},
                    {"prop": "text", "value": "Distance (nm)"},
                ],
            }
        ],
    }
    return [
        item
        for item in preflight.run(preflight.spec_from_manifest(manifest), profiles.load())
        if item["id"] == "font-family-substituted"
    ]


@pytest.mark.parametrize(
    "family",
    [
        "Arial",
        "ArialMT",
        "Arial-BoldMT",
        "Arial-ItalicMT",
        "Arial-BoldItalicMT",
        "Times New Roman",
        "TimesNewRomanPSMT",
        "TimesNewRomanPS-BoldMT",
        "TimesNewRomanPS-ItalicMT",
        "TimesNewRomanPS-BoldItalicMT",
    ],
)
def test_arial_faces_pass(family):
    assert profiles.default_profile_id() == "batfig-arial-v1"
    assert _font_findings(family) == []


@pytest.mark.parametrize(
    "family",
    ["Times", "Liberation Serif", "Liberation Sans", "DejaVu Sans", "Helvetica", "sans-serif"],
)
def test_substitutions_are_blocking(family):
    findings = _font_findings(family)
    assert len(findings) == 1
    assert findings[0]["severity"] == "error"


def test_default_style_applies_arial_to_all_figure_text_roles(tmp_path, monkeypatch):
    monkeypatch.setenv("TAVOTTO_DATA_DIR", str(tmp_path))
    element = profilestore.list_profiles(profilestore.KIND_STYLE)[0]["data"]["element"]
    for role in ("text", "title", "axis_label", "ticks", "legend_text"):
        assert element[role]["fontfamily"] == "Arial"
    assert element["ticks"]["fontsize"] == 7.0
    assert element["axis_label"]["fontsize"] == 8.0


def test_existing_upstream_profile_remains_explicitly_readable():
    assert profiles.load("lab-publication-v1")["font_family"]["latin"] == "Times New Roman"
