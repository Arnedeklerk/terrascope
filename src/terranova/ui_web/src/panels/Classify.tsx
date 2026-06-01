import { useEffect, useState } from "react";
import { invoke } from "../bridge";
import { JobProgress } from "./JobProgress";
import { Select } from "./Select";

/**
 * Classify scene — supervised + unsupervised flows behind a top-level
 * mode toggle.
 *
 * Supervised (default): pick input raster, training vector (from loaded
 * layers or a file on disk), class field, classifier, hyperparameters,
 * output path.  Kicks off classify.run with mode=supervised.
 *
 * Unsupervised: pick input raster, choose K-Means or ISODATA, target
 * cluster count, max iterations, output path.  No training data needed
 * — the clusterer fits on a random subsample of raster pixels.
 *
 * Both modes stream task.progress / task.complete / task.failed events
 * back through the same <JobProgress />.
 */

type Mode = "supervised" | "unsupervised";

interface LayerInfo {
  name: string;
  source: string;
}

const CLASSIFIERS: Array<{ label: string; value: string; hint: string }> = [
  {
    label: "Random Forest",
    value: "random_forest",
    hint: "Ensemble of decision trees on bootstrap samples with random feature subsets. Robust to noisy bands, handles non-linear class boundaries, low tuning effort. Slower than LightGBM/XGBoost on large rasters. Good first choice.",
  },
  {
    label: "Extra Trees",
    value: "extra_trees",
    hint: "Like Random Forest but splits use random thresholds instead of the best ones. Trains faster, slightly higher variance. Sometimes generalises better when training polygons have noisy edges.",
  },
  {
    label: "Gradient Boosting",
    value: "gradient_boosting",
    hint: "Builds trees sequentially, each correcting the previous one's errors. Usually higher accuracy than RF; more tuning-sensitive and easier to overfit on small training sets.",
  },
  {
    label: "LightGBM",
    value: "lightgbm",
    hint: "Microsoft's histogram-based gradient boosting — much faster than scikit-learn's gradient boosting and typically the top accuracy on tabular data. Needs a sensible learning rate + n_estimators combo.",
  },
  {
    label: "XGBoost",
    value: "xgboost",
    hint: "Mature gradient boosting with strong regularisation. Very competitive accuracy, slightly slower than LightGBM. The industry standard for tabular-data ML competitions.",
  },
  {
    label: "K-Nearest Neighbours",
    value: "knn",
    hint: "Predicts each pixel from the K nearest training samples in band space — no real 'training', it just memorises. Slow at inference, very sensitive to band scaling. Useful as a baseline; rarely the best choice on imagery.",
  },
  {
    label: "Logistic Regression",
    value: "logistic_regression",
    hint: "Linear model with a softmax output per class. Fast and interpretable but low capacity — works when classes are roughly linearly separable in band space, struggles with complex spectral mixtures.",
  },
  {
    label: "Multi-layer Perceptron",
    value: "mlp",
    hint: "Small feedforward neural network. Can capture non-linear band relationships; needs more training pixels than tree methods to outperform them and is sensitive to band scaling. Slower training on the kind of tabular data we have here.",
  },
];

const UNSUPERVISED_ALGS: Array<{ label: string; value: string; hint: string }> = [
  {
    label: "K-Means (nearest centroid)",
    value: "kmeans",
    hint: "Iteratively assigns pixels to K cluster centres then updates the centres to be the mean of their members. Fixed K (no auto-adjustment), fast, deterministic given a seed. Best when you have a reasonable guess at the right number of classes.",
  },
  {
    label: "ISODATA",
    value: "isodata",
    hint: "K-Means with iterative split + merge: splits high-variance clusters (along the band of max stdev) and merges centroid pairs that are too close. Final cluster count adapts to the data — set the target as a starting point, expect the result to differ.",
  },
];

export function Classify() {
  const [mode, setMode] = useState<Mode>("supervised");

  const [rasters, setRasters] = useState<LayerInfo[]>([]);
  const [vectors, setVectors] = useState<LayerInfo[]>([]);
  const [fields, setFields] = useState<string[]>([]);

  const [rasterSrc, setRasterSrc] = useState<string>("");
  const [vectorSrc, setVectorSrc] = useState<string>("");
  const [classField, setClassField] = useState<string>("");
  const [classifier, setClassifier] = useState("random_forest");
  const [nEstimators, setNEstimators] = useState(300);
  const [cvFolds, setCvFolds] = useState(5);
  const [outputPath, setOutputPath] = useState<string>("");

  // Unsupervised-only fields
  const [algorithm, setAlgorithm] = useState("kmeans");
  const [nClusters, setNClusters] = useState(6);
  const [maxIter, setMaxIter] = useState(50);

  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Initial + refresh of layer lists.
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

  // Refresh field list when the vector layer changes.
  useEffect(() => {
    if (!vectorSrc) {
      setFields([]);
      return;
    }
    invoke<{ fields: string[] }>("layers.fields", { path: vectorSrc }).then((r) => {
      if (r.ok && r.result) {
        const fs = r.result.fields;
        setFields(fs);
        // Best-guess default.
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
      default:
        mode === "supervised"
          ? "terranova_classification.tif"
          : "terranova_clusters.tif",
      title:
        mode === "supervised" ? "Save classified COG" : "Save clustered COG",
      filter: "Cloud-Optimised GeoTIFF (*.tif)",
    });
    if (r.ok && r.result?.path) setOutputPath(r.result.path);
  };

  /**
   * Browse for a training vector file on disk without having to load it
   * as a QGIS layer first.  The picked path is added to the dropdown
   * with a "(file)" prefix so the user can see it's a one-shot pick,
   * and selected automatically.  Fields refresh via the existing
   * useEffect on vectorSrc.
   */
  const pickVectorFile = async () => {
    const r = await invoke<{ path: string }>("dialog.open_file", {
      title: "Pick a training vector file",
      filter:
        "Vector files (*.gpkg *.shp *.geojson *.json *.kml *.gpx);;All files (*.*)",
    });
    if (!r.ok || !r.result?.path) return;
    const path = r.result.path;
    const name = path.split(/[/\\]/).pop() || path;
    setVectors((prev) =>
      prev.some((v) => v.source === path)
        ? prev
        : [...prev, { name: `(file) ${name}`, source: path }],
    );
    setVectorSrc(path);
  };

  const run = async () => {
    if (!rasterSrc || !outputPath) {
      setErr("Pick an input raster and an output path.");
      return;
    }
    if (mode === "supervised" && (!vectorSrc || !classField)) {
      setErr("Supervised mode needs a training vector + class field.");
      return;
    }
    if (mode === "unsupervised" && nClusters < 2) {
      setErr("At least 2 clusters required.");
      return;
    }
    setErr(null);
    setBusy(true);
    setJobId(null);

    const payload =
      mode === "supervised"
        ? {
            mode,
            raster_path: rasterSrc,
            vector_path: vectorSrc,
            class_field: classField,
            classifier,
            n_estimators: nEstimators,
            cv_folds: cvFolds,
            output_path: outputPath,
          }
        : {
            mode,
            raster_path: rasterSrc,
            output_path: outputPath,
            algorithm,
            n_clusters: nClusters,
            max_iter: maxIter,
          };

    const r = await invoke<{ job_id: string }>("classify.run", payload);
    if (r.ok && r.result?.job_id) {
      setJobId(r.result.job_id);
    } else {
      setBusy(false);
      setErr(r.error ?? "classify.run failed");
    }
  };

  return (
    <section className="max-w-2xl">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Classify scene</h2>
        <button
          onClick={refreshLayers}
          className="text-xs text-fg-muted hover:text-fg"
        >
          Refresh layers ↻
        </button>
      </div>
      {/* Mode toggle — supervised (default) needs labelled training
          polygons; unsupervised clusters pixels with no labels. */}
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs text-fg-muted">Mode</span>
        <div className="flex items-stretch bg-bg-2 border border-bg-2 rounded overflow-hidden">
          <button
            onClick={() => setMode("supervised")}
            className={
              "px-3 py-1 text-xs border-r border-bg-2 " +
              (mode === "supervised"
                ? "bg-accent text-white"
                : "hover:bg-bg-0")
            }
          >
            Supervised
          </button>
          <button
            onClick={() => setMode("unsupervised")}
            className={
              "px-3 py-1 text-xs " +
              (mode === "unsupervised"
                ? "bg-accent text-white"
                : "hover:bg-bg-0")
            }
          >
            Unsupervised
          </button>
        </div>
      </div>

      <p className="text-fg-muted text-sm mb-4">
        {mode === "supervised"
          ? "Trains a classifier on every pixel covered by your training polygons and applies it to the input raster.  Open the Log Messages panel for training-set diagnostics as the task runs."
          : "Clusters the raster's pixels into a chosen number of classes without any labelled training data.  K-Means uses fixed-K nearest-centroid assignment; ISODATA also iteratively splits high-variance clusters and merges close ones, so the final cluster count can differ from your target."}
      </p>

      <div className="grid grid-cols-1 gap-3">
        <Field label="Input raster">
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

        {/* SUPERVISED ----------------------------------------------------- */}
        {mode === "supervised" && (
          <>
            <Field
              label="Training vector (polygons / points)"
              hint="Pick a loaded layer, or Browse to a file on disk (.gpkg, .shp, .geojson…)"
            >
              <div className="flex gap-2">
                <Select
                  value={vectorSrc}
                  onChange={setVectorSrc}
                  placeholder="— pick a vector layer —"
                  className="flex-1"
                  options={[
                    { value: "", label: "— pick a vector layer —" },
                    ...vectors.map((l) => ({ value: l.source, label: l.name })),
                  ]}
                />
                <button
                  onClick={pickVectorFile}
                  className="px-3 py-1 bg-bg-1 hover:bg-bg-2 border border-bg-2 rounded text-sm whitespace-nowrap"
                  title="Pick a vector file from disk; no need to load it as a layer first"
                >
                  Browse…
                </button>
              </div>
            </Field>

            <Field label="Class field on the vector layer">
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

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Classifier"
                hint={
                  CLASSIFIERS.find((c) => c.value === classifier)?.hint ?? ""
                }
              >
                <Select
                  value={classifier}
                  onChange={setClassifier}
                  options={CLASSIFIERS.map((c) => ({
                    value: c.value,
                    label: c.label,
                  }))}
                />
              </Field>
              <Field
                label="Trees / boosting rounds"
                hint="Ensemble size — not the training-sample count.  100–500 is the sweet spot."
              >
                <input
                  type="number"
                  value={nEstimators}
                  min={10}
                  max={2000}
                  step={50}
                  onChange={(e) => setNEstimators(parseInt(e.target.value, 10) || 0)}
                  className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono"
                />
              </Field>

              <Field label="Cross-validation folds">
                <input
                  type="number"
                  value={cvFolds}
                  min={2}
                  max={10}
                  onChange={(e) => setCvFolds(parseInt(e.target.value, 10) || 0)}
                  className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono"
                />
              </Field>
            </div>
          </>
        )}

        {/* UNSUPERVISED --------------------------------------------------- */}
        {mode === "unsupervised" && (
          <>
            <Field
              label="Algorithm"
              hint={
                UNSUPERVISED_ALGS.find((a) => a.value === algorithm)?.hint ?? ""
              }
            >
              <Select
                value={algorithm}
                onChange={setAlgorithm}
                options={UNSUPERVISED_ALGS.map((a) => ({
                  value: a.value,
                  label: a.label,
                }))}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field
                label={
                  algorithm === "isodata"
                    ? "Target clusters (final K may differ)"
                    : "Number of clusters (K)"
                }
              >
                <input
                  type="number"
                  value={nClusters}
                  min={2}
                  max={64}
                  onChange={(e) =>
                    setNClusters(parseInt(e.target.value, 10) || 0)
                  }
                  className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono"
                />
              </Field>
              <Field
                label="Max iterations"
                hint="ISODATA needs more iterations to converge through splits/merges; K-Means usually stabilises in <30."
              >
                <input
                  type="number"
                  value={maxIter}
                  min={5}
                  max={500}
                  step={5}
                  onChange={(e) =>
                    setMaxIter(parseInt(e.target.value, 10) || 0)
                  }
                  className="w-full bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono"
                />
              </Field>
            </div>
          </>
        )}

        <Field label="Output COG">
          <div className="flex gap-2">
            <input
              type="text"
              value={outputPath}
              placeholder="(pick a path…)"
              onChange={(e) => setOutputPath(e.target.value)}
              className="flex-1 bg-bg-1 border border-bg-2 rounded px-2 py-1 font-mono text-xs"
            />
            <button
              onClick={pickOutput}
              className="px-3 py-1 bg-bg-1 hover:bg-bg-2 border border-bg-2 rounded text-sm"
            >
              Browse…
            </button>
          </div>
        </Field>
      </div>

      <div className="flex gap-2 mt-4">
        <button
          onClick={run}
          disabled={busy}
          className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-50"
        >
          {busy
            ? "Running…"
            : mode === "supervised"
              ? "Train + classify"
              : "Cluster"}
        </button>
      </div>

      {err && <p className="text-danger text-sm mt-3">{err}</p>}

      <JobProgress
        jobId={jobId}
        onComplete={() => setBusy(false)}
        onFailed={(e) => {
          setBusy(false);
          setErr(e);
        }}
      />
    </section>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}
function Field({ label, hint, children }: FieldProps) {
  // Short hints (<80 chars) stay inline next to the label as before.
  // Longer ones — like the 2-4 sentence classifier descriptions — go
  // below the input as a block so they wrap cleanly without making the
  // label row two lines tall.
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
