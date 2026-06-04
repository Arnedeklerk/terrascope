"""The right-side Terranova dock — holds the welcome screen, project explorer,
and the embedded React panel mounted into a :class:`QWebEngineView`.

QtWebEngine has been safe to embed inside QGIS plugins since 3.36 (per the
3.36 visual changelog).  We import it defensively: on Linux distros that ship
QGIS without ``python3-pyqtwebengine``, we degrade to native widgets only.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from qgis.PyQt.QtCore import Qt, QUrl
from qgis.PyQt.QtWidgets import QDockWidget, QLabel, QVBoxLayout, QWidget

from ..bridge import Bridge

if TYPE_CHECKING:  # pragma: no cover
    from qgis.gui import QgisInterface

WEB_DIST = Path(__file__).parent.parent / "ui_web" / "dist"


class TerranovaDock(QDockWidget):
    """Right-side dock — welcome screen + embedded React panel."""

    def __init__(self, iface: "QgisInterface") -> None:
        super().__init__("Terranova")
        self.iface = iface
        self.setObjectName("TerranovaDock")
        self.setAllowedAreas(Qt.DockWidgetArea.AllDockWidgetAreas)
        self.setMinimumWidth(360)

        self.bridge = Bridge()
        self.setWidget(self._build_body())

    # ------------------------------------------------------------------ #
    def _build_body(self) -> QWidget:
        container = QWidget(self)
        layout = QVBoxLayout(container)
        layout.setContentsMargins(0, 0, 0, 0)

        try:
            from qgis.PyQt.QtWebChannel import QWebChannel
            from qgis.PyQt.QtWebEngineWidgets import QWebEngineView
        except ImportError:
            layout.addWidget(self._build_fallback())
            return container

        index_html = WEB_DIST / "index.html"
        if not index_html.exists():
            layout.addWidget(self._build_dev_hint())
            return container

        view = QWebEngineView(container)
        # Loading via file:// triggers Chromium's "local content can't
        # touch the internet" rule by default — fine for our own JS, fatal
        # for Leaflet's OSM tile fetches.  Enable the two settings that
        # let our bundle reach https:// resources.  PyQt6 nests the enum
        # under WebAttribute; PyQt5 has it flat.
        _enable_remote_content(view.settings())
        # Suppress Qt/Chromium's default right-click menu inside the
        # dock — the JS side wants to use right-click as a cancel
        # gesture (e.g. to abort an AOI drag) and the Qt-level menu
        # was blocking the contextmenu event from reaching JS.
        try:
            ctx = Qt.ContextMenuPolicy.NoContextMenu  # PyQt6
        except AttributeError:  # PyQt5
            ctx = Qt.NoContextMenu  # type: ignore[attr-defined]
        view.setContextMenuPolicy(ctx)
        channel = QWebChannel(view.page())
        channel.registerObject("bridge", self.bridge)
        view.page().setWebChannel(channel)
        view.setUrl(QUrl.fromLocalFile(str(index_html.resolve())))
        layout.addWidget(view)
        # Keep a reference so the channel is not garbage-collected.
        self._view = view
        self._channel = channel
        return container

    # ------------------------------------------------------------------ #
    def _build_fallback(self) -> QWidget:
        msg = QLabel(
            "QtWebEngine is not available in this QGIS build.\n\n"
            "Terranova's web panels are disabled, but native dialogs and the\n"
            "Processing algorithms still work.\n\n"
            "On Debian/Ubuntu: sudo apt install python3-pyqtwebengine"
        )
        msg.setWordWrap(True)
        msg.setMargin(16)
        return msg

    def _build_dev_hint(self) -> QWidget:
        msg = QLabel(
            "Terranova web bundle not found.\n\n"
            "Build it with:  make ui-build\n"
            "Or run the dev server:  make ui-dev\n\n"
            f"Expected at:\n{WEB_DIST / 'index.html'}"
        )
        msg.setWordWrap(True)
        msg.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        msg.setMargin(16)
        return msg


def _enable_remote_content(settings: object) -> None:
    """Configure the QWebEngineView's page settings.

    Three concerns folded into one helper because they all hit the same
    QWebEngineSettings object:

    - **Network access from file:// origin.**  Leaflet needs to fetch
      tile PNGs over HTTPS; Chromium blocks that by default for local
      HTML and the user sees a blank grey map.

    - **Hardware-accelerated rendering.**  QtWebEngine in embeds will
      silently fall back to software compositing if these flags aren't
      flipped, which is the single biggest source of "the map isn't
      buttery smooth" pan jank.  Turning on Accelerated2dCanvas and
      WebGL makes Chromium ask for a GPU surface.

    - **Smooth scrolling.**  Enables the touch/wheel easing curve that
      makes pan feel less stuttery on intermediate-speed inputs.

    PyQt5 exposes the enum flat (``QWebEngineSettings.X``); PyQt6 nests
    it under ``WebAttribute``.  We try both and shrug on failure for
    any single attribute — the dock still works in degraded mode.
    """
    try:
        from qgis.PyQt.QtWebEngineCore import QWebEngineSettings  # type: ignore[import-not-found]
    except ImportError:
        try:
            from qgis.PyQt.QtWebEngineWidgets import QWebEngineSettings  # type: ignore[import-not-found,no-redef]
        except ImportError:
            return

    attr_holder = getattr(QWebEngineSettings, "WebAttribute", QWebEngineSettings)
    for name in (
        # Network from file://
        "LocalContentCanAccessRemoteUrls",
        "LocalContentCanAccessFileUrls",
        # GPU compositing for Leaflet's canvas renderer + any future
        # WebGL-backed map widgets we might swap in.
        "Accelerated2dCanvasEnabled",
        "WebGLEnabled",
        # Smoother wheel/touch pan.
        "ScrollAnimatorEnabled",
        "SmoothScrollingEnabled",
    ):
        attr = getattr(attr_holder, name, None)
        if attr is None:
            continue
        try:
            settings.setAttribute(attr, True)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
