# Terranova

> Earth observation for QGIS.

A modern QGIS 4.0+ plugin for STAC catalogue search, classification, accuracy assessment, and time-series change detection. (QGIS 4.x only — built on PyQt6 / QtWebEngine.)

## Why Terranova

The Semi-Automatic Classification Plugin (SCP) has been the de-facto QGIS plugin for supervised classification for over a decade. Its scope is unmatched, but its UX has not been redesigned since 2016 and its classifier stack is sklearn-era. Terranova keeps SCP's surface area and adds:

- **STAC + COG everywhere.** Search Planetary Computer, Earth Search, and CDSE; build lazy xarray cubes without scene-by-scene download.
- **Modern UI.** Command palette, embedded interactive Leaflet map for AOI picking and footprint preview, dark mode, dock-based React panels via QtWebEngine.
- **Both classical and deep learning.** Random Forest / LightGBM / XGBoost end-to-end; Prithvi, Clay, and SAM via TerraTorch / segment-geospatial behind a beta-features toggle.
- **Time-series.** BFAST, LandTrendr, CuSum running per-pixel on Sentinel-2 cubes.

## Get started

- [Quickstart](quickstart.md) — install and run a first search.
- [Architecture](architecture.md) — how the three layers fit together.
- Workflows: [Classification](workflows/classification.md) · [Time-series](workflows/timeseries.md) · [SAM segmentation](workflows/sam.md).

## Licence

[GPL-3.0-or-later](https://www.gnu.org/licenses/gpl-3.0.html).
