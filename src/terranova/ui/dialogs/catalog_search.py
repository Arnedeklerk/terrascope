"""STAC catalogue search dialog.

A native QtWidgets dialog so the search workflow doesn't depend on the React
panel being built.  AOI defaults to the current canvas extent; users can pick
a different vector layer's bounding box.  Searches run in a background
``CatalogSearchTask`` so the dialog stays responsive.

Selecting a row and clicking *Download as COG* materialises the chosen item
to disk via ``odc-stac`` and adds it to the active QGIS project.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from qgis.core import (
    Qgis,
    QgsApplication,
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsMessageLog,
    QgsProject,
    QgsRasterLayer,
    QgsRectangle,
)
from qgis.PyQt.QtWidgets import (
    QButtonGroup,
    QComboBox,
    QDateEdit,
    QDialog,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QRadioButton,
    QSpinBox,
    QStackedWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

if TYPE_CHECKING:  # pragma: no cover
    from qgis.gui import QgisInterface


class CatalogSearchDialog(QDialog):
    """STAC catalogue search dialog (Sentinel-2 L2A across PC / ES / CDSE)."""

    def __init__(self, iface: "QgisInterface", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.iface = iface
        self._task = None
        self._items: list[dict[str, Any]] = []

        self.setWindowTitle("Terranova — Catalogue Search")
        self.resize(820, 560)

        self._build_ui()
        self._populate_aoi_from_canvas()

    # ------------------------------------------------------------------ #
    # UI                                                                 #
    # ------------------------------------------------------------------ #
    def _build_ui(self) -> None:
        root = QVBoxLayout(self)

        # ---- form ---------------------------------------------------- #
        form_widget = QWidget()
        form = QFormLayout(form_widget)
        form.setContentsMargins(0, 0, 0, 0)

        self.endpoint_combo = QComboBox()
        self.endpoint_combo.addItem("Planetary Computer", "planetary_computer")
        self.endpoint_combo.addItem("Earth Search (Element 84)", "earth_search")
        self.endpoint_combo.addItem("Copernicus Data Space", "cdse")
        form.addRow("Endpoint", self.endpoint_combo)

        self.collection_combo = QComboBox()
        self.collection_combo.addItem("Sentinel-2 L2A", "sentinel-2-l2a")
        self.collection_combo.addItem("Landsat C2 L2", "landsat-c2-l2")
        form.addRow("Collection", self.collection_combo)

        form.addRow(QLabel(""), QLabel(""))  # spacer

        # ---- AOI block ---------------------------------------------- #
        # Two corners (NW + SE).  Each is a (lat, lon) pair.  Internally
        # we still serialise as W/S/E/N — see _bbox().  Format switcher
        # toggles between decimal degrees and DMS strings.
        self.north_spin = self._make_lat_spin()
        self.west_spin = self._make_lon_spin()
        self.south_spin = self._make_lat_spin()
        self.east_spin = self._make_lon_spin()

        self.north_dms = QLineEdit()
        self.west_dms = QLineEdit()
        self.south_dms = QLineEdit()
        self.east_dms = QLineEdit()
        for w, ph in (
            (self.north_dms, "e.g. 51° 30' 26\" N"),
            (self.west_dms, "e.g. 0° 7' 39\" W"),
            (self.south_dms, "e.g. 51° 28' 26\" N"),
            (self.east_dms, "e.g. 0° 4' 31\" E"),
        ):
            w.setPlaceholderText(ph)

        # Format toggle (DD / DMS) + a stacked widget per corner.
        self.fmt_dd = QRadioButton("Decimal degrees")
        self.fmt_dd.setChecked(True)
        self.fmt_dms = QRadioButton("DMS")
        self._fmt_group = QButtonGroup(self)
        self._fmt_group.addButton(self.fmt_dd)
        self._fmt_group.addButton(self.fmt_dms)
        self.fmt_dd.toggled.connect(self._on_format_toggled)

        fmt_row = QHBoxLayout()
        fmt_row.addWidget(QLabel("Coordinate format:"))
        fmt_row.addWidget(self.fmt_dd)
        fmt_row.addWidget(self.fmt_dms)
        fmt_row.addStretch()
        self.btn_aoi_canvas = QPushButton("Use canvas extent")
        self.btn_aoi_canvas.clicked.connect(self._populate_aoi_from_canvas)
        fmt_row.addWidget(self.btn_aoi_canvas)

        fmt_widget = QWidget()
        fmt_widget.setLayout(fmt_row)
        form.addRow("AOI (WGS84)", fmt_widget)

        # Two-corner grid layout.
        grid = QGridLayout()
        grid.setContentsMargins(0, 4, 0, 4)
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(4)

        self.nw_stack = QStackedWidget()
        nw_dd = QWidget()
        nw_dd_lay = QHBoxLayout(nw_dd)
        nw_dd_lay.setContentsMargins(0, 0, 0, 0)
        nw_dd_lay.addWidget(QLabel("Lat"))
        nw_dd_lay.addWidget(self.north_spin)
        nw_dd_lay.addWidget(QLabel("Lon"))
        nw_dd_lay.addWidget(self.west_spin)
        self.nw_stack.addWidget(nw_dd)
        nw_dms = QWidget()
        nw_dms_lay = QHBoxLayout(nw_dms)
        nw_dms_lay.setContentsMargins(0, 0, 0, 0)
        nw_dms_lay.addWidget(QLabel("Lat"))
        nw_dms_lay.addWidget(self.north_dms)
        nw_dms_lay.addWidget(QLabel("Lon"))
        nw_dms_lay.addWidget(self.west_dms)
        self.nw_stack.addWidget(nw_dms)

        self.se_stack = QStackedWidget()
        se_dd = QWidget()
        se_dd_lay = QHBoxLayout(se_dd)
        se_dd_lay.setContentsMargins(0, 0, 0, 0)
        se_dd_lay.addWidget(QLabel("Lat"))
        se_dd_lay.addWidget(self.south_spin)
        se_dd_lay.addWidget(QLabel("Lon"))
        se_dd_lay.addWidget(self.east_spin)
        self.se_stack.addWidget(se_dd)
        se_dms = QWidget()
        se_dms_lay = QHBoxLayout(se_dms)
        se_dms_lay.setContentsMargins(0, 0, 0, 0)
        se_dms_lay.addWidget(QLabel("Lat"))
        se_dms_lay.addWidget(self.south_dms)
        se_dms_lay.addWidget(QLabel("Lon"))
        se_dms_lay.addWidget(self.east_dms)
        self.se_stack.addWidget(se_dms)

        grid.addWidget(QLabel("Top-left (NW)"), 0, 0)
        grid.addWidget(self.nw_stack, 0, 1)
        grid.addWidget(QLabel("Bottom-right (SE)"), 1, 0)
        grid.addWidget(self.se_stack, 1, 1)

        corners_widget = QWidget()
        corners_widget.setLayout(grid)
        form.addRow("", corners_widget)

        today = datetime.utcnow().date()
        self.start_date = QDateEdit()
        self.start_date.setCalendarPopup(True)
        self.start_date.setDate(_qdate(today - timedelta(days=120)))
        form.addRow("Start date", self.start_date)

        self.end_date = QDateEdit()
        self.end_date.setCalendarPopup(True)
        self.end_date.setDate(_qdate(today))
        form.addRow("End date", self.end_date)

        self.max_cloud = QSpinBox()
        self.max_cloud.setRange(0, 100)
        self.max_cloud.setValue(20)
        self.max_cloud.setSuffix(" %")
        form.addRow("Max cloud cover", self.max_cloud)

        self.limit = QSpinBox()
        self.limit.setRange(1, 500)
        self.limit.setValue(25)
        form.addRow("Limit", self.limit)

        root.addWidget(form_widget)

        # ---- search button + progress ------------------------------- #
        action_row = QHBoxLayout()
        self.btn_search = QPushButton("Search")
        self.btn_search.setDefault(True)
        self.btn_search.clicked.connect(self._on_search)
        action_row.addWidget(self.btn_search)

        self.progress = QProgressBar()
        self.progress.setRange(0, 0)  # busy indicator
        self.progress.setVisible(False)
        action_row.addWidget(self.progress, stretch=1)
        root.addLayout(action_row)

        # ---- results table ------------------------------------------ #
        self.results = QTableWidget(0, 4)
        self.results.setHorizontalHeaderLabels(["ID", "Datetime", "Cloud (%)", "Platform"])
        self.results.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.results.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.results.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        root.addWidget(self.results, stretch=1)

        # ---- footer buttons ----------------------------------------- #
        footer = QHBoxLayout()
        self.btn_download = QPushButton("Download selected as COG…")
        self.btn_download.setEnabled(False)
        self.btn_download.clicked.connect(self._on_download)
        footer.addWidget(self.btn_download)
        footer.addStretch()
        btn_close = QPushButton("Close")
        btn_close.clicked.connect(self.reject)
        footer.addWidget(btn_close)
        root.addLayout(footer)

        self.results.itemSelectionChanged.connect(self._on_selection_changed)

    # ------------------------------------------------------------------ #
    # AOI helpers                                                        #
    # ------------------------------------------------------------------ #
    def _make_lat_spin(self) -> QDoubleSpinBox:
        sb = QDoubleSpinBox()
        sb.setRange(-90, 90)
        sb.setDecimals(6)
        sb.setSingleStep(0.01)
        return sb

    def _make_lon_spin(self) -> QDoubleSpinBox:
        sb = QDoubleSpinBox()
        sb.setRange(-180, 180)
        sb.setDecimals(6)
        sb.setSingleStep(0.01)
        return sb

    def _on_format_toggled(self, dd_selected: bool) -> None:
        # Sync values across the active inputs when the user switches format.
        if dd_selected:
            # Coming from DMS → DD: parse the line edits into the spin boxes.
            try:
                n = _parse_dms(self.north_dms.text() or "0")
                w = _parse_dms(self.west_dms.text() or "0")
                s = _parse_dms(self.south_dms.text() or "0")
                e = _parse_dms(self.east_dms.text() or "0")
                self.north_spin.setValue(n)
                self.west_spin.setValue(w)
                self.south_spin.setValue(s)
                self.east_spin.setValue(e)
            except ValueError:
                pass  # leave the DD values as-is if DMS is unparseable
            self.nw_stack.setCurrentIndex(0)
            self.se_stack.setCurrentIndex(0)
        else:
            # Going to DMS: format the current DD values as DMS strings.
            self.north_dms.setText(_format_dms(self.north_spin.value(), is_lat=True))
            self.west_dms.setText(_format_dms(self.west_spin.value(), is_lat=False))
            self.south_dms.setText(_format_dms(self.south_spin.value(), is_lat=True))
            self.east_dms.setText(_format_dms(self.east_spin.value(), is_lat=False))
            self.nw_stack.setCurrentIndex(1)
            self.se_stack.setCurrentIndex(1)

    def _populate_aoi_from_canvas(self) -> None:
        canvas = self.iface.mapCanvas()
        extent = canvas.extent()
        src_crs = canvas.mapSettings().destinationCrs()
        # OGC:CRS84 forces lon,lat axis order — EPSG:4326 in QGIS 4 / PROJ 9
        # has lat,lon order and the resulting QgsRectangle stores latitudes
        # in x, which is what caused the 'lat right, lon wrong' symptom.
        wgs84 = QgsCoordinateReferenceSystem("OGC:CRS84")
        if not wgs84.isValid():
            wgs84 = QgsCoordinateReferenceSystem("EPSG:4326")
        raw = (
            extent.xMinimum(),
            extent.yMinimum(),
            extent.xMaximum(),
            extent.yMaximum(),
        )
        src_label = src_crs.authid() or src_crs.description() or "<unknown>"
        try:
            if not src_crs.isValid():
                raise ValueError("canvas has no valid CRS")
            xform = QgsCoordinateTransform(src_crs, wgs84, QgsProject.instance())
            try:
                wgs_extent = xform.transformBoundingBox(
                    extent, handle180Crossover=True
                )
            except TypeError:
                wgs_extent = xform.transformBoundingBox(extent)
            QgsMessageLog.logMessage(
                f"canvas extent: src_crs={src_label} raw={raw} "
                f"-> wgs84=("
                f"{wgs_extent.xMinimum():.6f}, {wgs_extent.yMinimum():.6f}, "
                f"{wgs_extent.xMaximum():.6f}, {wgs_extent.yMaximum():.6f})",
                "Terranova",
                Qgis.MessageLevel.Info,
            )
            if wgs_extent.xMinimum() >= wgs_extent.xMaximum():
                raise ValueError(
                    "canvas extent crosses the antimeridian; "
                    "STAC bboxes can't span ±180°"
                )
        except Exception as exc:  # noqa: BLE001
            QgsMessageLog.logMessage(
                f"Couldn't transform canvas extent to WGS84: {exc!r}",
                "Terranova",
                Qgis.MessageLevel.Warning,
            )
            QMessageBox.warning(
                self,
                "Canvas extent unavailable",
                "Could not project the canvas extent to WGS84.  Set a project "
                "CRS (Project → Properties → CRS) and try again, or type the "
                "coordinates manually.",
            )
            return

        west = wgs_extent.xMinimum()
        south = wgs_extent.yMinimum()
        east = wgs_extent.xMaximum()
        north = wgs_extent.yMaximum()

        # Sanity: if a project lacks a CRS we can get degenerate or out-of-range
        # extents.  Refuse to populate garbage values.
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            QMessageBox.warning(
                self,
                "Canvas extent looks wrong",
                f"Got west={west:.3f}, south={south:.3f}, east={east:.3f}, "
                f"north={north:.3f} which isn't a valid WGS84 bbox.  Make sure "
                "the project has a CRS set and you're zoomed to a real AOI.",
            )
            return

        self.north_spin.setValue(north)
        self.west_spin.setValue(west)
        self.south_spin.setValue(south)
        self.east_spin.setValue(east)
        if self.fmt_dms.isChecked():
            # Refresh the DMS strings to match.
            self._on_format_toggled(False)

    def _bbox(self) -> tuple[float, float, float, float]:
        """Return (west, south, east, north), reading whichever format is active."""
        if self.fmt_dd.isChecked():
            return (
                self.west_spin.value(),
                self.south_spin.value(),
                self.east_spin.value(),
                self.north_spin.value(),
            )
        # DMS mode — parse the line edits.
        return (
            _parse_dms(self.west_dms.text()),
            _parse_dms(self.south_dms.text()),
            _parse_dms(self.east_dms.text()),
            _parse_dms(self.north_dms.text()),
        )

    def _datetime_string(self) -> str:
        s = self.start_date.date().toString("yyyy-MM-dd")
        e = self.end_date.date().toString("yyyy-MM-dd")
        return f"{s}/{e}"

    # ------------------------------------------------------------------ #
    # Search                                                             #
    # ------------------------------------------------------------------ #
    def _on_search(self) -> None:
        try:
            self._validate_inputs()
        except ValueError as e:
            QMessageBox.warning(self, "Invalid input", str(e))
            return

        self.results.setRowCount(0)
        self.btn_download.setEnabled(False)
        self.btn_search.setEnabled(False)
        self.progress.setVisible(True)

        # Import here so the dialog module loads cheaply.
        from ...core.models import BBox, CatalogSearch, DateRange, STACEndpoint
        from ...tasks.catalog_task import CatalogSearchJob, CatalogSearchTask

        west, south, east, north = self._bbox()
        cfg = CatalogSearch(
            endpoint=STACEndpoint(self.endpoint_combo.currentData()),
            collection=self.collection_combo.currentData(),
            bbox=BBox(west=west, south=south, east=east, north=north),
            datetime=DateRange(
                start=datetime.combine(self.start_date.date().toPyDate(), datetime.min.time()),
                end=datetime.combine(self.end_date.date().toPyDate(), datetime.max.time()),
            ),
            max_cloud=self.max_cloud.value(),
            limit=self.limit.value(),
        )
        self._task = CatalogSearchTask(CatalogSearchJob(cfg=cfg, on_results=self._on_results))
        self._task.taskTerminated.connect(self._on_task_done)
        self._task.taskCompleted.connect(self._on_task_done)
        QgsApplication.taskManager().addTask(self._task)

    def _validate_inputs(self) -> None:
        try:
            w, s, e, n = self._bbox()
        except ValueError as exc:
            raise ValueError(f"Could not parse the coordinates: {exc}") from exc
        if not (-180 <= w <= 180 and -180 <= e <= 180):
            raise ValueError("Longitudes must be in [-180, 180].")
        if not (-90 <= s <= 90 and -90 <= n <= 90):
            raise ValueError("Latitudes must be in [-90, 90].")
        if e <= w:
            raise ValueError(
                "East (bottom-right longitude) must be greater than West "
                "(top-left longitude)."
            )
        if n <= s:
            raise ValueError(
                "North (top-left latitude) must be greater than South "
                "(bottom-right latitude)."
            )
        if self.end_date.date() < self.start_date.date():
            raise ValueError("End date must be on or after start date.")

    def _on_results(self, items: list[dict[str, Any]]) -> None:
        # Called on the main thread by QgsTask.finished.
        self._items = items
        self.results.setRowCount(len(items))
        for row, item in enumerate(items):
            self._set(row, 0, item.get("id", ""))
            self._set(row, 1, item.get("datetime", ""))
            cloud = item.get("cloud")
            self._set(row, 2, f"{cloud:.1f}" if isinstance(cloud, int | float) else "")
            self._set(row, 3, item.get("platform", "") or "")

    def _on_task_done(self) -> None:
        self.progress.setVisible(False)
        self.btn_search.setEnabled(True)
        if self.results.rowCount() == 0:
            self.iface.messageBar().pushInfo(
                "Terranova", "No items matched the search criteria."
            )

    def _set(self, row: int, col: int, value: str) -> None:
        self.results.setItem(row, col, QTableWidgetItem(str(value)))

    def _on_selection_changed(self) -> None:
        self.btn_download.setEnabled(len(self.results.selectedItems()) > 0)

    # ------------------------------------------------------------------ #
    # Download                                                           #
    # ------------------------------------------------------------------ #
    def _on_download(self) -> None:
        selected = self.results.selectedItems()
        if not selected:
            return
        row = selected[0].row()
        if row >= len(self._items):
            return
        item = self._items[row]
        default_name = f"{item.get('id', 'scene')}_rgbnir.tif"

        out_path, _ = QFileDialog.getSaveFileName(
            self,
            "Save as COG",
            str(Path.home() / default_name),
            "Cloud-Optimised GeoTIFF (*.tif)",
        )
        if not out_path:
            return

        # Route through the controller so the work runs on a QgsTask — keeps
        # the dialog responsive on slow connections.  Status surfaces in
        # the QGIS Log Messages → Terranova tab plus a small status label.
        from ...controllers import catalog as catalog_controller

        west, south, east, north = self._bbox()
        try:
            catalog_controller.download(
                {
                    "endpoint": self.endpoint_combo.currentData(),
                    "collection": self.collection_combo.currentData(),
                    "item_id": item["id"],
                    "bbox": {
                        "west": west,
                        "south": south,
                        "east": east,
                        "north": north,
                    },
                    "out_path": out_path,
                }
            )
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(
                self, "Download failed to start", f"{type(exc).__name__}: {exc}"
            )
            return
        self.iface.messageBar().pushInfo(
            "Terranova",
            f"Downloading {item['id']} in the background — "
            "see Log Messages → Terranova for progress.",
        )


# --------------------------------------------------------------------------- #
def _qdate(date) -> Any:  # type: ignore[no-untyped-def]
    """Build a QDate from a python date object (kept out of the type-check noise)."""
    from qgis.PyQt.QtCore import QDate

    return QDate(date.year, date.month, date.day)


# --------------------------------------------------------------------------- #
# DMS <-> decimal-degrees                                                     #
# --------------------------------------------------------------------------- #
import re as _re


def _parse_dms(text: str) -> float:
    """Parse a coordinate string in DMS, DDM, or DD into a decimal-degrees float.

    Accepted shapes (very forgiving):
        ``51 30 26 N``      → 51.50722
        ``51° 30' 26" N``   → 51.50722
        ``51.5 N``          → 51.5
        ``-51 30 26``       → -51.50722
        ``51 30.5 N``       → 51.508333 (DDM)
        ``51.50722``        → 51.50722  (already decimal)
    """
    if text is None:
        raise ValueError("empty coordinate")
    s = text.strip()
    if not s:
        raise ValueError("empty coordinate")

    # Normalise unicode minus / quotes; strip degree / minute / second markers.
    s = s.replace("−", "-").replace("°", " ").replace("º", " ")
    s = s.replace("'", " ").replace("′", " ").replace("′", " ")
    s = s.replace('"', " ").replace("″", " ").replace("″", " ")
    s = s.replace(",", ".")

    # Detect and strip the trailing N/S/E/W hemisphere indicator.
    hemi = 1
    m = _re.search(r"([NSEW])\s*$", s, flags=_re.IGNORECASE)
    if m:
        if m.group(1).upper() in ("S", "W"):
            hemi = -1
        s = s[: m.start()].strip()

    # Now we expect 1, 2, or 3 numbers (deg, min, sec).
    parts = [p for p in _re.split(r"\s+", s) if p]
    if not parts:
        raise ValueError(f"no numbers in {text!r}")
    try:
        nums = [float(p) for p in parts]
    except ValueError as exc:
        raise ValueError(f"can't parse {text!r}: {exc}") from exc

    if len(nums) == 1:
        deg = nums[0]
    elif len(nums) == 2:
        deg = abs(nums[0]) + nums[1] / 60.0
        if nums[0] < 0:
            deg = -deg
    elif len(nums) == 3:
        deg = abs(nums[0]) + nums[1] / 60.0 + nums[2] / 3600.0
        if nums[0] < 0:
            deg = -deg
    else:
        raise ValueError(f"too many parts in {text!r}: {nums}")
    return hemi * deg


def _format_dms(value: float, *, is_lat: bool) -> str:
    """Format a decimal-degrees float as a sexagesimal string with hemisphere."""
    if value >= 0:
        hemi = "N" if is_lat else "E"
    else:
        hemi = "S" if is_lat else "W"
    absv = abs(value)
    deg = int(absv)
    minutes_full = (absv - deg) * 60.0
    minutes = int(minutes_full)
    seconds = (minutes_full - minutes) * 60.0
    return f"{deg}° {minutes:02d}' {seconds:05.2f}\" {hemi}"
