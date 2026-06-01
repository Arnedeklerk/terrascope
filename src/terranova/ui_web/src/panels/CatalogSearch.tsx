import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../bridge";
import { formatDMS, parseDMS } from "./dms";
import { JobProgress } from "./JobProgress";
import { AoiMap, type Bbox, type FootprintSpec } from "./AoiMap";

// Cycling palette for ticked-footprint overlays.  Picked for distinguishability
// against an OSM basemap and accessibility — eight high-saturation hues at
// roughly equal luminance so no scene's footprint "vanishes" into the map.
// Order chosen so adjacent picks (typical user behaviour — tick a few in a
// row) get maximally different colours.
const PALETTE = [
  "#FFD43B", // amber
  "#F06292", // pink
  "#66BB6A", // green
  "#AB47BC", // purple
  "#26C6DA", // teal
  "#FF7043", // orange
  "#5C6BC0", // indigo
  "#EF5350", // red
];
const PREVIEW_COLOR = "#40C4FF"; // cyan — distinct from the palette

function colorForIndex(i: number): string {
  return PALETTE[i % PALETTE.length];
}

interface CatalogItem {
  id: string;
  datetime: string;
  cloud: number | null;
  platform: string | null;
  bbox: [number, number, number, number] | null;
  // GeoJSON Polygon / MultiPolygon — typed loosely to avoid pulling in
  // @types/geojson just for this.
  geometry: { type: string; coordinates: unknown } | null;
}

/**
 * STAC catalogue search panel.
 *
 * AOI is set in three interchangeable ways:
 *  - Drag a rectangle on the embedded OpenStreetMap below the form
 *    (Earth-Explorer-style, primary path).
 *  - Type NW/SE corners directly (DD or DMS).
 *  - "Use canvas extent" — read the QGIS map canvas.
 *
 * Results show a footprint polygon on the embedded map when a row is
 * clicked, so the user can compare scene coverage to their AOI before
 * downloading.
 */

type Format = "dd" | "dms";

interface CornerDD {
  lat: string;
  lon: string;
}

export function CatalogSearch() {
  const [endpoint, setEndpoint] = useState("planetary_computer");
  const [collection, setCollection] = useState("sentinel-2-l2a");
  const [format, setFormat] = useState<Format>("dd");

  // Decimal-degrees state — north/west = NW corner; south/east = SE corner.
  const [nw, setNw] = useState<CornerDD>({ lat: "", lon: "" });
  const [se, setSe] = useState<CornerDD>({ lat: "", lon: "" });

  // DMS state (parallel — we convert on toggle).
  const [nwDms, setNwDms] = useState<CornerDD>({ lat: "", lon: "" });
  const [seDms, setSeDms] = useState<CornerDD>({ lat: "", lon: "" });

  const [start, setStart] = useState("2024-06-01");
  const [end, setEnd] = useState("2024-09-30");
  const [maxCloud, setMaxCloud] = useState(20);
  // Composite intent — when ON, the search caps results at maxImages
  // (cheapest cost / fastest run), auto-ticks them all on completion,
  // and visually promotes the composite buttons in the results header.
  const [compositeIntent, setCompositeIntent] = useState(false);
  const [maxImages, setMaxImages] = useState(30);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CatalogItem[] | null>(null);
  // Multi-select: set of item IDs the user has ticked.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // The item currently previewed on the QGIS map (last row clicked, not
  // necessarily ticked).  Separated from selectedIds because previewing
  // one footprint to inspect coverage shouldn't force a download.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [downloadJobId, setDownloadJobId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Whether downloads should crop the scene raster to the search AOI.
  // OFF by default — clipping behind the user's back was confusing.
  // When ON, the rio.clip_box step in catalog.py runs after odc.stac.load.
  const [maskToAoi, setMaskToAoi] = useState(false);
  // Ref to the header "tick all" checkbox so we can drive its
  // `indeterminate` visual state — React doesn't expose it as a prop.
  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!headerCheckboxRef.current) return;
    const total = results?.length ?? 0;
    const sel = selectedIds.size;
    headerCheckboxRef.current.checked = total > 0 && sel === total;
    headerCheckboxRef.current.indeterminate = sel > 0 && sel < total;
  }, [results, selectedIds]);
  // Per-item download status while a batch is running.
  const [batchProgress, setBatchProgress] = useState<{
    done: number;
    total: number;
    failed: string[];
  } | null>(null);
  // Batch driver state: queue of items left, shared output dir, currently
  // running item id.  These have to live up here at the top of the
  // component because all useState calls must run before the first
  // conditional return / JSX block.
  const [pendingQueue, setPendingQueue] = useState<CatalogItem[]>([]);
  const [batchOutDir, setBatchOutDir] = useState<string | null>(null);
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);

  // Derived AOI for the embedded map.  Returns null while corner fields
  // are partially populated so the map doesn't draw a degenerate rect.
  const mapAoi: Bbox | null = useMemo(() => {
    let b;
    try {
      b = currentBbox();
    } catch {
      return null;
    }
    if (
      !Number.isFinite(b.west) ||
      !Number.isFinite(b.south) ||
      !Number.isFinite(b.east) ||
      !Number.isFinite(b.north) ||
      b.east <= b.west ||
      b.north <= b.south
    ) {
      return null;
    }
    return b;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nw.lat, nw.lon, se.lat, se.lon, nwDms.lat, nwDms.lon, seDms.lat, seDms.lon, format]);

  // Footprints to draw on the embedded map: every ticked item gets a
  // stable colour from the palette (based on its row index, so colours
  // don't shuffle as you tick/untick), plus the currently-previewed row
  // gets an "active" highlight.  Overlapping fills compound naturally.
  const mapFootprints = useMemo<FootprintSpec[]>(() => {
    if (!results) return [];
    const out: FootprintSpec[] = [];
    results.forEach((it, idx) => {
      const ticked = selectedIds.has(it.id);
      const isPreview = previewId === it.id;
      if (!ticked && !isPreview) return;
      if (!it.geometry) return;
      out.push({
        id: it.id,
        geometry: it.geometry,
        color: isPreview && !ticked ? PREVIEW_COLOR : colorForIndex(idx),
        active: isPreview,
      });
    });
    return out;
  }, [results, selectedIds, previewId]);

  /** Map → fields.  Called when the user drags a rectangle on the map. */
  const onMapAoiChange = (b: Bbox) => {
    if (format === "dd") {
      setNw({ lat: String(b.north), lon: String(b.west) });
      setSe({ lat: String(b.south), lon: String(b.east) });
    } else {
      setNwDms({
        lat: formatDMS(b.north, true),
        lon: formatDMS(b.west, false),
      });
      setSeDms({
        lat: formatDMS(b.south, true),
        lon: formatDMS(b.east, false),
      });
    }
  };

  const currentBbox = (): {
    west: number;
    south: number;
    east: number;
    north: number;
  } => {
    if (format === "dd") {
      return {
        north: parseFloat(nw.lat),
        west: parseFloat(nw.lon),
        south: parseFloat(se.lat),
        east: parseFloat(se.lon),
      };
    }
    return {
      north: parseDMS(nwDms.lat),
      west: parseDMS(nwDms.lon),
      south: parseDMS(seDms.lat),
      east: parseDMS(seDms.lon),
    };
  };

  const switchFormat = (next: Format) => {
    if (next === format) return;
    if (next === "dms") {
      const toDms = (s: string, isLat: boolean) => {
        const v = parseFloat(s);
        return Number.isFinite(v) ? formatDMS(v, isLat) : "";
      };
      setNwDms({ lat: toDms(nw.lat, true), lon: toDms(nw.lon, false) });
      setSeDms({ lat: toDms(se.lat, true), lon: toDms(se.lon, false) });
    } else {
      const toDd = (s: string) => {
        try {
          return String(parseDMS(s));
        } catch {
          return "";
        }
      };
      setNw({ lat: toDd(nwDms.lat), lon: toDd(nwDms.lon) });
      setSe({ lat: toDd(seDms.lat), lon: toDd(seDms.lon) });
    }
    setFormat(next);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setResults(null);
    setSelectedIds(new Set());
    setPreviewId(null);
    void invoke("catalog.clear_preview");
    try {
      const bbox = currentBbox();
      if (
        !Number.isFinite(bbox.west) ||
        !Number.isFinite(bbox.east) ||
        !Number.isFinite(bbox.south) ||
        !Number.isFinite(bbox.north)
      ) {
        throw new Error("Fill in all four corner coordinates.");
      }
      if (bbox.east <= bbox.west) {
        throw new Error("SE longitude must be greater than NW longitude.");
      }
      if (bbox.north <= bbox.south) {
        throw new Error("NW latitude must be greater than SE latitude.");
      }
      const res = await invoke<{ items: CatalogItem[] }>("catalog.search", {
        endpoint,
        collection,
        bbox,
        datetime: { start, end },
        max_cloud: maxCloud,
        // When the user intends to composite, cap the catalogue
        // search at the chosen max so we don't paginate through
        // hundreds of scenes we'll never use.
        limit: compositeIntent ? maxImages : 50,
      });
      if (res.ok && res.result) {
        const items = res.result.items ?? [];
        setResults(items);
        // Auto-tick everything for composite mode so the user can
        // immediately click 'Composite (median)' without ticking
        // each row.  They can still untick scenes they don't want.
        if (compositeIntent && items.length) {
          setSelectedIds(new Set(items.map((it) => it.id)));
        }
      } else {
        setErr(res.error ?? "search failed");
      }
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const useCanvasBbox = async () => {
    setErr(null);
    const res = await invoke<{ bbox: [number, number, number, number] }>(
      "canvas.bbox",
    );
    if (!res.ok || !res.result?.bbox) {
      setErr(res.error ?? "Could not read the canvas extent.");
      return;
    }
    const [west, south, east, north] = res.result.bbox;
    if (format === "dd") {
      setNw({ lat: String(north), lon: String(west) });
      setSe({ lat: String(south), lon: String(east) });
    } else {
      setNwDms({ lat: formatDMS(north, true), lon: formatDMS(west, false) });
      setSeDms({ lat: formatDMS(south, true), lon: formatDMS(east, false) });
    }
  };

  // Intentionally NOT max-w-2xl like the other panels — catalog is the one
  // workflow whose value scales with available width (the embedded map
  // needs room to breathe).  Let it grow to the dock edge.
  return (
    <section
      className="w-full"
      style={{ contain: "layout style" }}
    >
      <h2 className="text-lg font-semibold mb-2">Catalogue search</h2>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Endpoint">
          <select
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1"
          >
            <option value="planetary_computer">Planetary Computer</option>
            <option value="earth_search">Earth Search</option>
            <option value="cdse">Copernicus Data Space</option>
          </select>
        </Field>
        <Field label="Collection">
          <select
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1"
          >
            <option value="sentinel-2-l2a">Sentinel-2 L2A</option>
            <option value="landsat-c2-l2">Landsat C2 L2</option>
            <option value="sentinel-1-rtc">Sentinel-1 RTC</option>
          </select>
        </Field>
      </div>

      {/* AOI block ----------------------------------------------------- */}
      <div className="mt-5 bg-bg-1 border border-bg-2 rounded-md p-3">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <span className="text-xs text-fg-muted">AOI (WGS84)</span>
          <div className="flex items-center gap-2 text-xs">
            <FormatPill active={format === "dd"} onClick={() => switchFormat("dd")}>
              Decimal degrees
            </FormatPill>
            <FormatPill active={format === "dms"} onClick={() => switchFormat("dms")}>
              DMS
            </FormatPill>
            <button
              onClick={useCanvasBbox}
              className="ml-2 px-2.5 py-1 bg-bg-2 hover:bg-bg-0 border border-bg-2 rounded"
              title="Read the current QGIS canvas extent and project it to WGS84"
            >
              Use canvas extent
            </button>
          </div>
        </div>

        <CornerRow
          name="Top-left (NW)"
          format={format}
          dd={nw}
          dms={nwDms}
          onDd={setNw}
          onDms={setNwDms}
        />
        <CornerRow
          name="Bottom-right (SE)"
          format={format}
          dd={se}
          dms={seDms}
          onDd={setSe}
          onDms={setSeDms}
        />

        {/* Embedded map — primary AOI picker.  Always visible so the user
            can verify what they're searching for without flipping windows.  */}
        <AoiMap
          aoi={mapAoi}
          footprints={mapFootprints}
          onAoiChange={onMapAoiChange}
          maskToAoi={maskToAoi}
          onMaskToAoiChange={setMaskToAoi}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <Field label="Start date">
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1"
          />
        </Field>
        <Field label="End date">
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1"
          />
        </Field>
      </div>

      {/* Composite intent — sits between the dates and the cloud-cover
          slider so the date range and 'how many to pull from that
          range' are visually adjacent. */}
      <div className="mt-3 grid grid-cols-2 gap-3 items-end">
        <label
          className="flex items-center gap-2 text-xs cursor-pointer select-none"
          title="When ON, the search caps results at 'Max images' and auto-ticks them so you can click 'Composite (median)' immediately."
        >
          <input
            type="checkbox"
            checked={compositeIntent}
            onChange={(e) => setCompositeIntent(e.target.checked)}
          />
          <span>
            Create composite from this search
            <span className="ml-2 text-fg-muted/70">
              — mean / median over time
            </span>
          </span>
        </label>
        <Field
          label="Max images for composite"
          hint={
            compositeIntent
              ? `Caps catalogue results at this many scenes.`
              : "Enable composite to set a cap."
          }
        >
          <input
            type="number"
            value={maxImages}
            min={2}
            max={500}
            step={5}
            disabled={!compositeIntent}
            onChange={(e) => setMaxImages(parseInt(e.target.value, 10) || 0)}
            className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono disabled:opacity-40"
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field label={`Max cloud cover (${maxCloud}%)`}>
          <input
            type="range"
            min={0}
            max={100}
            value={maxCloud}
            onChange={(e) => setMaxCloud(parseInt(e.target.value, 10))}
            className="w-full"
          />
        </Field>
      </div>

      <div className="flex gap-2 mt-4">
        <button
          onClick={submit}
          disabled={busy}
          className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-50"
        >
          {busy ? "Searching…" : "Search"}
        </button>
      </div>

      {err && <p className="text-danger text-sm mt-3">{err}</p>}

      {results && (
        <div className="mt-4 bg-bg-1 border border-bg-2 rounded-md overflow-hidden">
          <div className="px-3 py-2 flex items-center justify-between border-b border-bg-2">
            <span className="text-xs text-fg-muted">
              {results.length} item{results.length === 1 ? "" : "s"} found
              {selectedIds.size > 0 && (
                <span className="ml-2 text-accent">
                  — {selectedIds.size} selected
                </span>
              )}
              {previewId && (
                <span className="ml-2 text-fg-muted/70">
                  · previewing on map
                </span>
              )}
            </span>
            <div className="flex items-stretch gap-2">
              <button
                onClick={() => downloadBatch()}
                disabled={selectedIds.size === 0 || downloading}
                className={
                  "px-3 py-1 rounded text-xs disabled:opacity-50 " +
                  (compositeIntent
                    ? "bg-bg-2 hover:bg-bg-0 border border-bg-2"
                    : "bg-accent text-white")
                }
              >
                {downloading
                  ? "Downloading…"
                  : `Download ${selectedIds.size || ""} as COG${
                      selectedIds.size > 1 ? "s" : ""
                    }…`}
              </button>
              {/* Composite (mean / median) — only useful with 2+ ticked
                  items.  Loads them all as a lazy cube, reduces over
                  time, writes a single COG.  When the user has the
                  composite-intent checkbox on, swap the visual primary
                  here so the median button is the obvious action. */}
              <div
                className={
                  "flex items-stretch border rounded overflow-hidden " +
                  (compositeIntent
                    ? "border-accent"
                    : "bg-bg-2 border-bg-2")
                }
              >
                <button
                  onClick={() => startComposite("median")}
                  disabled={selectedIds.size < 2 || downloading}
                  className={
                    "px-2.5 py-1 text-xs disabled:opacity-40 disabled:cursor-default " +
                    (compositeIntent
                      ? "bg-accent text-white hover:brightness-110 border-r border-accent"
                      : "hover:bg-bg-0 border-r border-bg-2")
                  }
                  title="Median reflectance per pixel across the ticked scenes — robust to clouds + outliers, recommended default."
                >
                  Composite (median)
                </button>
                <button
                  onClick={() => startComposite("mean")}
                  disabled={selectedIds.size < 2 || downloading}
                  className={
                    "px-2.5 py-1 text-xs disabled:opacity-40 disabled:cursor-default " +
                    (compositeIntent
                      ? "bg-accent/80 text-white hover:brightness-110"
                      : "hover:bg-bg-0")
                  }
                  title="Mean reflectance per pixel — smoother but more cloud-affected. Pick median unless you specifically need mean."
                >
                  Mean
                </button>
              </div>
            </div>
          </div>
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-bg-2 sticky top-0">
                <tr className="text-fg-muted">
                  <th className="w-8 px-2 py-1.5 text-center">
                    {/* Master select/deselect for the visible result set.
                        Tri-state via the .indeterminate property the
                        useEffect at the top of the component keeps in
                        sync — checked = all, unchecked = none, dashed
                        box = partial. */}
                    <input
                      ref={headerCheckboxRef}
                      type="checkbox"
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedIds(
                            new Set(results.map((it) => it.id)),
                          );
                        } else {
                          setSelectedIds(new Set());
                        }
                      }}
                      aria-label="Select all visible results"
                      title="Select all / deselect all"
                    />
                  </th>
                  <th className="text-left font-normal px-3 py-1.5">ID</th>
                  <th className="text-left font-normal px-3 py-1.5">Datetime</th>
                  <th className="text-right font-normal px-3 py-1.5">Cloud %</th>
                  <th className="text-left font-normal px-3 py-1.5">Platform</th>
                </tr>
              </thead>
              <tbody>
                {results.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="text-center text-fg-muted py-4"
                    >
                      No items matched.  Widen the date range or cloud cap.
                    </td>
                  </tr>
                )}
                {results.map((it, idx) => {
                  const checked = selectedIds.has(it.id);
                  const active = previewId === it.id;
                  const swatch = colorForIndex(idx);
                  return (
                    <tr
                      key={it.id}
                      onClick={() => previewItem(it)}
                      className={
                        "cursor-pointer border-t border-bg-2 " +
                        (active ? "bg-accent/20 text-fg" : "hover:bg-bg-2")
                      }
                    >
                      <td
                        className="px-2 py-1.5 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelect(it.id)}
                          aria-label={`select ${it.id}`}
                        />
                      </td>
                      <td className="px-3 py-1.5 font-mono truncate max-w-[16rem]">
                        {/* Coloured pip when ticked so the table row visibly
                            corresponds to its footprint on the map.  Hidden
                            (invisible width-stable spacer) otherwise so the
                            ID column doesn't shift left when ticking. */}
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                          style={{
                            backgroundColor: checked ? swatch : "transparent",
                          }}
                          aria-hidden="true"
                        />
                        {it.id}
                      </td>
                      <td className="px-3 py-1.5 font-mono">
                        {String(it.datetime).slice(0, 19).replace("T", " ")}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {it.cloud == null ? "—" : it.cloud.toFixed(1)}
                      </td>
                      <td className="px-3 py-1.5">
                        {it.platform ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="px-3 py-1.5 border-t border-bg-2 text-fg-muted text-xs">
            Tick the checkbox to queue for download AND show the scene
            footprint on the map (each ticked scene gets a distinct colour;
            overlapping coverage shows darker).  Click a row to preview a
            single scene in cyan without committing to a download.
          </p>
        </div>
      )}

      {batchProgress && (
        <div className="mt-3 text-xs text-fg-muted">
          Batch: {batchProgress.done}/{batchProgress.total} done
          {batchProgress.failed.length > 0 && (
            <span className="text-danger ml-2">
              · {batchProgress.failed.length} failed
            </span>
          )}
        </div>
      )}

      <JobProgress
        jobId={downloadJobId}
        onComplete={() => onItemComplete(true)}
        onFailed={(e) => onItemComplete(false, e)}
      />
    </section>
  );

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }


  function previewItem(it: CatalogItem) {
    // Footprint preview is rendered locally by AoiMap (sync — fast,
    // can't fail).  We just bump the previewId; the parent's useMemo
    // pulls the geometry out of `results` and feeds it down.
    setPreviewId(it.id);
  }

  /**
   * Build a single composite COG (mean or median reflectance per pixel)
   * from every ticked scene.  Same job-id streaming pattern as the
   * individual download path; the composite is added to the QGIS layer
   * panel on completion.
   */
  async function startComposite(method: "mean" | "median") {
    if (selectedIds.size < 2 || !results) return;
    const items = results.filter((it) => selectedIds.has(it.id));
    if (items.length < 2) return;

    let bbox;
    try {
      bbox = currentBbox();
    } catch (e) {
      setErr((e as Error).message);
      return;
    }

    const defaultName = `composite_${method}_${items.length}scenes.tif`;
    const r = await invoke<{ path: string }>("dialog.save_file", {
      default: defaultName,
      title: `Save ${method} composite COG`,
      filter: "Cloud-Optimised GeoTIFF (*.tif)",
    });
    if (!r.ok || !r.result?.path) return;

    setErr(null);
    setDownloading(true);
    setBatchProgress({ done: 0, total: 1, failed: [] });
    setCurrentItemId(`composite (${method})`);
    setPendingQueue([]);
    setBatchOutDir(null);

    const dl = await invoke<{ job_id: string }>("catalog.composite", {
      endpoint,
      collection,
      item_ids: items.map((it) => it.id),
      bbox,
      out_path: r.result.path,
      mask_to_aoi: maskToAoi,
      method,
    });
    if (dl.ok && dl.result?.job_id) {
      setDownloadJobId(dl.result.job_id);
    } else {
      onItemComplete(false, dl.error ?? "catalog.composite failed");
    }
  }

  async function downloadBatch() {
    if (selectedIds.size === 0 || !results) return;
    setErr(null);
    const queue = results.filter((it) => selectedIds.has(it.id));
    if (queue.length === 0) return;

    // For batch downloads, ask once for an output FOLDER and auto-name
    // files by item_id.  Single-item downloads keep the old save-file
    // dialog so users can choose a specific filename.
    let out_dir: string | null = null;
    if (queue.length > 1) {
      const r = await invoke<{ path: string }>("dialog.open_directory", {
        title: "Save downloads to folder",
      });
      if (!r.ok || !r.result?.path) return;
      out_dir = r.result.path;
    }

    setDownloading(true);
    setBatchProgress({ done: 0, total: queue.length, failed: [] });
    setBatchOutDir(out_dir);
    setPendingQueue(queue.slice(1));
    await startDownload(queue[0], out_dir);
  }

  async function startDownload(it: CatalogItem, outDir: string | null) {
    let bbox;
    try {
      bbox = currentBbox();
    } catch (e) {
      finishBatch();
      setErr((e as Error).message);
      return;
    }

    let out_path: string;
    if (outDir) {
      out_path = `${outDir.replace(/[/\\]+$/, "")}/${it.id}.tif`;
    } else {
      const r = await invoke<{ path: string }>("dialog.save_file", {
        default: `${it.id}.tif`,
        title: "Save as COG",
        filter: "Cloud-Optimised GeoTIFF (*.tif)",
      });
      if (!r.ok || !r.result?.path) {
        finishBatch();
        return;
      }
      out_path = r.result.path;
    }

    setCurrentItemId(it.id);
    const dl = await invoke<{ job_id: string }>("catalog.download", {
      endpoint,
      collection,
      item_id: it.id,
      bbox,
      out_path,
      mask_to_aoi: maskToAoi,
    });
    if (dl.ok && dl.result?.job_id) {
      setDownloadJobId(dl.result.job_id);
    } else {
      onItemComplete(false, dl.error ?? "catalog.download failed");
    }
  }

  function onItemComplete(ok: boolean, error?: string) {
    setDownloadJobId(null);
    setBatchProgress((p) =>
      p
        ? {
            done: p.done + 1,
            total: p.total,
            failed: ok && currentItemId ? p.failed : [...p.failed, currentItemId ?? "?"],
          }
        : null,
    );
    if (!ok && error) setErr(error);

    if (pendingQueue.length === 0) {
      finishBatch();
      return;
    }
    const [next, ...rest] = pendingQueue;
    setPendingQueue(rest);
    void startDownload(next, batchOutDir);
  }

  function finishBatch() {
    setDownloading(false);
    setCurrentItemId(null);
    setPendingQueue([]);
    setBatchOutDir(null);
  }
}

/* ------------------------------------------------------------------ */

interface FormatPillProps {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}
function FormatPill({ active, onClick, children }: FormatPillProps) {
  return (
    <button
      onClick={onClick}
      className={
        "px-2 py-1 rounded text-xs " +
        (active
          ? "bg-accent text-white"
          : "bg-bg-2 hover:bg-bg-0 border border-bg-2")
      }
    >
      {children}
    </button>
  );
}

interface CornerRowProps {
  name: string;
  format: Format;
  dd: CornerDD;
  dms: CornerDD;
  onDd(v: CornerDD): void;
  onDms(v: CornerDD): void;
}
function CornerRow({ name, format, dd, dms, onDd, onDms }: CornerRowProps) {
  if (format === "dd") {
    return (
      <div className="grid grid-cols-[140px_1fr_1fr] gap-2 items-center mt-2">
        <span className="text-xs text-fg-muted">{name}</span>
        <Field label="Lat">
          <input
            type="number"
            step="any"
            value={dd.lat}
            onChange={(e) => onDd({ ...dd, lat: e.target.value })}
            className="w-full bg-bg-0 border border-bg-2 rounded px-2 py-1 font-mono"
          />
        </Field>
        <Field label="Lon">
          <input
            type="number"
            step="any"
            value={dd.lon}
            onChange={(e) => onDd({ ...dd, lon: e.target.value })}
            className="w-full bg-bg-0 border border-bg-2 rounded px-2 py-1 font-mono"
          />
        </Field>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[140px_1fr_1fr] gap-2 items-center mt-2">
      <span className="text-xs text-fg-muted">{name}</span>
      <Field label="Lat">
        <input
          type="text"
          value={dms.lat}
          placeholder={`51° 30' 26" N`}
          onChange={(e) => onDms({ ...dms, lat: e.target.value })}
          className="w-full bg-bg-0 border border-bg-2 rounded px-2 py-1 font-mono"
        />
      </Field>
      <Field label="Lon">
        <input
          type="text"
          value={dms.lon}
          placeholder={`0° 7' 39" W`}
          onChange={(e) => onDms({ ...dms, lon: e.target.value })}
          className="w-full bg-bg-0 border border-bg-2 rounded px-2 py-1 font-mono"
        />
      </Field>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}
function Field({ label, hint, children }: FieldProps) {
  const longHint = !!hint && hint.length >= 80;
  return (
    <label className="flex flex-col gap-1 text-xs text-fg-muted">
      <span>
        {label}
        {hint && !longHint && (
          <span className="ml-2 text-fg-muted/70">— {hint}</span>
        )}
      </span>
      {children}
      {hint && longHint && (
        <span className="text-fg-muted/70 leading-snug mt-0.5">{hint}</span>
      )}
    </label>
  );
}
