import { Fragment, useEffect, useState } from "react";
import { invoke } from "../bridge";
import { JobProgress } from "./JobProgress";
import { Select } from "./Select";

/**
 * Accuracy report — two paths, picked by the top-level mode toggle:
 *
 * - "Use a validation vector": traditional flow.  Pick a classified
 *   raster + a labelled validation vector + its class field; we
 *   sample the raster at every pixel covered by the vector and
 *   compute OA / kappa / per-class metrics.
 *
 * - "Generate random points": modern flow.  Pick a raster, generate
 *   a stratified sample of points, label each with the truth class
 *   via the point-by-point pad, then compute the report straight
 *   from the points file's `predicted` and `truth` columns.  No
 *   separate validation vector needed.
 *
 * Both modes end in the same inline metrics block (OA, κ, N, per-class
 * UA/PA/F1, confusion matrix) plus optional PDF + Excel exports.
 */

type AccuracyMode = "vector" | "points";

interface LayerInfo {
  name: string;
  source: string;
}

interface ReportPayload {
  class_labels: number[];
  confusion_matrix: number[][];
  users_accuracy: (number | null)[];
  producers_accuracy: (number | null)[];
  f1_per_class: (number | null)[];
  overall_accuracy: number;
  kappa: number;
  n_samples: number;
}

interface AccuracyResult {
  output_path?: string | null;
  output_xlsx?: string | null;
  overall_accuracy: number;
  kappa: number;
  n_samples: number;
  report?: ReportPayload | null;
}

type SamplingStrategy = "random" | "stratified" | "equalized_stratified";

const STRATEGY_LABELS: Record<SamplingStrategy, string> = {
  random: "Random",
  stratified: "Stratified random (proportional)",
  equalized_stratified: "Equalized stratified random",
};
const STRATEGY_HINTS: Record<SamplingStrategy, string> = {
  random:
    "Uniformly random points across all valid pixels.  Easy to reason about; large classes dominate the sample, rare classes can be missed entirely.",
  stratified:
    "Points per class are proportional to that class's pixel count, with a floor so rare classes still get tested.  Standard Olofsson-style design for OA estimation.",
  equalized_stratified:
    "Same N points per class regardless of class size.  Best for evaluating rare classes — gives every class equal evidence in the confusion matrix.",
};

export function Accuracy() {
  const [mode, setMode] = useState<AccuracyMode>("vector");

  const [rasters, setRasters] = useState<LayerInfo[]>([]);
  const [vectors, setVectors] = useState<LayerInfo[]>([]);
  const [fields, setFields] = useState<string[]>([]);

  const [rasterSrc, setRasterSrc] = useState("");
  const [vectorSrc, setVectorSrc] = useState("");
  const [classField, setClassField] = useState("");
  const [outputPdf, setOutputPdf] = useState("");

  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AccuracyResult | null>(null);

  // Excel output toggle (default ON — most users want it).
  const [emitXlsx, setEmitXlsx] = useState(true);
  // Random-point generator state.  Has its OWN raster picker (separate
  // from the report's "Classified raster") so users can build a
  // validation set for any raster without first changing the report
  // setup above.
  const [genRasterSrc, setGenRasterSrc] = useState<string>("");
  const [genClasses, setGenClasses] = useState<number[]>([]);
  const [strategy, setStrategy] = useState<SamplingStrategy>("stratified");
  const [nTotal, setNTotal] = useState(300);
  const [pointsPerClass, setPointsPerClass] = useState(30);
  const [genOutPath, setGenOutPath] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);

  // Probe class codes whenever the generator's raster changes so the
  // user can see "found 7 classes" before they commit to a strategy.
  useEffect(() => {
    if (!genRasterSrc) {
      setGenClasses([]);
      return;
    }
    invoke<{ classes: number[]; n_classes: number }>("accuracy.probe_classes", {
      raster_path: genRasterSrc,
    }).then((r) => {
      if (r.ok && r.result) setGenClasses(r.result.classes);
      else setGenClasses([]);
    });
  }, [genRasterSrc]);

  // Default the generator's raster to whatever the user picked for the
  // report — but only once, so they can override it independently.
  useEffect(() => {
    if (rasterSrc && !genRasterSrc) setGenRasterSrc(rasterSrc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rasterSrc]);

  // Labelling-mode state.  Driven by accuracy.label.start which returns
  // every point's coords + predicted/truth + the available class codes
  // + an optional {code: name} map persisted alongside the GeoPackage.
  interface LabelFeature {
    fid: number;
    x: number;
    y: number;
    predicted: number;
    truth: number;
    note: string;
  }
  const [labelFile, setLabelFile] = useState<string>("");
  const [labelFeatures, setLabelFeatures] = useState<LabelFeature[]>([]);
  const [labelClasses, setLabelClasses] = useState<number[]>([]);
  const [labelClassNames, setLabelClassNames] = useState<Record<string, string>>({});
  const [labelCrs, setLabelCrs] = useState<string>("EPSG:4326");
  const [labelIdx, setLabelIdx] = useState<number>(0);
  const [labelActive, setLabelActive] = useState<boolean>(false);
  const [labelNote, setLabelNote] = useState<string>("");

  const refreshLayers = async () => {
    const [r, v] = await Promise.all([
      invoke<{ layers: LayerInfo[] }>("layers.list_rasters"),
      invoke<{ layers: LayerInfo[] }>("layers.list_vectors"),
    ]);
    if (r.ok && r.result) setRasters(r.result.layers);
    if (v.ok && v.result) setVectors(v.result.layers);
  };
  useEffect(() => {
    refreshLayers();
  }, []);

  // Clear the canvas highlight marker when the panel unmounts (user
  // navigates away).  Otherwise the red cross hangs around forever.
  useEffect(() => {
    return () => {
      void invoke("accuracy.label.clear");
    };
  }, []);

  useEffect(() => {
    if (!vectorSrc) {
      setFields([]);
      return;
    }
    invoke<{ fields: string[] }>("layers.fields", { path: vectorSrc }).then((r) => {
      if (r.ok && r.result) {
        const fs = r.result.fields;
        setFields(fs);
        const guess = fs.find((n) =>
          ["class", "Class", "CLASS", "label", "category"].includes(n),
        );
        if (guess) setClassField(guess);
        else if (fs.length > 0) setClassField(fs[0]);
      }
    });
  }, [vectorSrc]);

  const pickOutput = async () => {
    const r = await invoke<{ path: string }>("dialog.save_file", {
      default: "terranova_accuracy.pdf",
      title: "Save accuracy report",
      filter: "PDF (*.pdf)",
    });
    if (r.ok && r.result?.path) setOutputPdf(r.result.path);
  };

  const run = async () => {
    if (!rasterSrc || !vectorSrc || !classField || !outputPdf) {
      setErr("Pick raster, vector, class field, and PDF path.");
      return;
    }
    setErr(null);
    setResult(null);
    setBusy(true);

    // Auto-derive an .xlsx path next to the PDF when the user opted in.
    const xlsxPath = emitXlsx
      ? outputPdf.replace(/\.pdf$/i, "") + ".xlsx"
      : null;

    const r = await invoke<{ job_id: string }>("accuracy.run", {
      raster_path: rasterSrc,
      vector_path: vectorSrc,
      class_field: classField,
      output_pdf: outputPdf,
      output_xlsx: xlsxPath,
    });
    if (r.ok && r.result?.job_id) {
      setJobId(r.result.job_id);
    } else {
      setBusy(false);
      setErr(r.error ?? "accuracy.run failed");
    }
  };

  /**
   * Sample validation points from the generator's raster pick.
   * Synchronous backend (sub-second on typical classification COGs),
   * so no QgsTask plumbing — but we still flip a `generating` flag so
   * the button visibly toggles to "Sampling…" while the bridge call
   * is in flight.
   */
  const generatePoints = async () => {
    setGenErr(null);
    setGenMsg(null);
    if (!genRasterSrc) {
      setGenErr("Pick a classified raster for the generator.");
      return;
    }
    if (!genOutPath) {
      setGenErr("Pick a 'Save to' path for the .gpkg output.");
      return;
    }
    setGenerating(true);
    const out = await invoke<{
      n_points: number;
      output_path: string;
      classes_sampled: number[];
    }>("accuracy.generate_points", {
      raster_path: genRasterSrc,
      out_path: genOutPath,
      strategy,
      n_total: nTotal,
      points_per_class: pointsPerClass,
    });
    setGenerating(false);
    if (!out.ok || !out.result) {
      setGenErr(out.error ?? "accuracy.generate_points failed");
      return;
    }
    setGenMsg(
      `Wrote ${out.result.n_points} points across ${out.result.classes_sampled.length} classes. ` +
        "Auto-loaded as a layer; jump into 'Label points' below to start.",
    );
    // Auto-fill the labelling file picker so the user can jump straight in.
    setLabelFile(out.result.output_path);
  };

  /** "Browse..." for the points-generator output path. */
  const pickGenOutPath = async () => {
    const r = await invoke<{ path: string }>("dialog.save_file", {
      default: `validation_points_${strategy}.gpkg`,
      title: "Save validation points",
      filter: "GeoPackage (*.gpkg)",
    });
    if (r.ok && r.result?.path) setGenOutPath(r.result.path);
  };

  // ----------------- labelling mode --------------------------------------
  const pickLabelFile = async () => {
    const r = await invoke<{ path: string }>("dialog.open_file", {
      title: "Pick a validation-points GeoPackage",
      filter: "GeoPackage (*.gpkg);;All files (*.*)",
    });
    if (r.ok && r.result?.path) setLabelFile(r.result.path);
  };

  const startLabelling = async () => {
    if (!labelFile) {
      setErr("Pick a validation-points file first (or generate one above).");
      return;
    }
    setErr(null);
    // The raster the points were sampled from is what defines pixel
    // size for the first-pan zoom — prefer the generator's pick if set
    // (most recent), else fall back to the report's raster.
    const rasterForLabelling = genRasterSrc || rasterSrc || null;
    const r = await invoke<{
      features: LabelFeature[];
      classes: number[];
      class_names: Record<string, string>;
      src_crs: string;
    }>("accuracy.label.start", {
      path: labelFile,
      raster_path: rasterForLabelling,
    });
    if (!r.ok || !r.result) {
      setErr(r.error ?? "could not load validation points");
      return;
    }
    setLabelFeatures(r.result.features);
    setLabelClasses(r.result.classes);
    setLabelClassNames(r.result.class_names || {});
    setLabelCrs(r.result.src_crs);
    // Jump to the first unlabelled point (truth == 0); fall back to 0
    // if every point already has a label (resume / re-check).
    const first = r.result.features.findIndex((f) => !f.truth);
    const idx = first >= 0 ? first : 0;
    setLabelIdx(idx);
    setLabelActive(true);
    setLabelNote(r.result.features[idx]?.note ?? "");
    // Fit zoom ONLY on first pan — gets the user to a sensible "I can
    // see a single pixel" view.  After that we pan without changing zoom
    // so they can adjust once and have it stick.
    panToIdx(
      idx,
      r.result.features,
      r.result.src_crs,
      rasterForLabelling,
      true,
    );
  };

  /**
   * Pan the canvas to the point at `i` and refresh the highlight marker.
   * `fitZoom` should be true ONLY on the first pan (zoom to ~40 raster
   * pixels around the point).  Subsequent calls keep whatever zoom the
   * user dialed in.
   */
  const panToIdx = (
    i: number,
    feats: LabelFeature[] = labelFeatures,
    crs: string = labelCrs,
    rasterPath: string | null = genRasterSrc || rasterSrc || null,
    fitZoom: boolean = false,
  ) => {
    const f = feats[i];
    if (!f) return;
    void invoke("accuracy.label.pan_to", {
      x: f.x,
      y: f.y,
      crs,
      fit_zoom: fitZoom,
      raster_path: rasterPath,
    });
  };

  /** Persist class names to the sidecar JSON next to the GeoPackage. */
  const saveClassNames = async (names: Record<string, string>) => {
    if (!labelFile) return;
    setLabelClassNames(names);
    await invoke("accuracy.label.set_class_names", {
      path: labelFile,
      names,
    });
  };

  /** Persist truth for the current point and step to a delta (+1, -1). */
  const labelStep = async (delta: number, picked: number | null) => {
    const cur = labelFeatures[labelIdx];
    if (!cur) return;
    if (picked !== null) {
      const r = await invoke("accuracy.label.update", {
        path: labelFile,
        fid: cur.fid,
        truth: picked,
        note: labelNote,
      });
      if (!r.ok) {
        setErr(r.error ?? "could not write truth");
        return;
      }
      // Reflect the change locally so the progress counter and the
      // 'first unlabelled' resume logic stay accurate.
      setLabelFeatures((prev) =>
        prev.map((p, i) =>
          i === labelIdx ? { ...p, truth: picked, note: labelNote } : p,
        ),
      );
    }
    const next = Math.max(0, Math.min(labelFeatures.length - 1, labelIdx + delta));
    if (next === labelIdx && delta !== 0) return;
    setLabelIdx(next);
    setLabelNote(labelFeatures[next]?.note ?? "");
    panToIdx(next);
  };

  const stopLabelling = () => {
    setLabelActive(false);
    void invoke("accuracy.label.clear");
  };

  // ----------------- compute-from-points ---------------------------------
  /**
   * Compute the accuracy report directly from the labelled points file.
   * Bypasses the vector-on-raster sampling step — the points already
   * have predicted (from the raster) and truth (from labelling) so we
   * just need to build the confusion matrix.
   *
   * Excel / PDF outputs are derived from a single user-picked stem so
   * both share the same base name.
   */
  const computeFromPoints = async (stem?: string) => {
    if (!labelFile) {
      setErr("Pick a labelled validation-points .gpkg first.");
      return;
    }
    setErr(null);
    setResult(null);
    setBusy(true);
    const pdfPath = stem ? stem.replace(/\.(pdf|xlsx)$/i, "") + ".pdf" : null;
    const xlsxPath = stem && emitXlsx ? stem.replace(/\.(pdf|xlsx)$/i, "") + ".xlsx" : null;
    const r = await invoke<{ job_id: string }>("accuracy.run_on_points", {
      points_path: labelFile,
      output_pdf: pdfPath,
      output_xlsx: xlsxPath,
    });
    if (r.ok && r.result?.job_id) {
      setJobId(r.result.job_id);
    } else {
      setBusy(false);
      setErr(r.error ?? "accuracy.run_on_points failed");
    }
  };

  /** "Compute & show metrics" — no file output, just the inline display. */
  const computeFromPointsInline = () => computeFromPoints(undefined);

  /** "Save as PDF…" — opens save dialog filtered to .pdf, writes PDF only. */
  const saveAsPdf = async () => {
    const r = await invoke<{ path: string }>("dialog.save_file", {
      default: "terranova_accuracy.pdf",
      title: "Save accuracy report as PDF",
      filter: "PDF (*.pdf)",
    });
    if (!r.ok || !r.result?.path) return;
    // Force PDF-only by passing the .pdf path and toggling Excel off.
    const stem = r.result.path.replace(/\.(pdf|xlsx)$/i, "") + ".pdf";
    void computeFromPointsExplicit(stem, false);
  };

  /** "Save as Excel…" — opens save dialog filtered to .xlsx, writes Excel only. */
  const saveAsExcel = async () => {
    const r = await invoke<{ path: string }>("dialog.save_file", {
      default: "terranova_accuracy.xlsx",
      title: "Save accuracy report as Excel",
      filter: "Excel workbook (*.xlsx)",
    });
    if (!r.ok || !r.result?.path) return;
    const stem = r.result.path.replace(/\.(pdf|xlsx)$/i, "") + ".xlsx";
    void computeFromPointsExplicit(stem, true, true);
  };

  /**
   * Internal: compute + save with explicit format choice.  `pdfOrXlsxPath`
   * is a single file path; `xlsxOnly` (true) skips writing PDF.
   */
  const computeFromPointsExplicit = async (
    targetPath: string,
    writeExcel: boolean,
    xlsxOnly: boolean = false,
  ) => {
    if (!labelFile) {
      setErr("Pick a labelled validation-points .gpkg first.");
      return;
    }
    setErr(null);
    setResult(null);
    setBusy(true);
    const stem = targetPath.replace(/\.(pdf|xlsx)$/i, "");
    const r = await invoke<{ job_id: string }>("accuracy.run_on_points", {
      points_path: labelFile,
      output_pdf: xlsxOnly ? null : stem + ".pdf",
      output_xlsx: writeExcel ? stem + ".xlsx" : null,
    });
    if (r.ok && r.result?.job_id) setJobId(r.result.job_id);
    else {
      setBusy(false);
      setErr(r.error ?? "accuracy.run_on_points failed");
    }
  };

  return (
    <section
      className="max-w-2xl"
      style={{ contain: "layout style" }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Accuracy report</h2>
        <button
          onClick={refreshLayers}
          className="text-xs text-fg-muted hover:text-fg"
        >
          Refresh layers ↻
        </button>
      </div>
      {/* Mode toggle — vector path (existing) vs points path (new). */}
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs text-fg-muted">Source</span>
        <div className="flex items-stretch bg-bg-2 border border-bg-2 rounded overflow-hidden">
          <button
            onClick={() => setMode("vector")}
            className={
              "px-3 py-1 text-xs border-r border-bg-2 " +
              (mode === "vector" ? "bg-accent text-white" : "hover:bg-bg-0")
            }
          >
            Use a validation vector
          </button>
          <button
            onClick={() => setMode("points")}
            className={
              "px-3 py-1 text-xs " +
              (mode === "points" ? "bg-accent text-white" : "hover:bg-bg-0")
            }
          >
            Generate &amp; label random points
          </button>
        </div>
      </div>

      <p className="text-fg-muted text-sm mb-4">
        {mode === "vector"
          ? "Samples the classified raster at every pixel covered by a held-out validation vector, computes confusion matrix / OA / κ / per-class metrics, renders a PDF (and optionally Excel)."
          : "Generates a random sample of points from a classified raster, walks you through labelling each one against the imagery, then computes OA / κ / per-class metrics directly from the labelled points — no separate validation vector needed."}
      </p>

      {mode === "vector" && (
      <div className="grid grid-cols-1 gap-3">
        <Field label="Classified raster">
          <Select
            value={rasterSrc}
            onChange={setRasterSrc}
            placeholder="— pick a raster layer —"
            options={[
              { value: "", label: "— pick a raster layer —" },
              ...rasters.map((l) => ({ value: l.source, label: l.name })),
            ]}
          />
        </Field>

        <Field label="Validation vector (held-out polygons / points)">
          <Select
            value={vectorSrc}
            onChange={setVectorSrc}
            placeholder="— pick a vector layer —"
            options={[
              { value: "", label: "— pick a vector layer —" },
              ...vectors.map((l) => ({ value: l.source, label: l.name })),
            ]}
          />
        </Field>

        <Field label="Class field on the validation layer">
          <Select
            value={classField}
            onChange={setClassField}
            disabled={!fields.length}
            placeholder={
              fields.length ? "— pick a field —" : "— pick a vector first —"
            }
            options={fields.map((f) => ({ value: f, label: f }))}
          />
        </Field>

        <Field label="Output PDF">
          <div className="flex gap-2">
            <input
              type="text"
              value={outputPdf}
              placeholder="(pick a path…)"
              onChange={(e) => setOutputPdf(e.target.value)}
              className="flex-1 bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono text-xs"
            />
            <button
              onClick={pickOutput}
              className="px-3 py-1 bg-bg-1 hover:bg-bg-2 border border-bg-2 rounded text-sm"
            >
              Browse…
            </button>
          </div>
          <label className="flex items-center gap-2 mt-1.5 text-xs text-fg-muted cursor-pointer">
            <input
              type="checkbox"
              checked={emitXlsx}
              onChange={(e) => setEmitXlsx(e.target.checked)}
            />
            Also export an Excel workbook (same path, .xlsx suffix)
          </label>
        </Field>
      </div>
      )}

      {mode === "points" && (
      <>
      {/* Generate validation points -------------------------------------- */}
      <div className="mt-5 bg-bg-1 border border-bg-2 rounded-md p-3">
        <h3 className="text-sm font-semibold mb-1">
          Generate validation points
        </h3>
        <p className="text-xs text-fg-muted mb-3">
          Sample points from a classified raster to use as a validation
          vector. The output .gpkg has a <code>predicted</code> column
          pre-filled from the raster — fill <code>truth</code> via the
          point-by-point pad below, or edit in QGIS directly.
        </p>

        <div className="grid grid-cols-1 gap-3">
          <Field
            label="Classified raster to sample from"
            hint="Stratified / equalized strategies need the class count from this raster — pick first."
          >
            <Select
              value={genRasterSrc}
              onChange={setGenRasterSrc}
              placeholder="— pick a raster layer —"
              options={[
                { value: "", label: "— pick a raster layer —" },
                ...rasters.map((l) => ({ value: l.source, label: l.name })),
              ]}
            />
            {genRasterSrc && (
              <span className="text-xs text-fg-muted/80 mt-0.5">
                {genClasses.length > 0
                  ? `Detected ${genClasses.length} class${genClasses.length === 1 ? "" : "es"}: ${genClasses.slice(0, 12).join(", ")}${genClasses.length > 12 ? "…" : ""}`
                  : "Probing classes…"}
              </span>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Strategy" hint={STRATEGY_HINTS[strategy]}>
              <Select
                value={strategy}
                onChange={(v) => setStrategy(v as SamplingStrategy)}
                options={(Object.keys(STRATEGY_LABELS) as SamplingStrategy[]).map(
                  (k) => ({ value: k, label: STRATEGY_LABELS[k] }),
                )}
              />
            </Field>
            {strategy === "equalized_stratified" ? (
              <Field
                label="Points per class"
                hint={
                  genClasses.length
                    ? `→ ${pointsPerClass * genClasses.length} points total`
                    : ""
                }
              >
                <input
                  type="number"
                  value={pointsPerClass}
                  min={2}
                  max={500}
                  onChange={(e) =>
                    setPointsPerClass(parseInt(e.target.value, 10) || 0)
                  }
                  className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono"
                />
              </Field>
            ) : (
              <Field
                label="Total points"
                hint={
                  strategy === "stratified" && genClasses.length
                    ? `≈ ${Math.round(nTotal / genClasses.length)} per class (proportional, with a floor)`
                    : ""
                }
              >
                <input
                  type="number"
                  value={nTotal}
                  min={10}
                  max={5000}
                  step={50}
                  onChange={(e) => setNTotal(parseInt(e.target.value, 10) || 0)}
                  className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono"
                />
              </Field>
            )}
          </div>

          <Field label="Save to">
            <div className="flex gap-2">
              <input
                type="text"
                value={genOutPath}
                placeholder="(pick a .gpkg path…)"
                onChange={(e) => setGenOutPath(e.target.value)}
                className="flex-1 bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono text-xs"
              />
              <button
                onClick={pickGenOutPath}
                className="px-3 py-1 bg-bg-1 hover:bg-bg-2 border border-bg-2 rounded text-sm"
              >
                Browse…
              </button>
            </div>
          </Field>
        </div>

        <div className="flex gap-2 mt-3 items-center">
          <button
            onClick={generatePoints}
            disabled={!genRasterSrc || !genOutPath || generating}
            className="px-3 py-1.5 bg-accent text-white rounded text-xs disabled:opacity-50"
          >
            {generating ? "Sampling…" : "Generate points"}
          </button>
          {genMsg && (
            <span className="text-xs text-fg-muted">{genMsg}</span>
          )}
        </div>
        {genErr && (
          <p className="text-danger text-xs mt-2">{genErr}</p>
        )}

        {/* Step 2: label.  Visually a sub-block inside this same section
            (separated by a thin divider) so the user reads it as
            'generate → then label'. */}
        <hr className="border-bg-2 my-4" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1">
          Step 2 — Label points
        </h4>
        <p className="text-xs text-fg-muted mb-3">
          Step through each point — the QGIS canvas pans to it, a red
          cross marks it, and you pick the actual ground-truth class.
          Auto-saves after every pick; close and resume any time.
          {labelFile && labelFile === genOutPath && (
            <span className="block mt-1 text-fg-muted/80">
              Using the file you just generated above.
            </span>
          )}
        </p>

        {!labelActive && (
          <>
            <Field label="Validation points file">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={labelFile}
                  placeholder="(generate above, or pick a .gpkg from disk)"
                  onChange={(e) => setLabelFile(e.target.value)}
                  className="flex-1 bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono text-xs"
                />
                <button
                  onClick={pickLabelFile}
                  className="px-3 py-1 bg-bg-1 hover:bg-bg-2 border border-bg-2 rounded text-sm"
                >
                  Browse…
                </button>
              </div>
            </Field>
            <button
              onClick={startLabelling}
              disabled={!labelFile}
              className="mt-3 px-3 py-1.5 bg-accent text-white rounded text-xs disabled:opacity-50"
            >
              Start labelling
            </button>
          </>
        )}

        {labelActive && labelFeatures[labelIdx] && (
          <LabellingPad
            features={labelFeatures}
            idx={labelIdx}
            classes={labelClasses}
            classNames={labelClassNames}
            onClassNamesChange={saveClassNames}
            note={labelNote}
            setNote={setLabelNote}
            onStep={(d, picked) => labelStep(d, picked)}
            onExit={stopLabelling}
          />
        )}

        {/* Step 3: Compute accuracy directly from the labelled points'
            predicted vs truth columns.  No vector-on-raster sampling
            needed — the confusion matrix raw data is right there. */}
        <hr className="border-bg-2 my-4" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1">
          Step 3 — Compute accuracy
        </h4>
        <p className="text-xs text-fg-muted mb-3">
          Builds the confusion matrix from the labelled points' <code>predicted</code>{" "}
          vs <code>truth</code>. Unlabelled points (where <code>truth = 0</code>)
          are skipped.
        </p>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={computeFromPointsInline}
            disabled={!labelFile || busy}
            className="px-3 py-1.5 bg-accent text-white rounded text-xs disabled:opacity-50"
          >
            {busy ? "Computing…" : "Compute & show metrics"}
          </button>
          <button
            onClick={saveAsPdf}
            disabled={!labelFile || busy}
            className="px-3 py-1.5 bg-bg-2 hover:bg-bg-0 border border-bg-2 rounded text-xs disabled:opacity-50"
          >
            Save as PDF…
          </button>
          <button
            onClick={saveAsExcel}
            disabled={!labelFile || busy}
            className="px-3 py-1.5 bg-bg-2 hover:bg-bg-0 border border-bg-2 rounded text-xs disabled:opacity-50"
          >
            Save as Excel…
          </button>
        </div>
      </div>
      </>
      )}

      {mode === "vector" && (
      <div className="flex gap-2 mt-4">
        <button
          onClick={run}
          disabled={busy}
          className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-50"
        >
          {busy ? "Running…" : "Generate report"}
        </button>
      </div>
      )}

      {err && <p className="text-danger text-sm mt-3">{err}</p>}

      <JobProgress
        jobId={jobId}
        onComplete={(r) => {
          setBusy(false);
          setResult(r as AccuracyResult);
        }}
        onFailed={(e) => {
          setBusy(false);
          setErr(e);
        }}
      />

      {result && (
        <div className="mt-4 bg-bg-1 border border-bg-2 rounded-md p-4 text-sm">
          <div className="grid grid-cols-3 gap-3">
            <Stat
              label="Overall accuracy"
              value={`${(result.overall_accuracy * 100).toFixed(1)}%`}
            />
            <Stat label="Kappa (κ)" value={result.kappa.toFixed(3)} />
            <Stat label="N samples" value={String(result.n_samples)} />
          </div>

          {result.report && result.report.class_labels.length > 0 && (
            <PerClassTable report={result.report} />
          )}

          {result.output_path && (
            <p className="text-fg-muted text-xs mt-3 font-mono break-all">
              {result.output_path}
            </p>
          )}
          {result.output_xlsx && (
            <p className="text-fg-muted text-xs mt-1 font-mono break-all">
              {result.output_xlsx}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------- */
/* Class-names editor — persists to the GPKG's sidecar JSON via the     */
/* labeling.set_class_names bridge action.                              */
/* -------------------------------------------------------------------- */
function ClassNamesEditor({
  classes,
  classNames,
  onChange,
}: {
  classes: number[];
  classNames: Record<string, string>;
  onChange(names: Record<string, string>): void;
}) {
  return (
    <div className="bg-bg-2 border border-bg-2 rounded p-2 mb-2">
      <p className="text-fg-muted text-xs mb-2">
        Optional. Names are saved alongside the points file and apply
        wherever a class code appears in the labelling pad.
      </p>
      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 items-center">
        {classes.map((c) => (
          <Fragment key={c}>
            <span className="text-xs font-mono text-fg-muted text-right pr-1">
              {c}
            </span>
            <input
              type="text"
              value={classNames[String(c)] ?? ""}
              placeholder={`e.g. "Built up" for class ${c}`}
              onChange={(e) => {
                const next = { ...classNames };
                if (e.target.value.trim()) next[String(c)] = e.target.value;
                else delete next[String(c)];
                onChange(next);
              }}
              className="bg-bg-1 border border-bg-2 rounded px-2 py-0.5 text-xs"
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Per-class metrics table — UA, PA, F1                                 */
/* -------------------------------------------------------------------- */
function PerClassTable({ report }: { report: ReportPayload }) {
  const fmt = (v: number | null) =>
    v === null || Number.isNaN(v) ? "—" : v.toFixed(3);
  return (
    <div className="mt-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1">
        Per-class metrics
      </h4>
      <table className="w-full text-xs font-mono">
        <thead className="text-fg-muted">
          <tr>
            <th className="text-left font-normal py-1">Class</th>
            <th className="text-right font-normal py-1" title="User's accuracy = diag / row total — when the classifier predicted this class, how often was it right?">
              UA
            </th>
            <th className="text-right font-normal py-1" title="Producer's accuracy = diag / col total — when the truth was this class, how often did the classifier find it?">
              PA
            </th>
            <th className="text-right font-normal py-1">F1</th>
          </tr>
        </thead>
        <tbody>
          {report.class_labels.map((cls, i) => (
            <tr key={cls} className="border-t border-bg-2">
              <td className="py-1">{cls}</td>
              <td className="text-right py-1">{fmt(report.users_accuracy[i])}</td>
              <td className="text-right py-1">{fmt(report.producers_accuracy[i])}</td>
              <td className="text-right py-1">{fmt(report.f1_per_class[i])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-fg-muted/70 text-xs mt-1">
        UA = user's accuracy (1 − commission error).  PA = producer's
        accuracy (1 − omission error).
      </p>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}
function Field({ label, hint, children }: FieldProps) {
  // Same rule as the Classify panel's Field: short hints inline next to
  // the label, long ones (>=80 chars) wrap as a block below the input.
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="text-lg font-semibold text-fg font-mono">{value}</div>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Point-by-point labelling pad                                         */
/* -------------------------------------------------------------------- */

interface LabellingPadProps {
  features: Array<{ fid: number; predicted: number; truth: number }>;
  idx: number;
  classes: number[];
  classNames: Record<string, string>;
  onClassNamesChange(names: Record<string, string>): void;
  note: string;
  setNote(s: string): void;
  /** delta is +1/-1/0 ; picked is the chosen class code, or null to skip. */
  onStep(delta: number, picked: number | null): void;
  onExit(): void;
}

function LabellingPad({
  features,
  idx,
  classes,
  classNames,
  onClassNamesChange,
  note,
  setNote,
  onStep,
  onExit,
}: LabellingPadProps) {
  const cur = features[idx];
  const labelled = features.filter((f) => f.truth).length;
  const pct = features.length
    ? Math.round((labelled / features.length) * 100)
    : 0;

  // Pre-fill the "true class" picker with the existing truth (resume)
  // or the predicted class (first pass) so a confirmed-correct pixel is
  // one Enter away from being labelled.
  const initialPick = cur.truth || cur.predicted;
  const [picked, setPicked] = useState<number>(initialPick);
  // Re-sync when idx changes — useState only initialises once.
  useEffect(() => {
    setPicked(cur.truth || cur.predicted);
  }, [idx, cur.truth, cur.predicted]);

  // Render a class code as its user-set name if available, otherwise
  // the bare numeric code.  Used in the chips, the truth/predicted
  // display, and the class-names editor below.
  const nameFor = (code: number): string => {
    const n = classNames[String(code)];
    return n && n.trim() ? n : String(code);
  };

  const [namesOpen, setNamesOpen] = useState(false);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-sm">
          <span className="font-semibold">
            Point {idx + 1} / {features.length}
          </span>
          <span className="text-fg-muted ml-2">
            · {labelled} labelled ({pct}%)
          </span>
        </div>
        <button
          onClick={onExit}
          className="text-xs text-fg-muted hover:text-fg"
          title="Stop labelling.  Progress is already saved to the file."
        >
          Exit ✕
        </button>
      </div>

      <div className="h-1 bg-bg-2 rounded overflow-hidden mb-3">
        <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>

      {/* Single combined display: 'Truth (predicted: <name>)'.  Truth
          renders the existing saved value OR '—' if the user hasn't
          saved one for this point yet.  Predicted comes from the
          raster sample done at generation time. */}
      <div className="text-sm">
        <span className="text-fg-muted">Truth: </span>
        <span className="font-semibold">
          {cur.truth ? (
            nameFor(cur.truth)
          ) : (
            <span className="text-fg-muted/60">—</span>
          )}
        </span>
        <span className="text-fg-muted">
          {"  (predicted: "}
          <span className="text-fg">{nameFor(cur.predicted)}</span>
          {")"}
        </span>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-fg-muted">True class</span>
          <button
            onClick={() => setNamesOpen((v) => !v)}
            className="text-xs text-fg-muted hover:text-fg"
            title="Set readable names for each class code"
          >
            {namesOpen ? "Hide names ↑" : "Edit class names ↓"}
          </button>
        </div>

        {namesOpen && (
          <ClassNamesEditor
            classes={classes}
            classNames={classNames}
            onChange={onClassNamesChange}
          />
        )}

        {/* If <=10 classes, render as a row of clickable chips.  More
            classes → fall back to a dropdown.  Chips are faster for the
            common case. */}
        {classes.length <= 10 ? (
          <div className="flex flex-wrap gap-1.5">
            {classes.map((c) => {
              const active = c === picked;
              return (
                <button
                  key={c}
                  onClick={() => setPicked(c)}
                  className={
                    "px-2.5 py-1 rounded text-xs border " +
                    (active
                      ? "bg-accent text-white border-accent"
                      : "bg-bg-2 hover:bg-bg-0 border-bg-2")
                  }
                >
                  {nameFor(c)}
                </button>
              );
            })}
          </div>
        ) : (
          <Select
            value={String(picked)}
            onChange={(v) => setPicked(parseInt(v, 10) || 0)}
            options={classes.map((c) => ({
              value: String(c),
              label: nameFor(c),
            }))}
          />
        )}
      </div>

      <label className="flex flex-col gap-1 text-xs text-fg-muted mt-3">
        Note (optional)
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. 'cloud shadow', 'mixed pixel', etc."
          className="bg-bg-1 border border-bg-2 rounded px-2 py-1"
        />
      </label>

      <div className="flex gap-2 mt-4">
        <button
          onClick={() => onStep(-1, null)}
          disabled={idx === 0}
          className="px-2.5 py-1 bg-bg-2 hover:bg-bg-0 border border-bg-2 rounded text-xs disabled:opacity-40"
        >
          ← Previous
        </button>
        <button
          onClick={() => onStep(+1, null)}
          disabled={idx >= features.length - 1}
          className="px-2.5 py-1 bg-bg-2 hover:bg-bg-0 border border-bg-2 rounded text-xs disabled:opacity-40"
          title="Skip without saving"
        >
          Skip →
        </button>
        <button
          onClick={() => onStep(+1, picked)}
          disabled={idx >= features.length - 1}
          className="ml-auto px-3 py-1 bg-accent text-white rounded text-xs disabled:opacity-50"
        >
          Save & next →
        </button>
        <button
          onClick={() => onStep(0, picked)}
          className="px-2.5 py-1 bg-bg-2 hover:bg-bg-0 border border-bg-2 rounded text-xs"
          title="Save without advancing (useful on the last point)"
        >
          Save
        </button>
      </div>
    </div>
  );
}
