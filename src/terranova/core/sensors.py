"""Band naming for common sensors.

Lets the UI and controllers ask for a canonical band by role ("red", "nir",
"swir1") without users having to remember the cryptic numeric ordering used
by each provider.  The single source of truth for "what is band N of a given
sensor" lives here so that adding a new platform is a one-file change.

Wavelengths are central wavelengths in nanometres.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Sensor(str, Enum):
    SENTINEL_2 = "sentinel-2"
    LANDSAT_8_9 = "landsat-8/9"
    LANDSAT_4_7 = "landsat-4-7"
    MODIS = "modis"


@dataclass(frozen=True, slots=True)
class BandInfo:
    name: str  # canonical role: red, green, nir, swir1, ...
    asset_id: str  # name in STAC asset / GeoTIFF — e.g. B04 for S2
    wavelength_nm: float
    resolution_m: float


# Sentinel-2 L2A surface reflectance bands.
SENTINEL_2_BANDS: dict[str, BandInfo] = {
    "coastal": BandInfo("coastal", "B01", 443, 60),
    "blue": BandInfo("blue", "B02", 490, 10),
    "green": BandInfo("green", "B03", 560, 10),
    "red": BandInfo("red", "B04", 665, 10),
    "rededge1": BandInfo("rededge1", "B05", 705, 20),
    "rededge2": BandInfo("rededge2", "B06", 740, 20),
    "rededge3": BandInfo("rededge3", "B07", 783, 20),
    "nir": BandInfo("nir", "B08", 842, 10),
    "nir_narrow": BandInfo("nir_narrow", "B8A", 865, 20),
    "water_vapour": BandInfo("water_vapour", "B09", 940, 60),
    "swir_cirrus": BandInfo("swir_cirrus", "B10", 1375, 60),
    "swir1": BandInfo("swir1", "B11", 1610, 20),
    "swir2": BandInfo("swir2", "B12", 2190, 20),
}

# Landsat 8/9 OLI surface-reflectance bands.
LANDSAT_8_9_BANDS: dict[str, BandInfo] = {
    "coastal": BandInfo("coastal", "SR_B1", 443, 30),
    "blue": BandInfo("blue", "SR_B2", 482, 30),
    "green": BandInfo("green", "SR_B3", 561, 30),
    "red": BandInfo("red", "SR_B4", 655, 30),
    "nir": BandInfo("nir", "SR_B5", 865, 30),
    "swir1": BandInfo("swir1", "SR_B6", 1609, 30),
    "swir2": BandInfo("swir2", "SR_B7", 2201, 30),
}

# Landsat 4-7 TM/ETM+ surface-reflectance bands.
LANDSAT_4_7_BANDS: dict[str, BandInfo] = {
    "blue": BandInfo("blue", "SR_B1", 485, 30),
    "green": BandInfo("green", "SR_B2", 560, 30),
    "red": BandInfo("red", "SR_B3", 660, 30),
    "nir": BandInfo("nir", "SR_B4", 830, 30),
    "swir1": BandInfo("swir1", "SR_B5", 1650, 30),
    "swir2": BandInfo("swir2", "SR_B7", 2215, 30),
}

_REGISTRY: dict[Sensor, dict[str, BandInfo]] = {
    Sensor.SENTINEL_2: SENTINEL_2_BANDS,
    Sensor.LANDSAT_8_9: LANDSAT_8_9_BANDS,
    Sensor.LANDSAT_4_7: LANDSAT_4_7_BANDS,
}


def bands_for(sensor: Sensor) -> dict[str, BandInfo]:
    """Return the canonical {role -> BandInfo} mapping for a sensor."""
    if sensor not in _REGISTRY:
        raise ValueError(f"unknown sensor: {sensor!r}")
    return _REGISTRY[sensor]


def asset_id(sensor: Sensor, role: str) -> str:
    """Look up the STAC asset / band id for a role (e.g. ``red`` → ``B04``)."""
    return bands_for(sensor)[role].asset_id


def resolve_index(sensor: Sensor, role: str, band_order: list[str]) -> int:
    """1-based band index in the user's raster for a given role.

    ``band_order`` is the list of band ids as they appear in the user's file —
    this is the order in which rasterio reports them.  Returns the 1-based
    rasterio index of the role's band, raising ``KeyError`` if absent.
    """
    target = asset_id(sensor, role)
    return band_order.index(target) + 1
