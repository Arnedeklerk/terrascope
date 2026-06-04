#!/usr/bin/env python3
"""Sync version strings across metadata.txt, pyproject.toml, and version.py.

Source of truth: ``src/terranova/version.py``.

Usage:
    python scripts/sync_version.py             # check (exits 1 on mismatch)
    python scripts/sync_version.py --bump x.y.z   # rewrite all three files
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_PY = ROOT / "src" / "terranova" / "version.py"
METADATA = ROOT / "src" / "terranova" / "metadata.txt"
PYPROJECT = ROOT / "pyproject.toml"

_VERSION_RE = re.compile(r'__version__\s*=\s*"([^"]+)"')


def read_version_py() -> str:
    text = VERSION_PY.read_text(encoding="utf-8")
    match = _VERSION_RE.search(text)
    if not match:
        raise RuntimeError(f"no __version__ found in {VERSION_PY}")
    return match.group(1)


def read_metadata() -> str:
    for line in METADATA.read_text(encoding="utf-8").splitlines():
        if line.startswith("version="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("no version= in metadata.txt")


def read_pyproject() -> str:
    for line in PYPROJECT.read_text(encoding="utf-8").splitlines():
        if line.startswith("version = "):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("no version line in pyproject.toml")


def check() -> int:
    truth = read_version_py()
    meta = read_metadata()
    pp = read_pyproject()
    mismatches = []
    if meta != truth:
        mismatches.append(f"metadata.txt = {meta}")
    if pp != truth:
        mismatches.append(f"pyproject.toml = {pp}")
    if mismatches:
        print(f"Version mismatch — source-of-truth is version.py ({truth}).")
        for m in mismatches:
            print(f"  - {m}")
        return 1
    print(f"All in sync at {truth}")
    return 0


def bump(new: str) -> int:
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[a-z0-9.+-]+)?", new):
        raise SystemExit(f"not a semver-ish version: {new!r}")

    VERSION_PY.write_text(
        _VERSION_RE.sub(f'__version__ = "{new}"', VERSION_PY.read_text(encoding="utf-8")),
        encoding="utf-8",
    )

    metadata_text = METADATA.read_text(encoding="utf-8")
    metadata_text = re.sub(r"^version=.*$", f"version={new}", metadata_text, flags=re.MULTILINE)
    METADATA.write_text(metadata_text, encoding="utf-8")

    pyproject_text = PYPROJECT.read_text(encoding="utf-8")
    pyproject_text = re.sub(
        r'^version = ".*"$', f'version = "{new}"', pyproject_text, flags=re.MULTILINE
    )
    PYPROJECT.write_text(pyproject_text, encoding="utf-8")

    print(f"Bumped to {new}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bump", help="Set all three files to this version.")
    args = p.parse_args()
    if args.bump:
        return bump(args.bump)
    return check()


if __name__ == "__main__":
    sys.exit(main())
