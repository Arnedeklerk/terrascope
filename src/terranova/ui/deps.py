"""Dependency preflight + one-click installer — QGIS 3.x only.

On QGIS 4.x this UI never appears.  4.x ships a Python where the
plugin's dependencies install cleanly, so we keep that path simple and
out of the way: if something is ever genuinely missing there, the user
gets a short message pointing at the standard ``pip install`` line.

On the 3.40 LTR series the bundled interpreter is older and users hit
version-skew — most painfully the pydantic / pydantic_core mismatch that
raises ``ImportError: cannot import name 'validate_core_schema' from
'pydantic_core'`` the moment the dock tries to load.  Rather than show a
raw traceback, we detect the broken / missing packages and offer to
pip-install a pinned, mutually compatible set into QGIS's own Python.

This module must stay importable with *no* third-party dependency (only
stdlib + ``qgis.PyQt``) — it is the thing we fall back to *because* a
third-party import failed.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
import sysconfig
from dataclasses import dataclass
from typing import TYPE_CHECKING

from qgis.PyQt.QtCore import QProcess
from qgis.PyQt.QtGui import QFont, QTextCursor
from qgis.PyQt.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
)

from .qt_compat import enum_member

if TYPE_CHECKING:  # pragma: no cover
    from qgis.PyQt.QtWidgets import QWidget

# import-name -> pip requirement.  Pinned only where version-skew is a
# real, observed risk (pydantic); the rest float on a sane lower bound so
# we don't fight QGIS's own constraints.
CORE_REQUIREMENTS: dict[str, str] = {
    "pydantic": "pydantic>=2.7,<3",
    "pystac_client": "pystac-client>=0.7",
    "odc.stac": "odc-stac>=0.3",
    "rasterio": "rasterio>=1.3",
    "rioxarray": "rioxarray>=0.15",
    "sklearn": "scikit-learn>=1.3",
    "reportlab": "reportlab>=4.0",
    "openpyxl": "openpyxl>=3.1",
}


@dataclass
class DepStatus:
    """Outcome of probing one dependency."""

    import_name: str
    requirement: str
    ok: bool
    error: str = ""


# --------------------------------------------------------------------- #
# Detection
# --------------------------------------------------------------------- #
def is_qgis_3() -> bool:
    """True on the QGIS 3.x (PyQt5) series, where the installer is offered."""
    try:
        from qgis.core import Qgis

        return int(Qgis.QGIS_VERSION_INT) < 40000
    except Exception:  # noqa: BLE001 — never let detection itself raise
        return False


def _probe(import_name: str) -> None:
    """Raise if *import_name* is missing or broken.

    pydantic is *fully imported* because the pydantic_core skew only
    surfaces when its ``__init__`` runs; for the heavier packages a spec
    lookup is enough to confirm presence without paying the import cost.
    """
    if import_name == "pydantic":
        importlib.import_module("pydantic")
        return
    try:
        spec = importlib.util.find_spec(import_name)
    except (ImportError, ModuleNotFoundError, ValueError):
        spec = None
    if spec is None:
        raise ModuleNotFoundError(import_name)


def check(requirements: dict[str, str] | None = None) -> list[DepStatus]:
    """Probe every requirement and report per-package status."""
    reqs = requirements or CORE_REQUIREMENTS
    out: list[DepStatus] = []
    for import_name, req in reqs.items():
        try:
            _probe(import_name)
            out.append(DepStatus(import_name, req, True))
        except Exception as exc:  # noqa: BLE001 — report, don't crash
            out.append(DepStatus(import_name, req, False, f"{type(exc).__name__}: {exc}"))
    return out


def missing(requirements: dict[str, str] | None = None) -> list[DepStatus]:
    """The subset of :func:`check` that is missing or broken."""
    return [s for s in check(requirements) if not s.ok]


# --------------------------------------------------------------------- #
# pip command planning
# --------------------------------------------------------------------- #
def python_executable() -> str:
    """Best-effort path to the interpreter that owns this QGIS Python.

    Inside the running QGIS GUI, ``sys.executable`` is the QGIS binary
    (e.g. ``qgis-bin.exe`` on Windows), *not* python — so naively running
    ``[sys.executable, "-m", "pip"]`` would fail.  We prefer a real
    ``python`` resolved from ``sys.prefix`` / ``sysconfig`` and only fall
    back to ``sys.executable`` as a last resort.
    """
    exe = sys.executable or ""
    if exe and "python" in os.path.basename(exe).lower() and os.path.exists(exe):
        return exe

    base = getattr(sys, "_base_executable", "") or ""
    if base and "python" in os.path.basename(base).lower() and os.path.exists(base):
        return base

    bindir = sysconfig.get_config_var("BINDIR") or ""
    candidates: list[str] = []
    if os.name == "nt":
        candidates += [
            os.path.join(sys.prefix, "python.exe"),
            os.path.join(bindir, "python.exe") if bindir else "",
            os.path.join(sys.prefix, "Scripts", "python.exe"),
        ]
    else:
        unix_bin = bindir or os.path.join(sys.prefix, "bin")
        candidates += [
            os.path.join(unix_bin, "python3"),
            os.path.join(unix_bin, "python"),
            os.path.join(sys.prefix, "bin", "python3"),
            os.path.join(sys.prefix, "bin", "python"),
        ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return exe or "python"


def _pip_args(specs: list[str], *, force: bool) -> list[str]:
    args = [python_executable(), "-m", "pip", "install", "--upgrade", "--no-input"]
    if force:
        # --force-reinstall + --no-cache-dir drags pydantic_core back into
        # lockstep with pydantic, fixing the validate_core_schema skew.
        args += ["--force-reinstall", "--no-cache-dir"]
    return args + specs


def plan(broken: list[DepStatus]) -> list[list[str]]:
    """Sequence of pip invocations that repairs *broken*.

    pydantic gets its own forced reinstall first (so its matching
    pydantic_core comes along); everything else is a plain upgrade in one
    shot to avoid needlessly re-downloading big binary wheels.
    """
    names = {s.import_name for s in broken}
    cmds: list[list[str]] = []
    if "pydantic" in names:
        cmds.append(_pip_args([CORE_REQUIREMENTS["pydantic"]], force=True))
    rest = [s.requirement for s in broken if s.import_name != "pydantic"]
    if rest:
        cmds.append(_pip_args(rest, force=False))
    return cmds


def manual_command(broken: list[DepStatus]) -> str:
    """A copy-pasteable equivalent of :func:`plan`, for the message box / log."""
    lines = []
    names = {s.import_name for s in broken}
    if "pydantic" in names:
        lines.append('pip install --upgrade --force-reinstall "pydantic>=2.7,<3"')
    rest = [s.requirement for s in broken if s.import_name != "pydantic"]
    if rest:
        lines.append("pip install --upgrade " + " ".join(f'"{r}"' for r in rest))
    return "\n".join(lines) if lines else "pip install --upgrade --force-reinstall pydantic"


# --------------------------------------------------------------------- #
# Installer dialog (3.x only)
# --------------------------------------------------------------------- #
class DependencyInstallerDialog(QDialog):
    """One-click 'install / repair' for the plugin's Python dependencies.

    Runs each pip command via :class:`QProcess` so the UI stays responsive
    and output streams live into the log.  Only ever shown on QGIS 3.x.
    """

    def __init__(self, broken: list[DepStatus], parent: "QWidget | None" = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Terranova — set up Python packages")
        self.setMinimumSize(600, 440)
        self._broken = broken
        self._commands = plan(broken)
        self._queue: list[list[str]] = []
        self._proc: QProcess | None = None
        self._build_ui()

    # -- UI -------------------------------------------------------------- #
    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)

        names = ", ".join(s.import_name for s in self._broken) or "—"
        intro = QLabel(
            "<b>Terranova needs a few Python packages</b><br><br>"
            "These aren't bundled with QGIS and look missing or out of date in "
            "this QGIS Python environment:<br><br>"
            f"<tt>{names}</tt><br><br>"
            "Click <b>Install / repair</b> to fetch compatible versions with pip. "
            "When it finishes, <b>restart QGIS</b> and reopen Terranova."
        )
        intro.setWordWrap(True)
        layout.addWidget(intro)

        self._log = QPlainTextEdit(self)
        self._log.setReadOnly(True)
        self._log.setFont(QFont("monospace"))
        self._log.setPlaceholderText(
            "pip output will appear here.\n\nManual equivalent (OSGeo4W Shell):\n"
            + manual_command(self._broken)
        )
        layout.addWidget(self._log, stretch=1)

        buttons = QHBoxLayout()
        buttons.addStretch(1)
        self._btn_install = QPushButton("Install / repair", self)
        self._btn_install.clicked.connect(self._start)
        self._btn_close = QPushButton("Cancel", self)
        self._btn_close.clicked.connect(self.reject)
        buttons.addWidget(self._btn_install)
        buttons.addWidget(self._btn_close)
        layout.addLayout(buttons)

    # -- helpers --------------------------------------------------------- #
    def _append(self, text: str) -> None:
        cursor = self._log.textCursor()
        cursor.movePosition(enum_member(QTextCursor, "MoveOperation", "End"))
        self._log.setTextCursor(cursor)
        self._log.insertPlainText(text)
        sb = self._log.verticalScrollBar()
        sb.setValue(sb.maximum())

    # -- run sequence ---------------------------------------------------- #
    def _start(self) -> None:
        if not self._commands:
            self._append("Nothing to install.\n")
            return
        self._btn_install.setEnabled(False)
        self._queue = list(self._commands)
        self._run_next()

    def _run_next(self) -> None:
        if not self._queue:
            self._append("\n✓ Done. Please restart QGIS, then reopen Terranova.\n")
            self._btn_close.setText("Close")
            return
        cmd = self._queue.pop(0)
        self._append("\n$ " + " ".join(cmd) + "\n")
        proc = QProcess(self)
        proc.setProcessChannelMode(enum_member(QProcess, "ProcessChannelMode", "MergedChannels"))
        proc.readyRead.connect(self._read)
        proc.finished.connect(self._finished)
        self._proc = proc
        proc.start(cmd[0], cmd[1:])

    def _read(self) -> None:
        if self._proc is None:
            return
        data = bytes(self._proc.readAll()).decode("utf-8", "replace")
        if data:
            self._append(data)

    def _finished(self, code: int, _status: object = None) -> None:
        if code != 0:
            self._append(
                f"\n✗ pip exited with code {code}. "
                "You can copy the command above and run it in the OSGeo4W Shell.\n"
            )
            self._btn_install.setEnabled(True)
            return
        self._run_next()
