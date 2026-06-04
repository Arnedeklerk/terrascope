# Changelog

All notable changes to Terranova are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] — 2026-06

### Fixed

- QGIS 3.x (PyQt5) compatibility. The dock and the native catalogue
  dialog used PyQt6-only nested enum syntax (e.g.
  `Qt.DockWidgetArea.RightDockWidgetArea`) in a few unguarded places,
  which raised `AttributeError` on QGIS 3.x. Added a small binding
  shim (`ui/qt_compat.enum_member`) and routed those sites through it,
  so the plugin loads on the 3.40 LTR series as well as QGIS 4.x. Also
  corrected a latent pen-style fallback that had the PyQt5/PyQt6 order
  reversed.

### Changed

- The plugin's external Python dependencies (pystac-client, odc-stac,
  rasterio, rioxarray, scikit-learn, reportlab, and the optional
  lightgbm / xgboost / torch / terratorch / segment-geospatial /
  openpyxl) and how to install them are now declared in the About
  metadata, per the plugins.qgis.org publishing guidelines.
- The packaged plugin ships only runtime files — the web dev tooling
  (serve scripts, ESLint/Vite/TS configs) and the TypeScript source are
  excluded from the zip via `.gitattributes export-ignore`. Minor
  flake8 cleanups (unused import/variable, ambiguous name).

## [1.0.1] — 2026-06

### Added

- Beta-features toggle in the header. Time-series, SAM, foundation
  models, and CDSE sign-in are hidden by default; tick "Beta features"
  to reveal them.
- Catalogue composite is now discoverable: a "Create composite from
  this search" checkbox under the date range, with a max-images cap so
  you can bound data usage.
- Accuracy panel split into two modes — "Use a validation vector" and
  "Generate & label random points". The points mode includes an
  interactive labelling pad (canvas pans + zooms to each point,
  editable class names) and computes the confusion matrix straight
  from the labelled points; metrics show inline (OA as a percentage)
  and export to PDF + Excel.

### Changed

- Dropdowns across Classify / Accuracy / Catalogue use a lightweight
  custom component instead of native `<select>` — fixes the
  slow-expanding white popup and improves responsiveness on lower-spec
  and HiDPI machines.

### Fixed

- AOI rectangle now persists on the embedded map after you draw it.
- Overall accuracy and per-class user's / producer's accuracy render
  as percentages in the PDF and Excel reports.
- Plugin package no longer bundles `node_modules` or TypeScript source.

## [1.0.0] — 2026-05

First public release.

### Added

- **Catalogue search.** STAC client for Planetary Computer, Earth Search,
  and CDSE. Embedded interactive Leaflet map with drag-to-draw or
  type-in AOI, OpenStreetMap and Esri satellite basemaps, scene-footprint
  overlay with colour-coded multi-select.
- **Download and composite.** Multi-select batch download of Sentinel-2
  scenes as Cloud-Optimised GeoTIFFs. Optional AOI clip. Per-pixel mean
  or median temporal composite from a date range, capped at a user-set
  maximum number of images.
- **Supervised classification.** Eight classifiers (Random Forest, Extra
  Trees, Gradient Boosting, LightGBM, XGBoost, KNN, Logistic Regression,
  MLP), each with a short pros/cons description in the panel. Train on
  polygon or point training data, predict to a labelled COG, cross-
  validated by default.
- **Unsupervised classification.** K-Means and ISODATA on a random
  subsample of the raster's pixels; output is a labelled COG identical
  in shape to the supervised path.
- **Accuracy assessment.** Two flows: validation-vector mode (sample
  the classified raster at every pixel covered by a labelled vector)
  and random-points mode (generate random / stratified / equalized-
  stratified validation points, step through each one in an interactive
  pad that auto-pans and zooms-to-pixel, persist labels and class
  names alongside the points file). Both produce a PDF report plus an
  optional Excel workbook with confusion matrix, OA, kappa, and per-
  class user's / producer's / F1.
- **Time-series change detection** (beta). Per-pixel CuSum, BFAST, and
  LandTrendr on Sentinel-2 cubes. Break-index + magnitude rasters,
  optional MP4 animation of the index over time.
- **SAM segmentation** (beta). Text and point prompts via segment-
  geospatial; map-click point picking from inside the dock.
- **Foundation-model fine-tune scaffolding** (beta). Prithvi-EO-2.0,
  Clay, and TerraMind via TerraTorch, with ONNX export of the trained
  checkpoint.
- **CDSE OAuth sign-in** (beta). Device-code flow.
- **Dual UI.** Native Qt dialogs in `ui/dialogs/` (compatibility surface
  for QGIS Standalone Windows without QtWebEngine) and a React-in-
  QWebEngine dock with the embedded map (primary surface).
- **Processing toolbox.** NDVI, NDWI, NDMI, NBR, NDSI, majority filter,
  sieve algorithms.
- **CLI.** `terranova` script for headless use of the core operations
  (`ndvi`, `index`, `search-s2`, `accuracy-report`, `validate-cog`).
- **Documentation.** MkDocs site under `docs/`, landing page under
  `web/`, both published to GitHub Pages on every push to `main`.

[1.0.2]: https://github.com/TerranovaEO/terranova/releases/tag/v1.0.2
[1.0.1]: https://github.com/TerranovaEO/terranova/releases/tag/v1.0.1
[1.0.0]: https://github.com/TerranovaEO/terranova/releases/tag/v1.0.0
