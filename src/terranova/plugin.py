"""Terranova QGIS plugin lifecycle.

This module is the only thing in the package that imports from ``qgis.*`` and
``PyQt6.*``.  Everything else flows down to the pure-Python ``core`` layer via
controllers and tasks.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from qgis.PyQt.QtCore import Qt
from qgis.PyQt.QtGui import QIcon
from qgis.PyQt.QtWidgets import QAction

from .version import __version__

if TYPE_CHECKING:  # pragma: no cover
    from qgis.gui import QgisInterface

    from .ui.plugin_dock import TerranovaDock

PLUGIN_NAME = "Terranova"
RESOURCES_DIR = Path(__file__).parent / "ui" / "resources"


class TerranovaPlugin:
    """QGIS plugin object — registers the menu action, dock, and Processing provider."""

    def __init__(self, iface: "QgisInterface") -> None:
        self.iface = iface
        self.action: QAction | None = None
        self.action_catalog: QAction | None = None
        self.action_classify: QAction | None = None
        self.action_accuracy: QAction | None = None
        self.action_sam: QAction | None = None
        self.action_foundation: QAction | None = None
        self.action_timeseries: QAction | None = None
        self.action_cdse: QAction | None = None
        self.dock: TerranovaDock | None = None
        self._provider = None  # set in initGui

    # ------------------------------------------------------------------ #
    # QGIS lifecycle                                                     #
    # ------------------------------------------------------------------ #
    def initGui(self) -> None:
        """Called by QGIS when the plugin is enabled."""
        icon = self._icon()

        # Main toolbar button — toggles the dock.
        self.action = QAction(icon, f"{PLUGIN_NAME} — v{__version__}", self.iface.mainWindow())
        self.action.setObjectName("terranova_toggle_dock")
        self.action.setCheckable(True)
        self.action.triggered.connect(self._toggle_dock)
        self.iface.addPluginToRasterMenu(PLUGIN_NAME, self.action)
        self.iface.addToolBarIcon(self.action)

        # Phase-1 workflow menu items (under Raster → Terranova).
        self.action_catalog = QAction(icon, "Catalogue search…", self.iface.mainWindow())
        self.action_catalog.setObjectName("terranova_open_catalog")
        self.action_catalog.triggered.connect(self._open_catalog_search)
        self.iface.addPluginToRasterMenu(PLUGIN_NAME, self.action_catalog)

        self.action_classify = QAction(icon, "Classify scene…", self.iface.mainWindow())
        self.action_classify.setObjectName("terranova_open_classify")
        self.action_classify.triggered.connect(self._open_classify)
        self.iface.addPluginToRasterMenu(PLUGIN_NAME, self.action_classify)

        self.action_accuracy = QAction(icon, "Accuracy report…", self.iface.mainWindow())
        self.action_accuracy.setObjectName("terranova_open_accuracy")
        self.action_accuracy.triggered.connect(self._open_accuracy)
        self.iface.addPluginToRasterMenu(PLUGIN_NAME, self.action_accuracy)

        # (planned).
        self.action_sam = QAction(icon, "Segment with SAM…", self.iface.mainWindow())
        self.action_sam.setObjectName("terranova_open_sam")
        self.action_sam.triggered.connect(self._open_sam)
        self.iface.addPluginToRasterMenu(PLUGIN_NAME, self.action_sam)

        self.action_foundation = QAction(
            icon, "Fine-tune foundation model…", self.iface.mainWindow()
        )
        self.action_foundation.setObjectName("terranova_open_foundation")
        self.action_foundation.triggered.connect(self._open_foundation)
        self.iface.addPluginToRasterMenu(PLUGIN_NAME, self.action_foundation)

        # (planned).
        self.action_timeseries = QAction(
            icon, "Time-series + change detection…", self.iface.mainWindow()
        )
        self.action_timeseries.setObjectName("terranova_open_timeseries")
        self.action_timeseries.triggered.connect(self._open_timeseries)
        self.iface.addPluginToRasterMenu(PLUGIN_NAME, self.action_timeseries)

        # additional handlers.
        self.action_cdse = QAction(icon, "Sign in to CDSE…", self.iface.mainWindow())
        self.action_cdse.setObjectName("terranova_open_cdse")
        self.action_cdse.triggered.connect(self._open_cdse)
        self.iface.addPluginToRasterMenu(PLUGIN_NAME, self.action_cdse)

        self._register_processing_provider()

    def unload(self) -> None:
        """Called by QGIS when the plugin is disabled or QGIS exits."""
        all_actions = (
            self.action_cdse,
            self.action_timeseries,
            self.action_foundation,
            self.action_sam,
            self.action_accuracy,
            self.action_classify,
            self.action_catalog,
            self.action,
        )
        for action in all_actions:
            if action is not None:
                self.iface.removePluginRasterMenu(PLUGIN_NAME, action)
                action.deleteLater()
        if self.action is not None:
            self.iface.removeToolBarIcon(self.action)
        self.action = None
        self.action_catalog = None
        self.action_classify = None
        self.action_accuracy = None
        self.action_sam = None
        self.action_foundation = None
        self.action_timeseries = None
        self.action_cdse = None

        if self.dock is not None:
            self.iface.removeDockWidget(self.dock)
            self.dock.deleteLater()
            self.dock = None

        self._unregister_processing_provider()

    # ------------------------------------------------------------------ #
    # Actions                                                            #
    # ------------------------------------------------------------------ #
    def _toggle_dock(self, checked: bool) -> None:
        if self.dock is None:
            # Deferred import — keeps Qt out of the plugin import path until
            # the user actually opens the dock.
            from .ui.plugin_dock import TerranovaDock

            self.dock = TerranovaDock(self.iface)
            self.iface.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self.dock)

        self.dock.setVisible(checked)

    def _open_catalog_search(self) -> None:
        from .ui.dialogs.catalog_search import CatalogSearchDialog

        dialog = CatalogSearchDialog(self.iface, parent=self.iface.mainWindow())
        dialog.show()
        # Keep a reference so it isn't garbage-collected.
        self._catalog_dialog = dialog

    def _open_classify(self) -> None:
        self._open_dialog("classifier_setup", "ClassifierSetupDialog", "_classify_dialog")

    def _open_accuracy(self) -> None:
        self._open_dialog("accuracy_report", "AccuracyReportDialog", "_accuracy_dialog")

    def _open_sam(self) -> None:
        self._open_dialog("sam_dialog", "SamDialog", "_sam_dialog")

    def _open_foundation(self) -> None:
        self._open_dialog("foundation_dialog", "FoundationDialog", "_foundation_dialog")

    def _open_timeseries(self) -> None:
        self._open_dialog("timeseries_dialog", "TimeSeriesDialog", "_timeseries_dialog")

    def _open_cdse(self) -> None:
        self._open_dialog("cdse_login_dialog", "CdseLoginDialog", "_cdse_dialog")

    def _open_dialog(self, module: str, klass: str, attr: str) -> None:
        try:
            mod = __import__(f"terranova.ui.dialogs.{module}", fromlist=[klass])
            dialog_cls = getattr(mod, klass)
            dialog = dialog_cls(self.iface, parent=self.iface.mainWindow())
            dialog.show()
            setattr(self, attr, dialog)
        except Exception as exc:
            from qgis.core import Qgis, QgsMessageLog

            QgsMessageLog.logMessage(
                f"Failed to open dialog {klass}: {exc!r}",
                "Terranova",
                Qgis.MessageLevel.Critical,
            )

    # ------------------------------------------------------------------ #
    # Internals                                                          #
    # ------------------------------------------------------------------ #
    def _icon(self) -> QIcon:
        path = RESOURCES_DIR / "icon.svg"
        return QIcon(str(path)) if path.exists() else QIcon()

    def _register_processing_provider(self) -> None:
        try:
            from qgis.core import QgsApplication

            from .processing.provider import TerranovaProcessingProvider
        except ImportError:  # pragma: no cover — pyqgis missing in tests
            return

        self._provider = TerranovaProcessingProvider()
        QgsApplication.processingRegistry().addProvider(self._provider)

    def _unregister_processing_provider(self) -> None:
        if self._provider is None:
            return
        try:
            from qgis.core import QgsApplication

            QgsApplication.processingRegistry().removeProvider(self._provider)
        except ImportError:  # pragma: no cover
            pass
        self._provider = None
