"""metadata.txt is parsed by QGIS at plugin install — make sure it is well-formed."""

from __future__ import annotations

import configparser
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
META = REPO_ROOT / "src" / "terranova" / "metadata.txt"

pytestmark = pytest.mark.unit


def test_metadata_parseable() -> None:
    parser = configparser.ConfigParser()
    parser.read(META, encoding="utf-8")
    assert "general" in parser
    g = parser["general"]
    # All keys QGIS requires.
    for key in ("name", "qgisMinimumVersion", "description", "version", "author", "email"):
        assert key in g, f"metadata.txt missing key: {key}"
    # Sanity values.
    assert g["name"] == "Terranova"
    assert g["version"]
    assert "@" in g["email"]


def test_version_matches_version_py() -> None:
    from terranova.version import __version__

    parser = configparser.ConfigParser()
    parser.read(META, encoding="utf-8")
    assert parser["general"]["version"] == __version__, (
        "metadata.txt version is out of sync with src/terranova/version.py.  "
        "Run scripts/sync_version.py --bump <new_version>."
    )


def test_min_qgis_at_least_340() -> None:
    parser = configparser.ConfigParser()
    parser.read(META, encoding="utf-8")
    min_v = parser["general"]["qgisMinimumVersion"]
    parts = [int(x) for x in min_v.split(".")[:2]]
    assert parts >= [3, 40], f"qgisMinimumVersion {min_v} is below the supported floor"
