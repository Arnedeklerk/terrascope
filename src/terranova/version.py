"""Single source of truth for the package version.

``metadata.txt`` and ``pyproject.toml`` are kept in sync with this value by
``scripts/sync_version.py`` (run by the release workflow).
"""

from __future__ import annotations

__version__ = "1.0.1"
