import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Embedded Earth-Explorer-style map for picking an AOI and previewing
 * scene footprints inside the catalog panel itself.
 *
 * Why this exists instead of pushing overlays to the QGIS canvas: the
 * QGIS-canvas approach depended on a lot of state lining up (project
 * CRS valid, layer panel not in a weird state, in-memory layer renderer
 * applying correctly).  An embedded map sidesteps all of that and gives
 * the user instant visual feedback regardless of what QGIS is doing.
 *
 * Props are the controlled bbox + an optional scene footprint polygon
 * to highlight; the parent owns state.  We never call back into the
 * bridge from here.
 */

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

// Available basemaps.  Both are free without an API key; both require
// attribution which is set in the tile layer options.  Keep them outside
// the component so swap-on-toggle doesn't re-create the L.tileLayer
// options object every render.
type BasemapKey = "street" | "satellite";
const BASEMAPS: Record<
  BasemapKey,
  { url: string; options: L.TileLayerOptions }
> = {
  street: {
    // No `{r}` retina-tile placeholder — on HiDPI laptops the @2x tiles
    // mean 4× the pixel data per tile, which makes both download and
    // QtWebEngine composite work proportionally heavier.  Sticking to
    // 1× tiles costs a little crispness on hidpi screens but the
    // scrolling/panning experience is far better.
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    options: {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 20,
      keepBuffer: 4,
      updateWhenIdle: true,
    },
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution:
        "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      maxZoom: 19,
      keepBuffer: 4,
      updateWhenIdle: true,
    },
  },
};

export interface FootprintSpec {
  id: string;
  geometry: { type: string; coordinates: unknown };
  /** Hex outline colour, e.g. ``#FFD43B``.  Fill is the same colour at ~15% alpha. */
  color: string;
  /** If true, draw thicker stroke — used for the currently-previewed row. */
  active?: boolean;
}

interface Props {
  /** Current AOI, drawn as an orange dashed rectangle.  `null` = none. */
  aoi: Bbox | null;
  /**
   * Footprints to draw with semi-transparent fills.  Overlapping regions
   * appear naturally darker because alpha compounds — the Earth-Explorer
   * "which scenes cover my AOI" effect.  Pass an empty array for none.
   */
  footprints: FootprintSpec[];
  /** Called when the user finishes drawing a new rectangle. */
  onAoiChange(b: Bbox): void;
  /** Whether downloads should clip the scene raster to the AOI. */
  maskToAoi: boolean;
  /** Toggle handler for the "Mask to AOI" checkbox in the header. */
  onMaskToAoiChange(v: boolean): void;
}

export function AoiMap({
  aoi,
  footprints,
  onAoiChange,
  maskToAoi,
  onMaskToAoiChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [basemap, setBasemap] = useState<BasemapKey>("street");
  // Layers we control — held in refs so we can replace cleanly on prop
  // changes without React tree churn.
  const aoiLayerRef = useRef<L.Rectangle | null>(null);
  // One L.GeoJSON per footprint id; diffed against the incoming prop on
  // every render so we don't tear-down/rebuild every layer each time.
  const footprintLayersRef = useRef<Map<string, L.GeoJSON>>(new Map());
  const drawingRef = useRef<{
    active: boolean;
    start: L.LatLng | null;
    rect: L.Rectangle | null;
    lastMove: L.LatLng | null;
  }>({ active: false, start: null, rect: null, lastMove: null });
  // Latest onAoiChange — refs so the draw handlers don't have to be
  // re-registered on every parent re-render.
  const onAoiChangeRef = useRef(onAoiChange);
  onAoiChangeRef.current = onAoiChange;

  // ----------------------------------------------------------------- init
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [20, 0],
      zoom: 2,
      worldCopyJump: true,
      zoomControl: true,
      scrollWheelZoom: true,
      wheelDebounceTime: 30,
      // Canvas renderer makes pan/drag MUCH smoother when several
      // semi-transparent footprints are visible — SVG alpha-blending
      // is the bottleneck with 4+ polygons on screen.
      preferCanvas: true,
      // No tile fade-in: shaves a frame off every pan + every tile
      // request and just makes the map feel snappier.
      fadeAnimation: false,
      // Don't request a new tile set on every zoom delta; wait until
      // the zoom-out finishes.  Smoother feeling zoom at the cost of
      // brief blurring at intermediate scales.
      zoomAnimation: true,
    });
    requestAnimationFrame(() => {
      map.invalidateSize();
    });
    // Initial tile layer is added by the basemap-effect below; we just
    // need the map instance ready first so the effect has something to
    // .addTo(...).
    mapRef.current = map;

    // Drawing handlers — registered once, gated by drawingRef.current.active
    // so the same map can be panned normally when draw mode is off.

    const abortDraw = () => {
      const d = drawingRef.current;
      if (d.rect) {
        d.rect.remove();
        d.rect = null;
      }
      d.start = null;
      d.lastMove = null;
      d.active = false;
      map.dragging.enable();
      if (containerRef.current) {
        containerRef.current.style.cursor = "";
      }
    };

    const completeDraw = (end: L.LatLng | null) => {
      const d = drawingRef.current;
      const start = d.start;
      if (!start) return;
      const e = end ?? d.lastMove;
      if (!e) {
        abortDraw();
        return;
      }
      const south = Math.min(start.lat, e.lat);
      const north = Math.max(start.lat, e.lat);
      const west = Math.min(start.lng, e.lng);
      const east = Math.max(start.lng, e.lng);
      abortDraw();
      if (north - south < 1e-5 || east - west < 1e-5) return;

      // CRITICAL: commit the persistent AOI rectangle DIRECTLY here,
      // not through a React-state round-trip.  Previous attempts to
      // make this work via setNw -> mapAoi useMemo -> aoi prop ->
      // useEffect have repeatedly failed for the user even after
      // multiple "fixes" — at this point the round-trip is clearly
      // unreliable in their environment.  By contrast, adding the
      // rectangle directly to the Leaflet map IS reliable: it's
      // imperative DOM manipulation that can't be silently dropped
      // by a missed state update or a re-render race.
      //
      // The aoi useEffect still runs when the user types into the
      // corner fields, so this isn't redundant — that path keeps
      // the rectangle in sync with typed input.  The direct call
      // here just removes the dependency on that path for the
      // common case of drawing the AOI on the map.
      if (aoiLayerRef.current) {
        aoiLayerRef.current.remove();
        aoiLayerRef.current = null;
      }
      const bounds = L.latLngBounds([south, west], [north, east]);
      aoiLayerRef.current = L.rectangle(bounds, {
        color: "#FF9E2F",
        weight: 3,
        dashArray: "8 4",
        // Tiny tinted fill so the AOI is visible even when the user
        // is zoomed out and the dashed stroke is just a thin orange
        // line.  10% alpha = barely there but unmistakable.
        fill: true,
        fillColor: "#FF9E2F",
        fillOpacity: 0.1,
        interactive: false,
        renderer: L.svg(),
      }).addTo(map);
      // Diagnostic — if the AOI ever fails to appear again, the
      // DevTools console will tell us exactly which step ran and what
      // bounds were used.  Cheap to leave in.
      console.log("[AOI] committed rectangle", {
        bounds: { south, west, north, east },
      });

      // Sync the corner fields too (in parallel; this update no
      // longer affects the rectangle's existence).
      onAoiChangeRef.current({ west, south, east, north });
    };

    const onMouseDown = (e: L.LeafletMouseEvent) => {
      const d = drawingRef.current;
      if (!d.active) return;
      if (e.originalEvent.button !== 0) return;
      d.start = e.latlng;
      d.lastMove = e.latlng;
      d.rect = L.rectangle(L.latLngBounds(d.start, d.start), {
        color: "#FF9E2F",
        weight: 2,
        dashArray: "6 4",
        fill: false,
        interactive: false,
        renderer: L.svg(),
      }).addTo(map);
      map.dragging.disable();
    };
    const onMouseMove = (e: L.LeafletMouseEvent) => {
      const d = drawingRef.current;
      if (!d.active || !d.start || !d.rect) return;
      d.lastMove = e.latlng;
      d.rect.setBounds(L.latLngBounds(d.start, e.latlng));
    };
    // Document-level mouseup: Leaflet's map.on("mouseup") only fires when
    // the release happens OVER the map container.  Dragging toward the
    // edge and releasing outside (very common when picking a large AOI)
    // means the drag stayed "active" forever and the AOI never committed
    // — that's the persistent 'box doesn't stick' bug.
    //
    // Capture-phase listener on the document means we see every mouseup
    // and can decide whether it terminates an in-progress drag.  We
    // ignore non-left-button releases (button 0 only).  When the
    // release happens inside the map container we use that point;
    // when outside we fall back to the last-seen mousemove point so
    // the user gets the bounds they were drawing right up to the
    // moment they dragged off-edge.
    const onDocumentMouseUp = (de: MouseEvent) => {
      const d = drawingRef.current;
      if (!d.active || !d.start) return;
      if (de.button !== 0) return;
      let end: L.LatLng | null = null;
      const container = map.getContainer();
      const rect = container.getBoundingClientRect();
      const inside =
        de.clientX >= rect.left &&
        de.clientX <= rect.right &&
        de.clientY >= rect.top &&
        de.clientY <= rect.bottom;
      if (inside) {
        try {
          end = map.mouseEventToLatLng(de);
        } catch {
          end = d.lastMove;
        }
      } else {
        end = d.lastMove;
      }
      completeDraw(end);
    };
    // Right-click during drag MUST cancel cleanly.  Three independent
    // paths in case any one of them is swallowed somewhere up the stack
    // (QtWebEngine occasionally eats contextmenu events before Leaflet
    // sees them; the temp rectangle's child elements might capture the
    // event before bubbling; etc.).  Each handler is idempotent so
    // running more than one of them per click is harmless.
    const onContextMenu = (e: L.LeafletMouseEvent) => {
      abortDraw();
      e.originalEvent?.preventDefault?.();
    };
    // Window-level safety net: catches contextmenu events even if
    // Leaflet's own dispatcher doesn't fire.  Scoped to events inside
    // the map container so we don't preventDefault on right-clicks
    // elsewhere in the dock (e.g. for native input field menus).
    const onWindowContextMenu = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      if (drawingRef.current.active || drawingRef.current.rect) {
        abortDraw();
      }
    };
    // Esc also cancels — symmetrical with the Expand-modal Esc handler.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawingRef.current.active) abortDraw();
    };

    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("contextmenu", onContextMenu);
    // Document-level so off-map releases still commit the drag — see
    // onDocumentMouseUp comment.  Use capture so we win against
    // ancestors that might preventDefault on mouseup.
    document.addEventListener("mouseup", onDocumentMouseUp, true);
    window.addEventListener("contextmenu", onWindowContextMenu, true);
    window.addEventListener("keydown", onEsc);

    return () => {
      map.off("mousedown", onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("contextmenu", onContextMenu);
      document.removeEventListener("mouseup", onDocumentMouseUp, true);
      window.removeEventListener("contextmenu", onWindowContextMenu, true);
      window.removeEventListener("keydown", onEsc);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Basemap layer — replaced wholesale when the user toggles between
  // street and satellite.  The new layer is added BEFORE the old one is
  // removed so there's no flash of empty grey while tiles load.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const cfg = BASEMAPS[basemap];
    const layer = L.tileLayer(cfg.url, cfg.options).addTo(map);
    // Keep base tiles below footprint/AOI overlays.
    layer.bringToBack();
    const prev = baseLayerRef.current;
    baseLayerRef.current = layer;
    if (prev) prev.remove();
  }, [basemap]);

  // Re-render the AOI rectangle when prop changes; fit view to it the
  // first time so the user sees their AOI without panning.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (aoiLayerRef.current) {
      aoiLayerRef.current.remove();
      aoiLayerRef.current = null;
    }
    if (!aoi) return;
    const bounds = L.latLngBounds(
      [aoi.south, aoi.west],
      [aoi.north, aoi.east],
    );
    aoiLayerRef.current = L.rectangle(bounds, {
      color: "#FF9E2F",
      weight: 3,
      dashArray: "8 4",
      fill: true,
      fillColor: "#FF9E2F",
      fillOpacity: 0.1,
      // Match the temp drag rectangle — don't let the AOI eat clicks
      // that should reach the map (e.g. starting a new draw on top
      // of the existing rectangle).
      interactive: false,
      // Force SVG renderer.  See the matching note in completeDraw.
      renderer: L.svg(),
    }).addTo(map);
    // Fit the bounds with a bit of padding, but only if the bounds are
    // outside the current view — don't yank the user's zoom for free.
    if (!map.getBounds().contains(bounds)) {
      map.fitBounds(bounds, { padding: [20, 20], maxZoom: 12 });
    }
  }, [aoi]);

  // Footprints: one layer per id, diffed against the prop.  Overlapping
  // semi-transparent fills produce a natural Earth-Explorer-style
  // darkening where scenes overlap.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const current = footprintLayersRef.current;
    const incoming = new Map(footprints.map((f) => [f.id, f]));

    // Remove footprints that are no longer in the prop list.
    for (const [id, layer] of current) {
      if (!incoming.has(id)) {
        layer.remove();
        current.delete(id);
      }
    }
    // Add or restyle the rest.
    for (const spec of footprints) {
      const existing = current.get(spec.id);
      const style: L.PathOptions = {
        color: spec.color,
        weight: spec.active ? 3 : 1.5,
        fill: true,
        fillColor: spec.color,
        // ~15% fill so 2–3 overlapping scenes still let the basemap
        // through but stacked-up regions get visibly darker.
        fillOpacity: spec.active ? 0.25 : 0.15,
        opacity: spec.active ? 1.0 : 0.8,
      };
      if (existing) {
        existing.setStyle(style);
      } else {
        const layer = L.geoJSON(spec.geometry as never, { style }).addTo(map);
        current.set(spec.id, layer);
      }
    }
  }, [footprints]);

  // Leaflet caches the container size at every layout-affecting event.
  // Switching expanded mode resizes the container in one paint; tell
  // Leaflet to re-measure on the next frame so tiles + hit testing line
  // up with the new bounds.
  useEffect(() => {
    if (!mapRef.current) return;
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 50);
    return () => clearTimeout(t);
  }, [expanded]);

  // Escape collapses the expanded view.  Only attach when expanded so
  // a stray Escape press in normal mode doesn't get swallowed.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const startDrawing = () => {
    drawingRef.current.active = true;
    if (containerRef.current) {
      containerRef.current.style.cursor = "crosshair";
    }
  };
  // Drawing auto-disengages on mouseup; restore the cursor.
  useEffect(() => {
    if (!containerRef.current) return;
    const reset = () => {
      if (containerRef.current && !drawingRef.current.active) {
        containerRef.current.style.cursor = "";
      }
    };
    const t = setInterval(reset, 200);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      {/* When expanded, dim everything behind the modal and let
          click-outside collapse it.  z-40 sits under the map wrapper's
          z-50 so the map stays clickable. */}
      {expanded && (
        <div
          className="fixed inset-0 bg-black/60 z-40"
          onClick={() => setExpanded(false)}
          aria-hidden="true"
        />
      )}
      <div
        className={
          "bg-bg-1 border border-bg-2 rounded-md overflow-hidden flex flex-col " +
          (expanded
            ? "fixed inset-3 z-50 shadow-2xl"
            : "mt-4")
        }
      >
        <div className="px-3 py-2 flex items-center justify-between border-b border-bg-2 text-xs">
          <span className="text-fg-muted">
            AOI map — draw a rectangle to set the search area.  Orange
            dashed = AOI, coloured fills = ticked scene footprints.
          </span>
          <div className="flex items-center gap-2">
            {/* AOI controls — Mask and Draw are visually grouped in a
                single segmented bar to signal that Mask is a modifier
                of the AOI workflow (it only matters if the AOI is set).
                Expand stays separate because it's a viewport concern,
                not an AOI concern. */}
            <div className="flex items-stretch bg-bg-2 border border-bg-2 rounded overflow-hidden">
              <label
                className="flex items-center gap-1.5 px-2.5 py-1 hover:bg-bg-0 cursor-pointer select-none border-r border-bg-2"
                title="Mask to AOI — when ON, downloaded scenes are cropped to the AOI rectangle. When OFF (default), the full scene tile is downloaded; much larger files, but you keep every pixel the scene covers."
              >
                <input
                  type="checkbox"
                  checked={maskToAoi}
                  onChange={(e) => onMaskToAoiChange(e.target.checked)}
                />
                Mask
              </label>
              <button
                onClick={startDrawing}
                className="px-2.5 py-1 hover:bg-bg-0"
                title="Click then drag on the map to draw an AOI rectangle"
              >
                Draw AOI
              </button>
            </div>
            {/* Basemap toggle — Map (Carto Voyager) vs Satellite (Esri).
                Single click switches; tiles swap without remounting the
                map, so AOI + footprints stay put. */}
            <div className="flex items-stretch bg-bg-2 border border-bg-2 rounded overflow-hidden">
              <button
                onClick={() => setBasemap("street")}
                className={
                  "px-2.5 py-1 border-r border-bg-2 " +
                  (basemap === "street"
                    ? "bg-accent text-white"
                    : "hover:bg-bg-0")
                }
                title="Street map basemap"
              >
                Map
              </button>
              <button
                onClick={() => setBasemap("satellite")}
                className={
                  "px-2.5 py-1 " +
                  (basemap === "satellite"
                    ? "bg-accent text-white"
                    : "hover:bg-bg-0")
                }
                title="Satellite imagery basemap (Esri World Imagery)"
              >
                Satellite
              </button>
            </div>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="px-2.5 py-1 bg-bg-2 hover:bg-bg-0 border border-bg-2 rounded"
              title={
                expanded
                  ? "Collapse map back into the panel (Esc)"
                  : "Expand map to fill the dock"
              }
            >
              {expanded ? "Collapse ↙" : "Expand ↗"}
            </button>
          </div>
        </div>
        {/* Map container.  In normal mode we use aspect-ratio so the map
            scales taller as the user drags the dock wider — no fixed
            pixel height.  In expanded mode flex-1 takes the remaining
            modal area.  Intentionally NO React onWheel handler — React
            adds passive listeners that fight Leaflet's native wheel
            handler. */}
        <div
          ref={containerRef}
          className="w-full"
          style={{
            // GPU compositing hint.  willChange alone gives the
            // compositor the hint; we deliberately don't add
            // `transform: translateZ(0)` because that breaks
            // Leaflet's overlay-pane rendering.
            willChange: "transform",
            // Isolate the map's paint area from the surrounding
            // panel.  This is the single most important hint for
            // scroll perf on HiDPI laptops — without it, every panel
            // scroll forces the compositor to rasterise the map's
            // pixels into the surrounding scroll buffer.  With it,
            // the map gets its own cached layer that scrolls as a
            // single blit.  `layout style paint` also stops layout
            // changes inside the map (e.g. tile loads) from
            // invalidating the panel's layout above.
            contain: "layout style paint",
            ...(expanded
              ? { flex: "1 1 auto", minHeight: 0 }
              : { aspectRatio: "3 / 2", minHeight: 340 }),
          }}
        />
      </div>
    </>
  );
}
