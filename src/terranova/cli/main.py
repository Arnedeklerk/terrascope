"""Terranova CLI entry point.

Usage examples:

    terranova ndvi input.tif out.tif --red 4 --nir 8
    terranova index nbr scene.tif burn.tif --band-a 4 --band-b 6
    terranova search-s2 -0.5 51.3 0.3 51.7 2024-06-01/2024-09-30 --max-cloud 20

The CLI is a thin argparse wrapper around the ``terranova.api`` surface; it
must not depend on PyQt or QGIS so it works on headless CI runners.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ..version import __version__


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="terranova",
        description="Terranova CLI — pure-Python core operations outside QGIS.",
    )
    p.add_argument("--version", action="version", version=f"terranova {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    # ndvi --------------------------------------------------------------- #
    ndvi = sub.add_parser("ndvi", help="Compute NDVI from a multi-band raster.")
    ndvi.add_argument("input", type=Path)
    ndvi.add_argument("output", type=Path)
    ndvi.add_argument("--red", type=int, default=1, help="1-based red band index")
    ndvi.add_argument("--nir", type=int, default=2, help="1-based NIR band index")
    ndvi.set_defaults(func=_cmd_ndvi)

    # index -------------------------------------------------------------- #
    idx = sub.add_parser(
        "index", help="Compute a two-band normalised-difference index (ndwi/ndmi/nbr/ndsi)."
    )
    idx.add_argument("kind", choices=["ndwi", "ndmi", "nbr", "ndsi"])
    idx.add_argument("input", type=Path)
    idx.add_argument("output", type=Path)
    idx.add_argument("--band-a", type=int, required=True)
    idx.add_argument("--band-b", type=int, required=True)
    idx.set_defaults(func=_cmd_index)

    # search-s2 ---------------------------------------------------------- #
    s2 = sub.add_parser("search-s2", help="STAC search Sentinel-2 L2A on Planetary Computer.")
    s2.add_argument("west", type=float)
    s2.add_argument("south", type=float)
    s2.add_argument("east", type=float)
    s2.add_argument("north", type=float)
    s2.add_argument("datetime", help='STAC datetime, e.g. "2024-06-01/2024-09-30"')
    s2.add_argument("--max-cloud", type=int, default=30)
    s2.add_argument("--limit", type=int, default=50)
    s2.set_defaults(func=_cmd_search_s2)

    # accuracy-report ---------------------------------------------------- #
    acc = sub.add_parser(
        "accuracy-report",
        help="Render a PDF accuracy report from a JSON report blob.",
    )
    acc.add_argument("report_json", type=Path)
    acc.add_argument("output_pdf", type=Path)
    acc.set_defaults(func=_cmd_accuracy_report)

    # validate-cog ------------------------------------------------------- #
    vc = sub.add_parser("validate-cog", help="Validate a Cloud-Optimised GeoTIFF.")
    vc.add_argument("path", type=Path)
    vc.set_defaults(func=_cmd_validate_cog)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


# --------------------------------------------------------------------------- #
# Commands                                                                    #
# --------------------------------------------------------------------------- #
def _cmd_ndvi(args: argparse.Namespace) -> int:
    import numpy as np
    import rasterio

    from ..core.timeseries.indices import ndvi

    with rasterio.open(args.input) as src:
        profile = src.profile.copy()
        red = src.read(args.red)
        nir = src.read(args.nir)

    out = ndvi(red, nir)
    profile.update(
        dtype="float32",
        count=1,
        nodata=float("nan"),
        compress="deflate",
        tiled=True,
        predictor=3,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(args.output, "w", **profile) as dst:
        dst.write(out.astype(np.float32), 1)
    print(f"wrote {args.output}")
    return 0


def _cmd_index(args: argparse.Namespace) -> int:
    import numpy as np
    import rasterio

    from ..core.timeseries import indices as idx

    fn = {"ndwi": idx.ndwi, "ndmi": idx.ndmi, "nbr": idx.nbr, "ndsi": idx.ndsi}[
        args.kind
    ]

    with rasterio.open(args.input) as src:
        profile = src.profile.copy()
        a = src.read(args.band_a)
        b = src.read(args.band_b)

    out = fn(a, b)
    profile.update(
        dtype="float32",
        count=1,
        nodata=float("nan"),
        compress="deflate",
        tiled=True,
        predictor=3,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(args.output, "w", **profile) as dst:
        dst.write(out.astype(np.float32), 1)
    print(f"wrote {args.output}")
    return 0


def _cmd_search_s2(args: argparse.Namespace) -> int:
    from ..api import search_sentinel2

    items = search_sentinel2(
        bbox=(args.west, args.south, args.east, args.north),
        datetime=args.datetime,
        max_cloud=args.max_cloud,
        limit=args.limit,
    )
    out = [
        {
            "id": it.id,
            "datetime": str(it.datetime),
            "cloud": it.properties.get("eo:cloud_cover"),
            "platform": it.properties.get("platform"),
        }
        for it in items
    ]
    print(json.dumps(out, indent=2))
    return 0


def _cmd_accuracy_report(args: argparse.Namespace) -> int:
    import numpy as np

    from ..core.accuracy.metrics import AccuracyReport
    from ..core.accuracy.report import render_pdf

    raw = json.loads(args.report_json.read_text(encoding="utf-8"))
    report = AccuracyReport(
        class_labels=raw["class_labels"],
        confusion_matrix=np.array(raw["confusion_matrix"], dtype=int),
        overall_accuracy=float(raw["overall_accuracy"]),
        kappa=float(raw["kappa"]),
        producers_accuracy=np.array(raw["producers_accuracy"], dtype=float),
        users_accuracy=np.array(raw["users_accuracy"], dtype=float),
        f1_per_class=np.array(raw["f1_per_class"], dtype=float),
        n_samples=int(raw["n_samples"]),
    )
    render_pdf(report, args.output_pdf)
    print(f"wrote {args.output_pdf}")
    return 0


def _cmd_validate_cog(args: argparse.Namespace) -> int:
    from ..core.stacking.cog import validate

    is_cog, errors, warnings = validate(args.path)
    print(f"{args.path}: {'COG' if is_cog else 'NOT a COG'}")
    for w in warnings:
        print(f"  warn: {w}")
    for e in errors:
        print(f"  error: {e}")
    return 0 if is_cog else 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
