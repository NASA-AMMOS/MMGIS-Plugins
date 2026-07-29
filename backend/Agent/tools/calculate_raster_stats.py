#!/usr/bin/env python3
"""
Utility script for summarizing raster values from a GeoTIFF.

Given a raster file path, the script computes:
  - mean
  - standard deviation (population, ddof=0)
  - 25th, 50th (median), and 75th percentiles

Only valid (non-NaN, non-nodata, non-masked) pixels are considered.

Example:
    python calculate_raster_stats.py /path/to/raster.tif
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

try:
    import numpy as np
except ImportError as exc:  # pragma: no cover - guard for missing dependency
    raise SystemExit("numpy is required to run this script") from exc

try:
    import rasterio
except ImportError as exc:  # pragma: no cover - guard for missing dependency
    raise SystemExit("rasterio is required to run this script") from exc
from rasterio.errors import WindowError
from rasterio.windows import from_bounds, Window
from rasterio.warp import transform, transform_bounds


def _valid_pixels(array, nodata) -> np.ndarray:
    """Return a 1D numpy array with only the valid (unmasked) pixel values."""
    if np.ma.isMaskedArray(array):
        data = np.ma.masked_invalid(array)
    else:
        data = np.ma.masked_invalid(np.ma.array(array))

    if nodata is not None and not np.isnan(nodata):
        data = np.ma.masked_equal(data, nodata)

    return data.compressed()


def _read_band(src, bbox=None):
    if bbox is None:
        data = src.read(1, masked=True)
        return data, None
    min_lon, min_lat, max_lon, max_lat = bbox
    bounds = (min_lon, min_lat, max_lon, max_lat)
    if src.crs and src.crs.to_string() not in ("EPSG:4326", "OGC:CRS84"):
        try:
            bounds = transform_bounds("EPSG:4326", src.crs, *bounds, densify_pts=21)
        except Exception as exc:
            raise RuntimeError(f"Unable to transform bbox to dataset CRS: {exc}") from exc
    try:
        window = from_bounds(*bounds, transform=src.transform)
        data = src.read(1, window=window, masked=True)
        return data, window
    except WindowError as exc:
        raise RuntimeError(f"Bbox {bbox} falls outside raster extent") from exc


class RunningStats:
    def __init__(self, collect=False):
        self.collect = collect
        self.values = [] if collect else None
        self.count = 0
        self.sum = 0.0
        self.sum_sq = 0.0
        self.min = None
        self.max = None
        self.nodata = 0

    def update(self, array, nodata):
        if array is None:
            return
        total_pixels = int(array.size)
        values = _valid_pixels(array, nodata)
        invalid = total_pixels - values.size
        if invalid > 0:
            self.nodata += invalid
        if values.size == 0:
            return
        if self.collect:
            self.values.append(values)
        self.count += int(values.size)
        self.sum += float(values.sum())
        self.sum_sq += float((values ** 2).sum())
        current_min = float(values.min())
        current_max = float(values.max())
        self.min = current_min if self.min is None else min(self.min, current_min)
        self.max = current_max if self.max is None else max(self.max, current_max)

    def finalize(self):
        if self.count == 0:
            raise ValueError("No valid pixels found in raster")
        mean = self.sum / self.count
        variance = max(self.sum_sq / self.count - mean**2, 0.0)
        std = math.sqrt(variance)
        result = {
            "valid_count": self.count,
            "nodata_count": self.nodata,
            "mean": mean,
            "std": std,
            "min": self.min,
            "max": self.max,
            "count": self.count,
        }
        if self.collect and self.values:
            concatenated = np.concatenate(self.values)
            quantiles = np.quantile(concatenated, [0.25, 0.5, 0.75])
            result["q25"] = float(quantiles[0])
            result["median"] = float(quantiles[1])
            result["q75"] = float(quantiles[2])
        else:
            result["q25"] = None
            result["median"] = None
            result["q75"] = None
        return result


def summarize_raster_full(src, bbox=None):
    band, _ = _read_band(src, bbox=bbox)
    stats = RunningStats(collect=True)
    stats.update(band, src.nodata)
    return stats.finalize()


def _compute_window(src, bbox=None):
    if bbox is None:
        return Window(0, 0, src.width, src.height)
    min_lon, min_lat, max_lon, max_lat = bbox
    bounds = (min_lon, min_lat, max_lon, max_lat)
    if src.crs and src.crs.to_string() not in ("EPSG:4326", "OGC:CRS84"):
        bounds = transform_bounds("EPSG:4326", src.crs, *bounds, densify_pts=21)
    return from_bounds(*bounds, transform=src.transform)


def summarize_raster_tiled(src, bbox=None, tile_size=2048):
    window = _compute_window(src, bbox=bbox)
    stats = RunningStats(collect=False)

    row_start = int(window.row_off)
    col_start = int(window.col_off)
    height = int(window.height)
    width = int(window.width)

    for r in range(row_start, row_start + height, tile_size):
        for c in range(col_start, col_start + width, tile_size):
            win = Window(
                c,
                r,
                min(tile_size, col_start + width - c),
                min(tile_size, row_start + height - r),
            )
            data = src.read(1, window=win, masked=True)
            stats.update(data, src.nodata)
    return stats.finalize()


def summarize_raster_sampled(
    src, bbox=None, spacing_degrees=1.0, max_samples=5000
):
    if bbox is None:
        bbox = (-180.0, -90.0, 180.0, 90.0)
    min_lon, min_lat, max_lon, max_lat = bbox
    lons = np.arange(min_lon, max_lon + spacing_degrees, spacing_degrees)
    lats = np.arange(min_lat, max_lat + spacing_degrees, spacing_degrees)
    coords = [(lon, lat) for lat in lats for lon in lons]
    if not coords:
        raise ValueError("No samples generated for sampled mode.")
    if len(coords) > max_samples:
        step = max(1, len(coords) // max_samples)
        coords = coords[::step]

    if src.crs and src.crs.to_string() not in ("EPSG:4326", "OGC:CRS84"):
        xs, ys = transform(
            "EPSG:4326",
            src.crs,
            [c[0] for c in coords],
            [c[1] for c in coords],
        )
    else:
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
    samples = list(src.sample(zip(xs, ys)))
    values = np.array([val[0] for val in samples], dtype=float)
    stats = RunningStats(collect=False)
    masked = np.ma.masked_invalid(values)
    stats.update(masked, src.nodata)
    return stats.finalize()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Summarize a GeoTIFF raster (mean, std, quartiles)."
    )
    parser.add_argument(
        "raster",
        type=Path,
        help="Path to the GeoTIFF to summarize.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output with indentation.",
    )
    parser.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("MIN_LON", "MIN_LAT", "MAX_LON", "MAX_LAT"),
        help="Optional geographic bounding box (WGS84) to constrain the statistics.",
    )
    parser.add_argument(
        "--mode",
        choices=["full", "tiled", "sampled"],
        default="full",
        help="Computation mode: full read, tiled chunks, or sampled grid.",
    )
    parser.add_argument(
        "--tile-size",
        type=int,
        default=2048,
        help="Tile size (pixels) for tiled mode.",
    )
    parser.add_argument(
        "--sample-spacing",
        type=float,
        default=1.0,
        help="Sample spacing in degrees for sampled mode.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        bbox = tuple(args.bbox) if args.bbox else None
        if bbox and (bbox[0] >= bbox[2] or bbox[1] >= bbox[3]):
            raise ValueError("Invalid bbox ordering; expected min < max for lon/lat.")
        if not args.raster.exists():
            raise FileNotFoundError(f"Raster not found: {args.raster}")
        with rasterio.open(args.raster) as src:
            if args.mode == "full":
                stats = summarize_raster_full(src, bbox=bbox)
            elif args.mode == "tiled":
                stats = summarize_raster_tiled(
                    src, bbox=bbox, tile_size=max(256, args.tile_size)
                )
            else:
                stats = summarize_raster_sampled(
                    src, bbox=bbox, spacing_degrees=max(0.1, args.sample_spacing)
                )
            stats["method"] = args.mode
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.pretty:
        print(json.dumps(stats, indent=2, sort_keys=True))
    else:
        print(json.dumps(stats))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
