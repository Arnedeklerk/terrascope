"""Controller for canvas-related bridge actions.

Exposes:

- ``canvas.bbox`` — read the QGIS map canvas's current extent,
  project it to WGS84, and return ``[west, south, east, north]``.
  Used by the Catalogue Search panel's "Use canvas extent" button.

- ``catalog.preview_footprint`` — drop a temporary outlined polygon on
  the canvas showing where a selected STAC item lives, so users don't
  blindly download a scene whose actual coverage is a thin sliver of
  their AOI.  Replaces the previous preview, doesn't pollute the layer
  panel with stale shapes.

- ``catalog.clear_preview`` — remove the preview overlay.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    pass

# Module-level handles to the currently-displayed overlay layers.  Keeping
# IDs at module scope (rather than per-bridge) means we always replace
# stale layers instead of accumulating them in the layer panel as users
# click through different items / re-pick AOIs.
_preview_layer_id: str | None = None  # scene footprint, cyan
_aoi_layer_id: str | None = None      # user AOI, orange dashed


def bbox(_payload: dict[str, Any]) -> dict[str, Any]:
    """Return the canvas extent in WGS84 as ``{"bbox": [west, south, east, north]}``.

    Behaviour notes the UI's "Use canvas extent" button inherits:

    - The bbox is the *full* canvas viewport, including any padding the
      window's aspect ratio forces.  If your QGIS window is wide-screen
      the bbox extends further left/right than the layer you're looking
      at — that's correct, not a bug.
    - ``transformBoundingBox`` samples the source rectangle's edges
      before projecting, so warped projections (Lambert, polar Web
      Mercator) give a sensible bbox rather than just the four corners.
    - Antimeridian-crossing extents (around longitude 180°) are detected
      and reported as an error rather than returned as nonsense.
    - The source CRS, raw extent, and projected bbox are logged on every
      call (Terranova tab) so 'why is the AOI box different from what
      I see?' is one log line away from an answer.
    """
    from qgis.core import (
        Qgis,
        QgsCoordinateReferenceSystem,
        QgsCoordinateTransform,
        QgsMessageLog,
        QgsProject,
    )
    from qgis.utils import iface

    if iface is None:
        raise RuntimeError(
            "QGIS iface is not available — canvas.bbox can only be called "
            "from inside QGIS."
        )

    canvas = iface.mapCanvas()
    extent = canvas.extent()
    src_crs = canvas.mapSettings().destinationCrs()
    # OGC:CRS84 is WGS84 with EXPLICIT lon,lat axis order.  Using EPSG:4326
    # here is a trap on QGIS 4 / PROJ 9: that CRS has lat,lon axis order
    # and the resulting QgsRectangle stores latitudes in x.  Symptom:
    # "the latitude values are right but the longitudes are wrong."
    wgs84 = QgsCoordinateReferenceSystem("OGC:CRS84")
    if not wgs84.isValid():
        wgs84 = QgsCoordinateReferenceSystem("EPSG:4326")

    raw = (extent.xMinimum(), extent.yMinimum(), extent.xMaximum(), extent.yMaximum())
    src_label = src_crs.authid() or src_crs.description() or "<unknown>"

    if not src_crs.isValid():
        raise ValueError(
            "Canvas has no valid CRS.  Set one via Project → Properties → CRS "
            "and try again."
        )

    # Always transform through CRS84 — even when the source IS EPSG:4326,
    # because in 4326's canonical axis order the QgsRectangle stores
    # latitude in x.  Going through CRS84 normalises axis order to lon,lat.
    xform = QgsCoordinateTransform(src_crs, wgs84, QgsProject.instance())
    # Ask the transform to detect antimeridian wrap if the binding
    # supports the keyword.  PyQt5/older builds reject it; fall back to
    # the positional form and we'll catch wrap below.
    try:
        wgs_extent = xform.transformBoundingBox(extent, handle180Crossover=True)
    except TypeError:
        wgs_extent = xform.transformBoundingBox(extent)

    west = wgs_extent.xMinimum()
    south = wgs_extent.yMinimum()
    east = wgs_extent.xMaximum()
    north = wgs_extent.yMaximum()

    QgsMessageLog.logMessage(
        f"canvas.bbox: src_crs={src_label} raw_extent={raw} "
        f"-> wgs84=({west:.6f}, {south:.6f}, {east:.6f}, {north:.6f})",
        "Terranova",
        Qgis.MessageLevel.Info,
    )

    # Antimeridian crossing — `transformBoundingBox` can return west>east
    # in that case.  Don't return garbage; tell the user clearly.
    if west >= east:
        raise ValueError(
            f"Canvas extent crosses the antimeridian (west={west:.3f}, "
            f"east={east:.3f}).  STAC catalogues can't accept that as a "
            "single bbox — pan so the area sits inside one hemisphere "
            "and try again."
        )

    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError(
            f"Canvas extent projects to ({west:.3f}, {south:.3f}, "
            f"{east:.3f}, {north:.3f}) which isn't a valid WGS84 bbox.  "
            f"Source CRS was {src_label}.  Try zooming in — projections "
            "near the poles or past the Web Mercator limits can produce "
            "invalid results."
        )

    return {"bbox": [west, south, east, north]}


# --------------------------------------------------------------------------- #
# Footprint preview overlay                                                   #
# --------------------------------------------------------------------------- #
def preview_footprint(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop a temporary outlined polygon on the canvas for a STAC item.

    Payload (one of ``geometry`` or ``bbox`` is required):

    - ``geometry``: GeoJSON polygon/multipolygon in WGS84 lon,lat.
    - ``bbox``: ``[west, south, east, north]`` in WGS84.
    - ``item_id`` (optional): used as the layer name so users can tell
      which scene is highlighted if they have several previews stacked.

    The previous preview, if any, is removed before the new one is added —
    we never accumulate stale preview layers in the project tree.
    """
    from qgis.core import (
        QgsFeature,
        QgsGeometry,
        QgsProject,
        QgsVectorLayer,
    )

    global _preview_layer_id

    geometry = payload.get("geometry")
    bbox_xy = payload.get("bbox")
    if geometry is None and bbox_xy is None:
        raise ValueError("preview_footprint needs either 'geometry' or 'bbox'")

    if geometry is not None:
        # GeoJSON straight into QGIS.  QgsGeometry.fromJson handles
        # Polygon and MultiPolygon (STAC footprints can be either).
        geo_str = geometry if isinstance(geometry, str) else json.dumps(geometry)
        qgs_geom = QgsGeometry.fromJson(geo_str)
        if qgs_geom is None or qgs_geom.isEmpty():
            raise ValueError(
                f"could not parse footprint geometry: {geo_str[:120]}…"
            )
    else:
        west, south, east, north = (float(v) for v in bbox_xy)
        qgs_geom = QgsGeometry.fromWkt(
            f"POLYGON(({west} {south}, {east} {south}, "
            f"{east} {north}, {west} {north}, {west} {south}))"
        )
    if qgs_geom.isEmpty():
        raise ValueError("preview_footprint received an empty geometry")

    item_id = str(payload.get("item_id") or "footprint")
    layer_name = f"Terranova preview: {item_id}"

    # Replace any existing preview layer.
    _remove_preview_layer()

    # In-memory layer in WGS84 — QGIS will reproject for display.
    layer = QgsVectorLayer("Polygon?crs=EPSG:4326", layer_name, "memory")
    layer.setCustomProperty("terranova.preview", "1")
    provider = layer.dataProvider()
    feat = QgsFeature()
    feat.setGeometry(qgs_geom)
    provider.addFeatures([feat])
    layer.updateExtents()

    # Style: cyan-blue outline, no fill, 2px line.  Visible on both light
    # and dark basemaps; won't obscure the imagery underneath.
    _style_outline(layer, rgb=(64, 196, 255), dashed=False, width=0.6)

    QgsProject.instance().addMapLayer(layer)
    _preview_layer_id = layer.id()

    # Zoom is intentionally NOT changed — users hate that.  The footprint
    # is now visible; they can pan/zoom themselves if they want a closer
    # look at the relationship between their AOI and the scene coverage.
    return {"layer_id": layer.id(), "name": layer_name}


def clear_preview(_payload: dict[str, Any]) -> dict[str, Any]:
    """Remove the current preview overlay, if any."""
    removed = _remove_preview_layer()
    return {"removed": removed}


# --------------------------------------------------------------------------- #
# Persistent AOI overlay                                                      #
# --------------------------------------------------------------------------- #
def show_aoi(payload: dict[str, Any]) -> dict[str, Any]:
    """Draw the user's current AOI as a persistent overlay on the canvas.

    Payload: ``{bbox: [west, south, east, north]}`` in WGS84.

    Styled distinctly from the scene-footprint preview (orange dashed,
    no fill) so users can see at a glance whether their search AOI and
    the scene they're about to download actually overlap.  Replaces any
    previous AOI layer.
    """
    from qgis.core import (
        QgsFeature,
        QgsGeometry,
        QgsProject,
        QgsVectorLayer,
    )

    global _aoi_layer_id

    bbox_xy = payload.get("bbox")
    if not bbox_xy or len(bbox_xy) != 4:
        raise ValueError("show_aoi needs bbox=[west, south, east, north]")
    west, south, east, north = (float(v) for v in bbox_xy)
    if not (west < east and south < north):
        # Don't silently draw a degenerate / inverted rectangle — the
        # caller almost certainly has a UI bug or the user is still
        # typing.  Caller should debounce.
        raise ValueError(
            f"AOI bbox is degenerate or inverted: "
            f"west={west}, south={south}, east={east}, north={north}"
        )

    qgs_geom = QgsGeometry.fromWkt(
        f"POLYGON(({west} {south}, {east} {south}, "
        f"{east} {north}, {west} {north}, {west} {south}))"
    )

    _remove_aoi_layer()
    layer = QgsVectorLayer(
        "Polygon?crs=EPSG:4326", "Terranova AOI", "memory"
    )
    layer.setCustomProperty("terranova.aoi", "1")
    provider = layer.dataProvider()
    feat = QgsFeature()
    feat.setGeometry(qgs_geom)
    provider.addFeatures([feat])
    layer.updateExtents()

    # Orange dashed outline, no fill — clearly different from the
    # footprint preview's cyan solid line so the two overlays don't
    # get visually confused.
    _style_outline(layer, rgb=(255, 158, 47), dashed=True, width=0.8)

    QgsProject.instance().addMapLayer(layer)
    _aoi_layer_id = layer.id()
    return {"layer_id": layer.id()}


def clear_aoi(_payload: dict[str, Any]) -> dict[str, Any]:
    """Remove the AOI overlay layer, if any."""
    removed = _remove_aoi_layer()
    return {"removed": removed}


def _remove_aoi_layer() -> bool:
    from qgis.core import QgsProject

    global _aoi_layer_id
    if _aoi_layer_id is None:
        return False
    try:
        QgsProject.instance().removeMapLayer(_aoi_layer_id)
    except Exception:  # noqa: BLE001
        pass
    _aoi_layer_id = None
    return True


# --------------------------------------------------------------------------- #
# Drag-a-rectangle AOI picker                                                 #
# --------------------------------------------------------------------------- #
#
# Lets the user choose the AOI by dragging on the canvas instead of typing
# four coordinates.  Activated by ``catalog.pick_aoi.start``; user drags a
# rectangle; on release we project to WGS84 and emit a ``catalog.aoi.picked``
# event the React panel listens for.
#
_aoi_picker: Any = None  # active tool, kept alive at module scope


def start_aoi_pick(_payload: dict[str, Any]) -> dict[str, Any]:
    """Activate a rubber-band rectangle tool on the canvas.

    Emits ``{type: "catalog.aoi.picked", bbox: [west,south,east,north]}``
    on the bridge event channel when the user releases the mouse.  The
    React side wires this to the NW/SE corner fields.
    """
    from qgis.utils import iface

    global _aoi_picker
    if iface is None:
        raise RuntimeError("QGIS iface unavailable")

    canvas = iface.mapCanvas()
    _aoi_picker = _build_rect_tool(canvas)
    canvas.setMapTool(_aoi_picker)
    return {"active": True}


def stop_aoi_pick(_payload: dict[str, Any]) -> dict[str, Any]:
    """Revert to the previous map tool, if one is set."""
    from qgis.utils import iface

    global _aoi_picker
    if iface is not None and _aoi_picker is not None:
        try:
            iface.mapCanvas().unsetMapTool(_aoi_picker)
        except Exception:  # noqa: BLE001
            pass
    _aoi_picker = None
    return {"active": False}


def _build_rect_tool(canvas: Any) -> Any:
    """Return a QgsMapTool that lets the user drag an AOI rectangle.

    Implemented as a thin subclass with a rubber band — works on every
    QGIS version we care about and avoids relying on QgsMapToolExtent's
    sometimes-shifting API.
    """
    from qgis.core import (
        Qgis,
        QgsCoordinateReferenceSystem,
        QgsCoordinateTransform,
        QgsMessageLog,
        QgsPointXY,
        QgsProject,
        QgsRectangle,
        QgsWkbTypes,
    )
    from qgis.gui import QgsMapTool, QgsRubberBand
    from qgis.PyQt.QtCore import Qt
    from qgis.PyQt.QtGui import QColor

    class _AoiRectTool(QgsMapTool):
        def __init__(self) -> None:
            super().__init__(canvas)
            self._band = QgsRubberBand(canvas, QgsWkbTypes.PolygonGeometry)
            self._band.setStrokeColor(QColor(64, 196, 255))
            self._band.setFillColor(QColor(64, 196, 255, 40))
            self._band.setWidth(1)
            self._start: QgsPointXY | None = None
            try:
                self._cursor = Qt.CursorShape.CrossCursor
            except AttributeError:  # PyQt5
                self._cursor = Qt.CrossCursor

        def activate(self) -> None:  # noqa: D401 — QgsMapTool API
            super().activate()
            try:
                canvas.setCursor(self._cursor)  # type: ignore[arg-type]
            except Exception:  # noqa: BLE001
                pass

        def canvasPressEvent(self, e) -> None:  # type: ignore[no-untyped-def] # noqa: N802
            self._start = self.toMapCoordinates(e.pos())
            self._band.reset(QgsWkbTypes.PolygonGeometry)

        def canvasMoveEvent(self, e) -> None:  # type: ignore[no-untyped-def] # noqa: N802
            if self._start is None:
                return
            cur = self.toMapCoordinates(e.pos())
            self._band.reset(QgsWkbTypes.PolygonGeometry)
            for pt in (
                self._start,
                QgsPointXY(cur.x(), self._start.y()),
                cur,
                QgsPointXY(self._start.x(), cur.y()),
            ):
                self._band.addPoint(pt, False)
            self._band.closePoints()

        def canvasReleaseEvent(self, e) -> None:  # type: ignore[no-untyped-def] # noqa: N802
            if self._start is None:
                return
            end = self.toMapCoordinates(e.pos())
            x_min, x_max = sorted([self._start.x(), end.x()])
            y_min, y_max = sorted([self._start.y(), end.y()])
            self._start = None
            self._band.reset(QgsWkbTypes.PolygonGeometry)

            # Convert canvas-CRS rect to WGS84 (CRS84 axis order).
            src_crs = canvas.mapSettings().destinationCrs()
            wgs84 = QgsCoordinateReferenceSystem("OGC:CRS84")
            if not wgs84.isValid():
                wgs84 = QgsCoordinateReferenceSystem("EPSG:4326")
            xform = QgsCoordinateTransform(src_crs, wgs84, QgsProject.instance())
            try:
                wgs = xform.transformBoundingBox(
                    QgsRectangle(x_min, y_min, x_max, y_max),
                    handle180Crossover=True,
                )
            except TypeError:
                wgs = xform.transformBoundingBox(
                    QgsRectangle(x_min, y_min, x_max, y_max)
                )

            west, south = wgs.xMinimum(), wgs.yMinimum()
            east, north = wgs.xMaximum(), wgs.yMaximum()

            QgsMessageLog.logMessage(
                f"AOI pick: canvas_crs={src_crs.authid()} "
                f"raw=({x_min:.3f},{y_min:.3f},{x_max:.3f},{y_max:.3f}) "
                f"-> wgs84=({west:.6f},{south:.6f},{east:.6f},{north:.6f})",
                "Terranova",
                Qgis.MessageLevel.Info,
            )

            from ..bridge import push_event

            push_event(
                {
                    "type": "catalog.aoi.picked",
                    "bbox": [west, south, east, north],
                }
            )
            # Auto-deactivate — single-shot tool.  User clicks the
            # button again to redo.
            stop_aoi_pick({})

        def deactivate(self) -> None:  # noqa: D401 — QgsMapTool API
            self._band.reset(QgsWkbTypes.PolygonGeometry)
            super().deactivate()

    return _AoiRectTool()


def _remove_preview_layer() -> bool:
    """Drop the tracked preview layer from the project.  Idempotent."""
    from qgis.core import QgsProject

    global _preview_layer_id
    if _preview_layer_id is None:
        return False
    try:
        QgsProject.instance().removeMapLayer(_preview_layer_id)
    except Exception:  # noqa: BLE001 — layer may have been removed by user
        pass
    _preview_layer_id = None
    return True


def _style_outline(
    layer: Any,
    *,
    rgb: tuple[int, int, int],
    dashed: bool = False,
    width: float = 0.6,
) -> None:
    """Apply a transparent-fill / coloured-outline symbol to ``layer``.

    Used by both the scene-footprint preview (cyan solid) and the AOI
    overlay (orange dashed).  Falls back gracefully on older bindings
    that lack QgsSingleSymbolRenderer.
    """
    from qgis.core import QgsSimpleFillSymbolLayer, QgsSymbol
    from qgis.PyQt.QtCore import Qt
    from qgis.PyQt.QtGui import QColor

    symbol = QgsSymbol.defaultSymbol(layer.geometryType())
    if symbol.symbolLayerCount() > 0:
        symbol.deleteSymbolLayer(0)
    fill = QgsSimpleFillSymbolLayer()
    fill.setColor(QColor(0, 0, 0, 0))  # transparent fill
    fill.setStrokeColor(QColor(*rgb))
    fill.setStrokeWidth(float(width))
    pen_style = Qt.DashLine if dashed else Qt.SolidLine
    try:
        # PyQt6 nests the enum under PenStyle.
        pen_style = (
            Qt.PenStyle.DashLine if dashed else Qt.PenStyle.SolidLine
        )
    except AttributeError:  # PyQt5 already gave us the flat form.
        pass
    fill.setStrokeStyle(pen_style)
    symbol.appendSymbolLayer(fill)
    try:
        from qgis.core import QgsSingleSymbolRenderer

        layer.setRenderer(QgsSingleSymbolRenderer(symbol))
    except Exception:  # noqa: BLE001 — older QGIS APIs
        pass
    layer.triggerRepaint()
