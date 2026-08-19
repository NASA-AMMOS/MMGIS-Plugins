#!/usr/bin/env python3
"""
Utility script for summarizing raster values from a GeoTIFF.

Given a raster file path, the script computes:
  - mean
  - standard deviation (population, ddof=0)
  - 25th, 50th (median), and 75th percentiles

Only valid (non-NaN, non-nodata, non-masked) pixels are considered.

Resource policy:
  - auto uses a capped full read only for small rasters/windows.
  - larger rasters use tiled, all-pixel streaming moments.
  - exceptionally large rasters use a bounded spatial sample.
  - quartiles use at most 65,536 deterministic priority-sampled values; they
    are exact when the valid population fits within that bound and explicitly
    marked approximate otherwise.

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
from rasterio.transform import xy
from rasterio.windows import from_bounds, Window
from rasterio.warp import transform_bounds


SAFE_FULL_MAX_PIXELS = 1_000_000
SAFE_FULL_MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
SAFE_FULL_MAX_FILE_BYTES = 128 * 1024 * 1024
EXACT_TILED_MAX_PIXELS = 100_000_000
DEFAULT_TILE_SIZE = 1024
MAX_TILE_SIZE = 1024
DEFAULT_QUANTILE_SAMPLE_LIMIT = 65_536
DEFAULT_SPATIAL_SAMPLE_LIMIT = 5_000
MISSING_CRS_MARKER = "MMGIS_MISSING_RASTER_CRS"
UNSAFE_FULL_READ_MARKER = "MMGIS_UNSAFE_FULL_READ"


class MissingRasterCrsError(ValueError):
    """A geographic request cannot be mapped onto an unreferenced raster."""


class UnsafeFullReadError(ValueError):
    """The caller requested an unbounded whole-array read."""


def _valid_pixels(array, nodata) -> np.ndarray:
    """Return a 1D numpy array with only the valid (unmasked) pixel values."""
    if np.ma.isMaskedArray(array):
        data = np.ma.masked_invalid(array)
    else:
        data = np.ma.masked_invalid(np.ma.array(array))

    if nodata is not None and not np.isnan(nodata):
        data = np.ma.masked_equal(data, nodata)

    return np.asarray(data.compressed(), dtype=np.float64)


def _bbox_in_dataset_crs(src, bbox):
    if bbox is None:
        return None
    if src.crs is None:
        raise MissingRasterCrsError(
            "Geographic bbox statistics require raster CRS metadata."
        )
    bounds = tuple(bbox)
    if src.crs.to_string() not in ("EPSG:4326", "OGC:CRS84"):
        try:
            bounds = transform_bounds(
                "EPSG:4326", src.crs, *bounds, densify_pts=21
            )
        except Exception as exc:
            raise RuntimeError(
                f"Unable to transform bbox to dataset CRS: {exc}"
            ) from exc
    return bounds


def _compute_window(src, bbox=None):
    if bbox is None:
        return Window(0, 0, src.width, src.height)

    bounds = _bbox_in_dataset_crs(src, bbox)
    left = max(src.bounds.left, bounds[0])
    bottom = max(src.bounds.bottom, bounds[1])
    right = min(src.bounds.right, bounds[2])
    top = min(src.bounds.top, bounds[3])
    if left >= right or bottom >= top:
        raise WindowError(f"Bbox {bbox} falls outside raster extent")

    requested = from_bounds(
        left,
        bottom,
        right,
        top,
        transform=src.transform,
    )
    col_start = max(0, math.floor(requested.col_off))
    row_start = max(0, math.floor(requested.row_off))
    col_stop = min(src.width, math.ceil(requested.col_off + requested.width))
    row_stop = min(src.height, math.ceil(requested.row_off + requested.height))
    if col_start >= col_stop or row_start >= row_stop:
        raise WindowError(f"Bbox {bbox} contains no raster pixels")
    return Window(
        col_start,
        row_start,
        col_stop - col_start,
        row_stop - row_start,
    )


def _window_pixel_count(window):
    return int(window.width) * int(window.height)


def _choose_mode_from_metrics(
    pixel_count,
    estimated_uncompressed_bytes,
    source_file_bytes,
    requested_mode,
):
    full_is_safe = (
        pixel_count <= SAFE_FULL_MAX_PIXELS
        and estimated_uncompressed_bytes <= SAFE_FULL_MAX_UNCOMPRESSED_BYTES
        and source_file_bytes <= SAFE_FULL_MAX_FILE_BYTES
    )
    if requested_mode == "full":
        if not full_is_safe:
            raise UnsafeFullReadError(
                "Full raster mode exceeds the bounded read limit; use auto, tiled, or sampled mode."
            )
        return "full", "explicit-safe-full"
    if requested_mode == "tiled":
        return "tiled", "explicit-bounded-tiled"
    if requested_mode == "sampled":
        return "sampled", "explicit-bounded-sampled"
    if full_is_safe:
        return "full", "auto-safe-small-window"
    if pixel_count <= EXACT_TILED_MAX_PIXELS:
        return "tiled", "auto-bounded-exact-tiled"
    return "sampled", "auto-bounded-spatial-sample"


def select_mode(src, raster_path, bbox, requested_mode):
    window = _compute_window(src, bbox=bbox)
    pixel_count = _window_pixel_count(window)
    bytes_per_pixel = np.dtype(src.dtypes[0]).itemsize
    estimated_uncompressed_bytes = pixel_count * bytes_per_pixel
    try:
        source_file_bytes = int(raster_path.stat().st_size)
    except OSError:
        source_file_bytes = SAFE_FULL_MAX_FILE_BYTES + 1
    mode, reason = _choose_mode_from_metrics(
        pixel_count,
        estimated_uncompressed_bytes,
        source_file_bytes,
        requested_mode,
    )
    return {
        "mode": mode,
        "reason": reason,
        "window": window,
        "pixel_count": pixel_count,
        "estimated_uncompressed_bytes": estimated_uncompressed_bytes,
        "source_file_bytes": source_file_bytes,
    }


class BoundedQuantileSample:
    """Uniform deterministic priority sample with a strict memory cap."""

    def __init__(self, limit):
        self.limit = max(1_024, int(limit))
        self.values = np.empty(0, dtype=np.float64)
        self.priorities = np.empty(0, dtype=np.float64)
        self.seen = 0
        self.rng = np.random.default_rng(0x4D4D4749)

    def update(self, values):
        if values.size == 0:
            return
        values = np.asarray(values, dtype=np.float64)
        priorities = self.rng.random(values.size)
        self.seen += int(values.size)
        combined_values = np.concatenate((self.values, values))
        combined_priorities = np.concatenate((self.priorities, priorities))
        if combined_values.size > self.limit:
            keep = np.argpartition(
                combined_priorities, self.limit - 1
            )[: self.limit]
            combined_values = combined_values[keep]
            combined_priorities = combined_priorities[keep]
        self.values = combined_values
        self.priorities = combined_priorities

    def finalize(self):
        quantiles = np.quantile(self.values, [0.25, 0.5, 0.75])
        exact = self.seen <= self.limit
        return {
            "q25": float(quantiles[0]),
            "median": float(quantiles[1]),
            "q75": float(quantiles[2]),
            "quantile_method": (
                "exact"
                if exact
                else "deterministic_priority_sample"
            ),
            "quantile_sample_count": int(self.values.size),
            "quantile_sample_limit": self.limit,
            "quantiles_approximate": not exact,
        }


class RunningStats:
    """Numerically stable, all-pixel streaming population moments."""

    def __init__(self, quantile_sample_limit=DEFAULT_QUANTILE_SAMPLE_LIMIT):
        self.count = 0
        self.mean = 0.0
        self.m2 = 0.0
        self.min = None
        self.max = None
        self.nodata = 0
        self.quantiles = BoundedQuantileSample(quantile_sample_limit)

    def update(self, array, nodata):
        if array is None:
            return
        total_pixels = int(array.size)
        values = _valid_pixels(array, nodata)
        self.nodata += total_pixels - int(values.size)
        if values.size == 0:
            return

        batch_count = int(values.size)
        batch_mean = float(np.mean(values, dtype=np.float64))
        centered = values - batch_mean
        batch_m2 = float(np.dot(centered, centered))
        if self.count == 0:
            self.mean = batch_mean
            self.m2 = batch_m2
            self.count = batch_count
        else:
            combined_count = self.count + batch_count
            delta = batch_mean - self.mean
            self.mean += delta * batch_count / combined_count
            self.m2 += (
                batch_m2
                + delta * delta * self.count * batch_count / combined_count
            )
            self.count = combined_count

        current_min = float(values.min())
        current_max = float(values.max())
        self.min = (
            current_min if self.min is None else min(self.min, current_min)
        )
        self.max = (
            current_max if self.max is None else max(self.max, current_max)
        )
        self.quantiles.update(values)

    def finalize(self):
        if self.count == 0:
            raise ValueError("No valid pixels found in raster")
        result = {
            "valid_count": self.count,
            "nodata_count": self.nodata,
            "mean": self.mean,
            "std": math.sqrt(max(self.m2 / self.count, 0.0)),
            "min": self.min,
            "max": self.max,
            "count": self.count,
        }
        result.update(self.quantiles.finalize())
        return result


def summarize_raster_full(src, window, quantile_sample_limit):
    band = src.read(1, window=window, masked=True)
    stats = RunningStats(quantile_sample_limit)
    stats.update(band, src.nodata)
    return stats.finalize()


def summarize_raster_tiled(
    src,
    window,
    tile_size=DEFAULT_TILE_SIZE,
    quantile_sample_limit=DEFAULT_QUANTILE_SAMPLE_LIMIT,
):
    stats = RunningStats(quantile_sample_limit)
    row_start = int(window.row_off)
    col_start = int(window.col_off)
    height = int(window.height)
    width = int(window.width)

    for row in range(row_start, row_start + height, tile_size):
        for col in range(col_start, col_start + width, tile_size):
            tile = Window(
                col,
                row,
                min(tile_size, col_start + width - col),
                min(tile_size, row_start + height - row),
            )
            stats.update(src.read(1, window=tile, masked=True), src.nodata)
    return stats.finalize()


def summarize_raster_sampled(
    src,
    window,
    bbox=None,
    spacing_degrees=1.0,
    max_samples=DEFAULT_SPATIAL_SAMPLE_LIMIT,
    quantile_sample_limit=DEFAULT_QUANTILE_SAMPLE_LIMIT,
):
    total_pixels = _window_pixel_count(window)
    target_samples = min(max(1, int(max_samples)), total_pixels)
    if bbox is not None:
        desired_cols = max(
            1, math.ceil((bbox[2] - bbox[0]) / spacing_degrees) + 1
        )
        desired_rows = max(
            1, math.ceil((bbox[3] - bbox[1]) / spacing_degrees) + 1
        )
        target_samples = min(
            target_samples, desired_cols * desired_rows
        )

    width = int(window.width)
    height = int(window.height)
    aspect = width / max(height, 1)
    column_count = min(
        width,
        max(1, int(math.sqrt(target_samples * aspect))),
    )
    row_count = min(
        height,
        max(1, target_samples // column_count),
    )
    rows = np.unique(
        np.linspace(
            int(window.row_off),
            int(window.row_off) + height - 1,
            row_count,
            dtype=int,
        )
    )
    cols = np.unique(
        np.linspace(
            int(window.col_off),
            int(window.col_off) + width - 1,
            column_count,
            dtype=int,
        )
    )
    row_grid, col_grid = np.meshgrid(rows, cols, indexing="ij")
    xs, ys = xy(
        src.transform,
        row_grid.ravel(),
        col_grid.ravel(),
        offset="center",
    )
    sample_values = []
    sample_masks = []
    for sample in src.sample(zip(xs, ys), indexes=1, masked=True):
        sample_values.append(float(sample.data[0]))
        sample_masks.append(bool(np.ma.getmaskarray(sample)[0]))
    masked_samples = np.ma.array(sample_values, mask=sample_masks)
    stats = RunningStats(quantile_sample_limit)
    stats.update(masked_samples, src.nodata)
    result = stats.finalize()
    result["spatial_sample_count"] = int(masked_samples.size)
    return result


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
        choices=["auto", "full", "tiled", "sampled"],
        default="auto",
        help="Computation mode. Auto enforces bounded full/tiled/sampled selection.",
    )
    parser.add_argument(
        "--tile-size",
        type=int,
        default=DEFAULT_TILE_SIZE,
        help="Tile size (pixels) for tiled mode.",
    )
    parser.add_argument(
        "--sample-spacing",
        type=float,
        default=1.0,
        help="Sample spacing in degrees for sampled mode.",
    )
    parser.add_argument(
        "--max-samples",
        type=int,
        default=DEFAULT_SPATIAL_SAMPLE_LIMIT,
        help="Maximum spatial samples; values above the server cap are clamped.",
    )
    parser.add_argument(
        "--max-quantile-samples",
        type=int,
        default=DEFAULT_QUANTILE_SAMPLE_LIMIT,
        help="Maximum retained values for quartiles; values above the cap are clamped.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        bbox = tuple(args.bbox) if args.bbox else None
        if bbox and (
            not all(math.isfinite(value) for value in bbox)
            or bbox[0] >= bbox[2]
            or bbox[1] >= bbox[3]
            or bbox[0] < -180
            or bbox[2] > 180
            or bbox[1] < -90
            or bbox[3] > 90
        ):
            raise ValueError("Invalid bbox ordering; expected min < max for lon/lat.")
        if not args.raster.exists():
            raise FileNotFoundError(f"Raster not found: {args.raster}")
        tile_size = min(MAX_TILE_SIZE, max(256, args.tile_size))
        max_samples = min(
            DEFAULT_SPATIAL_SAMPLE_LIMIT,
            max(1, args.max_samples),
        )
        quantile_sample_limit = min(
            DEFAULT_QUANTILE_SAMPLE_LIMIT,
            max(1_024, args.max_quantile_samples),
        )
        spacing_degrees = (
            args.sample_spacing
            if math.isfinite(args.sample_spacing) and args.sample_spacing > 0
            else 1.0
        )
        with rasterio.open(args.raster) as src:
            selection = select_mode(src, args.raster, bbox, args.mode)
            selected_mode = selection["mode"]
            if selected_mode == "full":
                stats = summarize_raster_full(
                    src,
                    selection["window"],
                    quantile_sample_limit,
                )
            elif selected_mode == "tiled":
                stats = summarize_raster_tiled(
                    src,
                    selection["window"],
                    tile_size=tile_size,
                    quantile_sample_limit=quantile_sample_limit,
                )
            else:
                stats = summarize_raster_sampled(
                    src,
                    selection["window"],
                    bbox=bbox,
                    spacing_degrees=spacing_degrees,
                    max_samples=max_samples,
                    quantile_sample_limit=quantile_sample_limit,
                )
            stats.update({
                "method": selected_mode,
                "requested_mode": args.mode,
                "mode_selection_reason": selection["reason"],
                "selected_pixel_count": selection["pixel_count"],
                "estimated_uncompressed_bytes": selection[
                    "estimated_uncompressed_bytes"
                ],
                "source_file_bytes": selection["source_file_bytes"],
                "population_coverage": (
                    "bounded-spatial-sample"
                    if selected_mode == "sampled"
                    else "all-valid-pixels"
                ),
                "mean_is_approximate": selected_mode == "sampled",
            })
            if selected_mode == "sampled":
                stats["quantiles_approximate"] = True
    except MissingRasterCrsError as exc:
        print(f"{MISSING_CRS_MARKER}: {exc}", file=sys.stderr)
        return 2
    except UnsafeFullReadError as exc:
        print(f"{UNSAFE_FULL_READ_MARKER}: {exc}", file=sys.stderr)
        return 3
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
