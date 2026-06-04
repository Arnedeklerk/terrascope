# Terranova

> Earth observation for QGIS.

A modern QGIS plugin (**4.0+**) for STAC search, classification, accuracy reporting, and time-series change detection. Built on a STAC-first, COG / xarray pipeline with native Qt dialogs *and* a React-in-QWebEngine dock with an embedded interactive Leaflet map for AOI picking and footprint inspection.

> **QGIS 4.x only.** Terranova is built on PyQt6 and QtWebEngine and targets QGIS 4.0 or newer. It is not supported on the QGIS 3.x / PyQt5 LTR series.

**Status:** experimental — usable end-to-end for catalogue search + classification + change detection, but expect rough edges.

## Authors

- Cole Battell
- Arné de Klerk — KnetMiner / Rothamsted Research

## Why

The Semi-Automatic Classification Plugin (SCP) is the de-facto QGIS plugin for supervised classification, with 1.15 M+ cumulative downloads and a decade of feature accretion. But its UX has not been redesigned since 2016, its install path is fragile, and its classifier stack is sklearn-era. Terranova replaces it with:

- **STAC + COG everywhere.** Search Planetary Computer, Earth Search, and CDSE; build lazy xarray cubes without scene-by-scene download.
- **Foundation models.** Prithvi-EO-2.0, Clay v1.5, TerraMind, SAM 3 — via [TerraTorch](https://github.com/IBM/terratorch) and segment-geospatial.
- **Time-series.** BFAST, LandTrendr, CCDC running per-pixel on Zarr cubes.
- **Modern UI.** Command palette, wizards, dark mode, embedded React via QtWebEngine (QGIS 4.x / PyQt6).

## Architecture

Three layers, hard-separated:

```
UI (PyQt6 + qfluentwidgets  ↔  React 18 + Vite in QWebEngineView)
       │
Controllers (QgsTask, layer plumbing)
       │
Domain (pure Python — no qgis.* imports)
       │
Infra (rasterio, odc-stac, pystac-client, scikit-learn, onnxruntime, terratorch, ...)
```

See [docs/architecture.md](docs/architecture.md) for the full diagram.

## Quickstart (developer)

```bash
# Clone and install dev deps (Python 3.10–3.12)
git clone https://github.com/TerranovaEO/terranova
cd terranova
uv sync --all-extras --dev

# Build the React panel
make ui-build

# Deploy into your QGIS profile and launch QGIS
make deploy
```

End-user installs go via Plugins → Manage and Install → Search "Terranova" (once published to plugins.qgis.org).

## Coming from SCP?

See [docs/scp_migration.md](docs/scp_migration.md) — one-page cheat-sheet mapping every SCP concept to its Terranova equivalent.

## Licence

[GPL-3.0-or-later](LICENSE). Distributed via the official QGIS plugins page.

## Privacy

See [PRIVACY.md](PRIVACY.md). Telemetry is opt-in and minimal.
