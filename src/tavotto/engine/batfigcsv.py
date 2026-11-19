"""Bounded CSV import and reproducible curve bundles (parent process: stdlib only).

The source bytes and mapping are separate from canvas/artist overrides. A bundle
is published once in a fresh directory; its script checks the source digest on
every execution. This is a new CSV schema, not the legacy .batpanel format.
"""

from __future__ import annotations

import csv
import hashlib
import io
import math
import uuid
from pathlib import Path

from . import atomicio

MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 64
MAX_LABEL_LENGTH = 240
SCHEMA = "batfig-csv-curve-v1"


class BatfigCSVError(ValueError):
    """A CSV or mapping error that the UI can report without running a script."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _parse(raw: bytes) -> tuple[list[str], list[list[str]]]:
    if not isinstance(raw, bytes) or not raw:
        raise BatfigCSVError("csv_empty", "CSV 文件为空。")
    if len(raw) > MAX_BYTES:
        raise BatfigCSVError("csv_too_large", "CSV 文件不能超过 5 MiB。")
    try:
        decoded = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise BatfigCSVError("csv_encoding", "请提供 UTF-8 编码的 CSV 文件。") from exc
    if "\x00" in decoded:
        raise BatfigCSVError("csv_invalid", "CSV 文件含有空字符。")
    try:
        reader = csv.reader(io.StringIO(decoded, newline=""), strict=True)
        headers = [value.strip() for value in next(reader)]
        if not 2 <= len(headers) <= MAX_COLUMNS:
            raise BatfigCSVError("csv_columns", "CSV 必须有 2–64 列，并用英文逗号分隔。")
        if any(not name or len(name) > MAX_LABEL_LENGTH for name in headers):
            raise BatfigCSVError("csv_headers", "列名不能为空或超过 240 个字符。")
        if len(set(headers)) != len(headers):
            raise BatfigCSVError("csv_headers", "去除首尾空白后的列名必须唯一。")
        rows = []
        for row_number, row in enumerate(reader, start=2):
            if len(row) != len(headers):
                raise BatfigCSVError(
                    "csv_row_width", f"CSV 第 {row_number} 条记录的列数与表头不一致。"
                )
            if len(rows) >= MAX_ROWS:
                raise BatfigCSVError("csv_too_many_rows", "CSV 最多支持 100000 条数据记录。")
            rows.append(row)
    except (csv.Error, StopIteration) as exc:
        raise BatfigCSVError("csv_invalid", f"CSV 解析失败：{exc}") from exc
    if not rows:
        raise BatfigCSVError("csv_no_data", "CSV 只有表头，没有数据记录。")
    return headers, rows


def _numeric_error(rows: list[list[str]], index: int, name: str) -> str | None:
    for row_number, row in enumerate(rows, start=2):
        try:
            value = float(row[index])
        except ValueError:
            return f"第 {row_number} 条记录，列 {name!r} 不是数字或为空。"
        if not math.isfinite(value):
            return f"第 {row_number} 条记录，列 {name!r} 含有 NaN 或无穷大。"
    return None


def inspect_csv(raw: bytes) -> dict:
    """Inspect every record without dropping, sorting, interpolating or guessing units."""
    headers, rows = _parse(raw)
    columns = []
    for index, name in enumerate(headers):
        error = _numeric_error(rows, index, name)
        column = {"name": name, "index": index, "numeric": error is None}
        if error is not None:
            column["error"] = error
        columns.append(column)
    return {
        "columns": columns,
        "row_count": len(rows),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "byte_count": len(raw),
    }


def _mapping(mapping: dict, headers: list[str], rows: list[list[str]]) -> dict:
    if not isinstance(mapping, dict):
        raise BatfigCSVError("csv_mapping", "请明确选择一个 X 列和至少一个 Y 列。")
    allowed = {"x", "ys", "x_label", "y_label", "title"}
    if set(mapping) - allowed:
        raise BatfigCSVError("csv_mapping", "数据映射含有不支持的字段。")
    x, ys = mapping.get("x"), mapping.get("ys")
    if (
        not isinstance(x, str)
        or x not in headers
        or not isinstance(ys, list)
        or not ys
        or any(not isinstance(y, str) or y not in headers or y == x for y in ys)
        or len(set(ys)) != len(ys)
    ):
        raise BatfigCSVError("csv_mapping", "请选择有效且不重复的 X/Y 列，X 不能同时作为 Y。")
    for name in [x, *ys]:
        error = _numeric_error(rows, headers.index(name), name)
        if error:
            raise BatfigCSVError("csv_non_numeric", error)
    result = {"x": x, "ys": list(ys)}
    for key, default in (("x_label", x), ("y_label", ys[0] if len(ys) == 1 else ""), ("title", "")):
        label = mapping.get(key, default)
        if (
            not isinstance(label, str)
            or len(label) > MAX_LABEL_LENGTH
            or any(ord(char) < 32 and char != "\n" for char in label)
        ):
            raise BatfigCSVError("csv_label", "图标题和轴标题须为不超过 240 字符的文本。")
        result[key] = label
    return result


def create_bundle(parent_path: Path, raw: bytes, filename: str, mapping: dict) -> dict:
    """Publish a new, contained bundle under an already-authorized existing directory.

    The caller must apply its project-path authorization before calling this API.
    Only a UUID child is written here; the supplied original filename is metadata,
    never a filesystem component or executable source.
    """
    headers, rows = _parse(raw)
    normalized = _mapping(mapping, headers, rows)
    parent = Path(parent_path).resolve(strict=True)
    if not parent.is_dir():
        raise BatfigCSVError("csv_directory", "导入目标必须是已存在的项目目录。")
    original_name = str(filename).replace("\\", "/").rsplit("/", 1)[-1][:255]
    token = uuid.uuid4().hex
    stem = f"csv_{token}"
    target = parent / f"csv-{token}"
    staging = parent / f".csv-{token}.tmp"
    sha256 = hashlib.sha256(raw).hexdigest()
    spec = {
        "schema": SCHEMA,
        "source": {
            "file": "source.csv",
            "original_filename": original_name,
            "sha256": sha256,
            "encoding": "utf-8-sig",
            "delimiter": ",",
            "columns": headers,
            "row_count": len(rows),
        },
        "mapping": normalized,
        "style": {"font_family": "Arial", "width_mm": 90, "height_mm": 65, "dpi": 300},
        "output_stem": stem,
        "series": [
            {"column": name, "gid": f"csv-line-{headers.index(name)}"} for name in normalized["ys"]
        ],
    }
    staging.mkdir()
    try:
        atomicio.write_bytes(staging / "source.csv", raw)
        atomicio.write_json(staging / "figure.json", spec, indent=2)
        atomicio.write_bytes(staging / "figure.py", _SCRIPT.encode("utf-8"))
        staging.rename(target)
    except BaseException:
        # Only the three files created by this call can be removed. Do not recurse
        # over a user directory and do not mask failed cleanup.
        for name in ("source.csv", "figure.json", "figure.py"):
            path = staging / name
            if path.is_file():
                path.unlink()
        if staging.is_dir():
            staging.rmdir()
        raise
    return {
        "directory": str(target),
        "script": str(target / "figure.py"),
        "spec": str(target / "figure.json"),
        "data": str(target / "source.csv"),
        "stem": stem,
        "sha256": sha256,
        "row_count": len(rows),
        "mapping": normalized,
    }


# A standalone scientific source, intentionally without an import of Tavotto.
# JSON carries user text/data; no user strings are interpolated into Python code.
_SCRIPT = '''"""CSV curve source. Source bytes/spec are separate from canvas overrides.

Run with Python + Matplotlib. Arial must be installed and contain every glyph.
"""

import csv
import hashlib
import io
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager, ft2font
from matplotlib.text import Text


def _arial():
    try:
        path = font_manager.findfont(
            font_manager.FontProperties(family=["Arial"], style="normal", weight="normal"),
            fallback_to_default=False,
        )
    except ValueError as exc:
        raise RuntimeError("arial_missing: Install a licensed Arial font; substitution is disabled.") from exc
    face = ft2font.FT2Font(path)
    if face.family_name.casefold() != "arial":
        raise RuntimeError("arial_substituted: The resolved font is not Arial.")
    return path, face.get_charmap()


def _check_glyphs(text, charmap):
    missing = sorted({ord(char) for char in text if char not in "\\n\\r\\t" and ord(char) not in charmap})
    if missing:
        codes = ", ".join(f"U+{code:04X}" for code in missing)
        raise RuntimeError(f"arial_missing_glyph: Arial does not contain {codes}. No font substitution is allowed.")


def main():
    here = Path(__file__).resolve().parent
    spec = json.loads((here / "figure.json").read_text(encoding="utf-8"))
    if spec["schema"] != "batfig-csv-curve-v1":
        raise RuntimeError("csv_schema: Unsupported CSV figure schema.")
    raw = (here / "source.csv").read_bytes()
    if hashlib.sha256(raw).hexdigest() != spec["source"]["sha256"]:
        raise RuntimeError("csv_source_changed: Source bytes differ from the imported source. Re-import the CSV.")
    reader = csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline=""), strict=True)
    headers = [name.strip() for name in next(reader)]
    rows = list(reader)
    if headers != spec["source"]["columns"] or len(rows) != spec["source"]["row_count"]:
        raise RuntimeError("csv_source_changed: Source structure does not match the figure spec.")
    mapping = spec["mapping"]
    selected = [mapping["x"], *mapping["ys"]]
    values = {name: [] for name in selected}
    for row_number, row in enumerate(rows, start=2):
        if len(row) != len(headers):
            raise RuntimeError(f"csv_row_width: Record {row_number} has the wrong column count.")
        for name in selected:
            try:
                value = float(row[headers.index(name)])
            except ValueError as exc:
                raise RuntimeError(f"csv_non_numeric: Record {row_number}, column {name!r}.") from exc
            if not math.isfinite(value):
                raise RuntimeError(f"csv_non_numeric: Record {row_number}, column {name!r} is not finite.")
            values[name].append(value)
    _, charmap = _arial()
    labels = [mapping["x_label"], mapping["y_label"], mapping["title"], *mapping["ys"]]
    for label in [*labels, "0123456789.e+−"]:
        _check_glyphs(label, charmap)
    if spec["style"]["font_family"] != "Arial":
        raise RuntimeError("arial_required: CSV curves require Arial.")
    matplotlib.rcParams.update({
        "font.family": ["Arial"], "font.sans-serif": ["Arial"], "font.size": 9,
        "axes.labelsize": 9, "axes.titlesize": 9, "axes.titleweight": "normal",
        "legend.fontsize": 8, "xtick.labelsize": 8, "ytick.labelsize": 8,
        "text.usetex": False, "text.parse_math": False, "axes.formatter.use_mathtext": False,
        "pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none",
        "axes.unicode_minus": True,
    })
    style = spec["style"]
    fig, ax = plt.subplots(figsize=(style["width_mm"] / 25.4, style["height_mm"] / 25.4))
    fig.subplots_adjust(left=0.21, right=0.96, bottom=0.22, top=0.88)
    ax.set_gid("csv-axes")
    for series in spec["series"]:
        name = series["column"]
        line, = ax.plot(values[mapping["x"]], values[name], label=name, linewidth=1.2)
        line.set_gid(series["gid"])
    ax.set_xlabel(mapping["x_label"])
    ax.set_ylabel(mapping["y_label"])
    ax.set_title(mapping["title"])
    ax.xaxis.label.set_gid("csv-x-label")
    ax.yaxis.label.set_gid("csv-y-label")
    ax.title.set_gid("csv-title")
    legend = ax.legend(frameon=False, loc="best")
    for index, text in enumerate(legend.get_texts()):
        text.set_gid(spec["series"][index]["gid"] + "-legend")
    # Check generated tick labels too; keep family-based properties so later
    # canvas weight/style edits can choose the corresponding genuine Arial face.
    fig.canvas.draw()
    for text in fig.findobj(match=Text):
        _check_glyphs(text.get_text(), charmap)
        text.set_parse_math(False)
    stem = spec["output_stem"]
    if not stem.startswith("csv_") or len(stem) != 36 or any(c not in "0123456789abcdef" for c in stem[4:]):
        raise RuntimeError("csv_output_stem: Invalid output stem.")
    fig.savefig(here / (stem + ".pdf"))
    fig.savefig(here / (stem + ".png"), dpi=style["dpi"])
    return fig


if __name__ == "__main__":
    main()
'''
