"""Strict user-installed font families shared by the flat worker and RenderCore.

Metadata only: standard library, no fonts, file access or Matplotlib import.
Aliases and generic families never establish the identity of a named font.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LocalFontFamily:
    name: str
    env: str
    error_prefix: str
    faces: tuple[tuple[str, str, bool, bool], ...]


LOCAL_FONT_FAMILIES = {
    "Arial": LocalFontFamily(
        "Arial",
        "BATFIG_ARIAL_DIR",
        "arial",
        (
            ("arial.ttf", "ArialMT", False, False),
            ("arialbd.ttf", "Arial-BoldMT", True, False),
            ("ariali.ttf", "Arial-ItalicMT", False, True),
            ("arialbi.ttf", "Arial-BoldItalicMT", True, True),
        ),
    ),
    "Times New Roman": LocalFontFamily(
        "Times New Roman",
        "BATFIG_TIMES_NEW_ROMAN_DIR",
        "local_font",
        (
            ("times.ttf", "TimesNewRomanPSMT", False, False),
            ("timesbd.ttf", "TimesNewRomanPS-BoldMT", True, False),
            ("timesi.ttf", "TimesNewRomanPS-ItalicMT", False, True),
            ("timesbi.ttf", "TimesNewRomanPS-BoldItalicMT", True, True),
        ),
    ),
}


def strict_family(name: str) -> str | None:
    """Match explicit real names case-insensitively, never generic aliases."""
    return next(
        (family for family in LOCAL_FONT_FAMILIES if family.casefold() == name.strip().casefold()),
        None,
    )
