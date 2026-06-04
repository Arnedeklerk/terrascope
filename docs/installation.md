# Installation

## Requirements

- **QGIS** 4.0 or newer. Terranova is built on PyQt6 / QtWebEngine and is not supported on the QGIS 3.x (PyQt5) series.
- **Python** 3.11 or 3.12 (whichever your QGIS bundles).
- **Operating system**: Windows 10/11, macOS 12+, or any Linux that ships QGIS 4.x.

GPU acceleration for the foundation-model path needs a CUDA-capable NVIDIA card with ≥ 8 GB VRAM (Clay) or ≥ 16 GB (Prithvi-EO-2.0 600 M).

## End user — Plugins Manager

Once Terranova is published to plugins.qgis.org:

1. **Plugins → Manage and Install Plugins → All**.
2. Search for **Terranova**, click **Install Plugin**.
3. Toggle the toolbar icon to open the dock.

That's the supported install path; everything else below is for developers.

## Developer — from source

```bash
git clone https://github.com/terranova-rs/terranova
cd terranova

# All deps (uv recommended; pip works too)
uv sync --all-extras --dev
# or:    pip install -e .[dev,ml,gpu,timeseries]

# Build the embedded web panel
make ui-build

# Symlink into your QGIS profile and (re)launch QGIS
make deploy
```

Different OSes resolve the QGIS profile directory differently — the Makefile picks the right one based on `OS` / `uname`. Override with `PROFILE_DIR=...` if your profile lives somewhere unusual.

## Windows — installing into QGIS's Python in one line

The most common path on Windows is to install into the QGIS-bundled Python.
Open the **OSGeo4W Shell** from the Start menu (not regular PowerShell — this
one has QGIS's Python on PATH) and run:

```cmd
python -m pip install -e "C:/CODE/GIS/terranova[timeseries]"
```

That's it.  Pulls the package + every base dependency from `pyproject.toml`
+ the time-series extras in one shot.  Add `[ml]` if you want SAM and
foundation-model fine-tuning (warning: pulls multi-GB `torch` + `terratorch`):

```cmd
python -m pip install -e "C:/CODE/GIS/terranova[timeseries,ml]"
```

**Do not** pass `--no-deps` — that skips dependency resolution and you'll
hit `ModuleNotFoundError: rioxarray` (and similar) once the dialogs try to
import them.

## Optional dependency groups

| Group | Install | What it unlocks |
|-------|---------|-----------------|
| `[ml]` | `pip install -e .[ml]` | Foundation models (Prithvi, Clay, TerraMind), SAM 3, ONNX Runtime, SHAP, Optuna, LightGBM, XGBoost |
| `[gpu]` | `pip install -e .[gpu]` | `onnxruntime-gpu` for CUDA inference |
| `[timeseries]` | `pip install -e .[timeseries]` | BFAST, Zarr, dask, MP4 export |
| `[dev]` | `pip install -e .[dev]` | ruff, mypy, pytest, pre-commit, mkdocs-material, qgis-plugin-ci |

## Troubleshooting

### "Web bundle not found"

The dock loads but says the React bundle is missing. Run `make ui-build` in the repo root.

### "QtWebEngine is not available"

Older or distro-packaged QGIS builds sometimes ship without `python3-pyqtwebengine`:

```bash
# Debian / Ubuntu
sudo apt install python3-pyqtwebengine

# Fedora
sudo dnf install qgis qt5-qtwebengine
```

Terranova degrades gracefully without QtWebEngine — native dialogs and Processing algorithms still work, but the React panel won't render.

### `ModuleNotFoundError` for rasterio / pystac-client

These live in QGIS's bundled Python on macOS and Windows. From the QGIS Python console:

```python
import subprocess, sys
subprocess.check_call([sys.executable, "-m", "pip", "install", "rasterio", "pystac-client"])
```

On Linux, prefer your system package manager (e.g. `apt install python3-rasterio`).

### Anaconda warning

If you launched QGIS from an Anaconda environment, deps you install with `pip` may end up in the wrong site-packages and confuse the plugin. Either install QGIS via your system package manager (recommended) or follow the OSGeo4W path on Windows.
