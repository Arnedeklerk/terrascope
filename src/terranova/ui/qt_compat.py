"""PyQt5 / PyQt6 enum-access compatibility.

QGIS 4 ships PyQt6, which nests enum members under their enum type
(e.g. ``Qt.DockWidgetArea.RightDockWidgetArea``,
``QHeaderView.ResizeMode.Stretch``).  QGIS 3.x ships PyQt5, where the
same members are flat on the owning class (``Qt.RightDockWidgetArea``,
``QHeaderView.Stretch``).

:func:`enum_member` tries the PyQt6-nested form first and falls back to
the flat PyQt5 form, so a single call site works on both bindings —
letting the plugin run on QGIS 3.x as well as 4.x.
"""

from __future__ import annotations

from typing import Any


def enum_member(owner: Any, enum_type: str, member: str) -> Any:
    """Resolve ``owner.<enum_type>.<member>`` (PyQt6) or ``owner.<member>`` (PyQt5).

    ``owner`` is the class the enum belongs to (``Qt``, ``QHeaderView``,
    ``QTableWidget``, …).  On PyQt5 the nested enum *type* often still
    exists but doesn't carry the member, so we detect that and fall back
    to the flat attribute on ``owner``.
    """
    holder = getattr(owner, enum_type, None)
    if holder is not None:
        val = getattr(holder, member, None)
        if val is not None:
            return val
    return getattr(owner, member)
