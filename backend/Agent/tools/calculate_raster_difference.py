#!/usr/bin/env python3
"""Bounded per-pixel difference statistics for two aligned rasters.

The reference grid is raster A (optionally cropped by a WGS84 bbox). Raster B
is reprojected onto that exact grid before either validity mask is evaluated.
Means for A and B, and all difference statistics, therefore use the same
overlapping support.

Resource policy:
  * auto reads a complete array only for a strictly capped small window.
  * larger comparisons stream exact moments through bounded tiles.
  * exceptionally large comparisons use a deterministic bounded spatial
    sample.
  * quartiles retain at most 65,536 deterministic priority-sampled
    differences and report whether they are approximate.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from contextlib import ExitStack

try:
    import numpy as np
except ImportError:  # pragma: no cover - runtime dependency guard
    np = None

try:
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import xy
    from rasterio.vrt import WarpedVRT
    from rasterio.windows import Window, from_bounds
    from rasterio.warp import Resampling, transform_bounds
except ImportError:  # pragma: no cover - runtime dependency guard
    rasterio = None


SAFE_FULL_MAX_PIXELS = 1_000_000
SAFE_FULL_MAX_WORKING_BYTES = 32 * 1024 * 1024
SAFE_FULL_MAX_FILE_BYTES = 128 * 1024 * 1024
EXACT_TILED_MAX_PIXELS = 100_000_000
ESTIMATED_FULL_BYTES_PER_PIXEL = 40
DEFAULT_TILE_SIZE = 1024
MAX_TILE_SIZE = 1024
DEFAULT_QUANTILE_SAMPLE_LIMIT = 65_536
DEFAULT_SPATIAL_SAMPLE_LIMIT = 5_000


class UnsafeFullReadError(ValueError):
    """The caller explicitly requested an unsafe whole-array comparison."""


def parse_bbox(value):
    if not value:
        return None
    try:
        bbox = tuple(float(part.strip()) for part in value.split(","))
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid geographic bounding box") from exc
    if (
        len(bbox) != 4
        or not all(math.isfinite(number) for number in bbox)
        or bbox[0] >= bbox[2]
        or bbox[1] >= bbox[3]
        or bbox[0] < -180
        or bbox[2] > 180
        or bbox[1] < -90
        or bbox[3] > 90
    ):
        raise ValueError("Invalid geographic bounding box")
    return bbox


def selected_window(src_a, requested_bbox):
    if requested_bbox is None:
        return Window(0, 0, src_a.width, src_a.height)
    if src_a.crs is None:
        raise ValueError(
            "The reference raster has no CRS; geographic bounds cannot be applied"
        )
    try:
        requested_in_a = transform_bounds(
            CRS.from_epsg(4326),
            src_a.crs,
            *requested_bbox,
            densify_pts=21,
        )
    except Exception as exc:
        raise ValueError(
            "Unable to transform the requested bounds into the raster CRS"
        ) from exc
    left = max(src_a.bounds.left, requested_in_a[0])
    bottom = max(src_a.bounds.bottom, requested_in_a[1])
    right = min(src_a.bounds.right, requested_in_a[2])
    top = min(src_a.bounds.top, requested_in_a[3])
    if left >= right or bottom >= top:
        raise ValueError(
            "Requested bounds do not overlap the reference raster"
        )
    float_window = from_bounds(
        left,
        bottom,
        right,
        top,
        transform=src_a.transform,
    )
    col_start = max(0, math.floor(float_window.col_off))
    row_start = max(0, math.floor(float_window.row_off))
    col_stop = min(
        src_a.width,
        math.ceil(float_window.col_off + float_window.width),
    )
    row_stop = min(
        src_a.height,
        math.ceil(float_window.row_off + float_window.height),
    )
    if col_start >= col_stop or row_start >= row_stop:
        raise ValueError("Requested bounds contain no reference raster pixels")
    return Window(
        col_start,
        row_start,
        col_stop - col_start,
        row_stop - row_start,
    )


def _source_file_bytes(path):
    try:
        return int(os.path.getsize(path))
    except OSError:
        return SAFE_FULL_MAX_FILE_BYTES + 1


def choose_mode(
    pixel_count,
    estimated_working_set_bytes,
    source_file_bytes_a,
    source_file_bytes_b,
    requested_mode,
):
    full_is_safe = (
        pixel_count <= SAFE_FULL_MAX_PIXELS
        and estimated_working_set_bytes <= SAFE_FULL_MAX_WORKING_BYTES
        and source_file_bytes_a <= SAFE_FULL_MAX_FILE_BYTES
        and source_file_bytes_b <= SAFE_FULL_MAX_FILE_BYTES
    )
    if requested_mode == "full":
        if not full_is_safe:
            raise UnsafeFullReadError(
                "Full comparison mode exceeds the bounded read limit; "
                "use auto, tiled, or sampled mode."
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


class BoundedQuantileSample:
    """Uniform deterministic priority sample with a strict retained-value cap."""

    def __init__(self, limit):
        self.limit = min(
            DEFAULT_QUANTILE_SAMPLE_LIMIT,
            max(1_024, int(limit)),
        )
        self.values = np.empty(0, dtype=np.float64)
        self.priorities = np.empty(0, dtype=np.float64)
        self.seen = 0
        self.rng = np.random.default_rng(0x4D4D4749)

    def update(self, values):
        values = np.asarray(values, dtype=np.float64)
        if values.size == 0:
            return
        priorities = self.rng.random(values.size)
        self.seen += int(values.size)
        combined_values = np.concatenate((self.values, values))
        combined_priorities = np.concatenate(
            (self.priorities, priorities)
        )
        if combined_values.size > self.limit:
            keep = np.argpartition(
                combined_priorities,
                self.limit - 1,
            )[: self.limit]
            combined_values = combined_values[keep]
            combined_priorities = combined_priorities[keep]
        self.values = combined_values
        self.priorities = combined_priorities

    def finalize(self, force_approximate=False):
        quantiles = np.quantile(self.values, [0.25, 0.5, 0.75])
        exact = self.seen <= self.limit and not force_approximate
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


class PairedRunningStats:
    """Stable moments using only the exact shared A/B validity mask."""

    def __init__(self, quantile_sample_limit):
        self.processed = 0
        self.count = 0
        self.mean = 0.0
        self.m2 = 0.0
        self.mean_a = 0.0
        self.mean_b = 0.0
        self.minimum = None
        self.maximum = None
        self.quantiles = BoundedQuantileSample(quantile_sample_limit)

    def update(self, data_a, mask_a, data_b, mask_b):
        if data_a.shape != data_b.shape:
            raise ValueError("Aligned raster windows do not share a shape")
        self.processed += int(data_a.size)
        valid = mask_a & mask_b
        if not np.any(valid):
            return
        values_a = np.asarray(data_a[valid], dtype=np.float64)
        values_b = np.asarray(data_b[valid], dtype=np.float64)
        differences = values_a - values_b
        batch_count = int(differences.size)
        batch_mean = float(np.mean(differences, dtype=np.float64))
        centered = differences - batch_mean
        batch_m2 = float(np.dot(centered, centered))
        batch_mean_a = float(np.mean(values_a, dtype=np.float64))
        batch_mean_b = float(np.mean(values_b, dtype=np.float64))

        if self.count == 0:
            self.count = batch_count
            self.mean = batch_mean
            self.m2 = batch_m2
            self.mean_a = batch_mean_a
            self.mean_b = batch_mean_b
        else:
            combined_count = self.count + batch_count
            existing_weight = self.count
            new_weight = batch_count
            delta = batch_mean - self.mean
            self.mean += delta * new_weight / combined_count
            self.m2 += (
                batch_m2
                + delta * delta * existing_weight * new_weight / combined_count
            )
            self.mean_a += (
                batch_mean_a - self.mean_a
            ) * new_weight / combined_count
            self.mean_b += (
                batch_mean_b - self.mean_b
            ) * new_weight / combined_count
            self.count = combined_count

        current_min = float(differences.min())
        current_max = float(differences.max())
        self.minimum = (
            current_min
            if self.minimum is None
            else min(self.minimum, current_min)
        )
        self.maximum = (
            current_max
            if self.maximum is None
            else max(self.maximum, current_max)
        )
        self.quantiles.update(differences)

    def finalize(self, force_approximate=False):
        if self.count == 0:
            raise ValueError("No overlapping valid pixels")
        result = {
            "mean": self.mean,
            "std": math.sqrt(max(self.m2 / self.count, 0.0)),
            "min": self.minimum,
            "max": self.maximum,
            "valid_count": self.count,
            "processed_pixel_count": self.processed,
            "nodata_count": self.processed - self.count,
            "mean_a": self.mean_a,
            "mean_b": self.mean_b,
        }
        result.update(
            self.quantiles.finalize(
                force_approximate=force_approximate
            )
        )
        return result


def read_data_and_mask(dataset, window=None):
    """Read band 1 using declared GDAL mask/nodata plus finite values only."""
    masked = dataset.read(1, window=window, masked=True)
    data = np.asarray(masked.data, dtype=np.float64)
    valid = ~np.ma.getmaskarray(masked)
    return data, valid & np.isfinite(data)


def iter_windows(window, tile_size):
    row_start = int(window.row_off)
    col_start = int(window.col_off)
    height = int(window.height)
    width = int(window.width)
    for row_offset in range(0, height, tile_size):
        for col_offset in range(0, width, tile_size):
            tile_height = min(tile_size, height - row_offset)
            tile_width = min(tile_size, width - col_offset)
            yield (
                Window(
                    col_start + col_offset,
                    row_start + row_offset,
                    tile_width,
                    tile_height,
                ),
                Window(
                    col_offset,
                    row_offset,
                    tile_width,
                    tile_height,
                ),
            )


def sample_positions(window, max_samples):
    total = int(window.width) * int(window.height)
    target = min(max(1, int(max_samples)), total)
    width = int(window.width)
    height = int(window.height)
    aspect = width / max(height, 1)
    column_count = min(
        width,
        max(1, int(math.sqrt(target * aspect))),
    )
    row_count = min(
        height,
        max(1, target // column_count),
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
    return row_grid.ravel(), col_grid.ravel()


def sampled_data_and_mask(dataset, coordinates):
    values = []
    valid = []
    for sample in dataset.sample(coordinates, indexes=1, masked=True):
        data = float(np.ma.getdata(sample)[0])
        masked = bool(np.ma.getmaskarray(sample)[0])
        values.append(data)
        valid.append(not masked and math.isfinite(data))
    return np.asarray(values, dtype=np.float64), np.asarray(valid, dtype=bool)


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Bounded raster difference statistics"
    )
    parser.add_argument("--path-a", required=True)
    parser.add_argument("--path-b", required=True)
    parser.add_argument("--layer-a", default="")
    parser.add_argument("--layer-b", default="")
    parser.add_argument("--bbox", default="")
    parser.add_argument(
        "--mode",
        choices=["auto", "full", "tiled", "sampled"],
        default="auto",
    )
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument(
        "--max-samples",
        type=int,
        default=DEFAULT_SPATIAL_SAMPLE_LIMIT,
    )
    parser.add_argument(
        "--max-quantile-samples",
        type=int,
        default=DEFAULT_QUANTILE_SAMPLE_LIMIT,
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if np is None:
        print(json.dumps({"error": "numpy not installed"}))
        return 0
    if rasterio is None:
        print(json.dumps({"error": "rasterio not installed"}))
        return 0

    try:
        requested_bbox = parse_bbox(args.bbox)
        tile_size = min(MAX_TILE_SIZE, max(128, int(args.tile_size)))
        max_samples = min(
            DEFAULT_SPATIAL_SAMPLE_LIMIT,
            max(1, int(args.max_samples)),
        )
        quantile_sample_limit = min(
            DEFAULT_QUANTILE_SAMPLE_LIMIT,
            max(1_024, int(args.max_quantile_samples)),
        )

        with rasterio.open(args.path_a) as src_a, rasterio.open(
            args.path_b
        ) as src_b:
            window_a = selected_window(src_a, requested_bbox)
            width = int(window_a.width)
            height = int(window_a.height)
            pixel_count = width * height
            estimated_working_set_bytes = (
                pixel_count * ESTIMATED_FULL_BYTES_PER_PIXEL
            )
            source_file_bytes_a = _source_file_bytes(args.path_a)
            source_file_bytes_b = _source_file_bytes(args.path_b)
            mode, reason = choose_mode(
                pixel_count,
                estimated_working_set_bytes,
                source_file_bytes_a,
                source_file_bytes_b,
                args.mode,
            )

            destination_transform = src_a.window_transform(window_a)
            with ExitStack() as stack:
                if src_a.crs is not None and src_b.crs is not None:
                    vrt_options = {
                        "crs": src_a.crs,
                        "transform": destination_transform,
                        "width": width,
                        "height": height,
                        "nodata": np.nan,
                        "dtype": "float64",
                        "resampling": Resampling.nearest,
                        "init_dest_nodata": True,
                    }
                    if src_b.nodata is not None:
                        vrt_options["src_nodata"] = src_b.nodata
                    aligned_b = stack.enter_context(
                        WarpedVRT(src_b, **vrt_options)
                    )
                    b_uses_local_windows = True
                    alignment = "reprojected-to-reference-grid"
                elif (
                    src_a.crs is None
                    and src_b.crs is None
                    and src_a.width == src_b.width
                    and src_a.height == src_b.height
                    and src_a.transform == src_b.transform
                ):
                    aligned_b = src_b
                    b_uses_local_windows = False
                    alignment = "identical-unreferenced-grid"
                else:
                    raise ValueError(
                        "Both rasters need compatible CRS metadata for alignment"
                    )

                stats = PairedRunningStats(quantile_sample_limit)
                if mode == "full":
                    data_a, mask_a = read_data_and_mask(
                        src_a,
                        window=window_a,
                    )
                    b_window = (
                        Window(0, 0, width, height)
                        if b_uses_local_windows
                        else window_a
                    )
                    data_b, mask_b = read_data_and_mask(
                        aligned_b,
                        window=b_window,
                    )
                    stats.update(data_a, mask_a, data_b, mask_b)
                elif mode == "tiled":
                    for global_window, local_window in iter_windows(
                        window_a,
                        tile_size,
                    ):
                        data_a, mask_a = read_data_and_mask(
                            src_a,
                            window=global_window,
                        )
                        data_b, mask_b = read_data_and_mask(
                            aligned_b,
                            window=(
                                local_window
                                if b_uses_local_windows
                                else global_window
                            ),
                        )
                        stats.update(data_a, mask_a, data_b, mask_b)
                else:
                    rows, cols = sample_positions(window_a, max_samples)
                    xs, ys = xy(
                        src_a.transform,
                        rows,
                        cols,
                        offset="center",
                    )
                    coordinates = list(zip(xs, ys))
                    data_a, mask_a = sampled_data_and_mask(
                        src_a,
                        coordinates,
                    )
                    data_b, mask_b = sampled_data_and_mask(
                        aligned_b,
                        coordinates,
                    )
                    stats.update(data_a, mask_a, data_b, mask_b)

            result = stats.finalize(force_approximate=mode == "sampled")
            result.update(
                {
                    "total_count": pixel_count,
                    "layer_a": args.layer_a,
                    "layer_b": args.layer_b,
                    "bbox_applied": requested_bbox is not None,
                    "requested_bbox": (
                        list(requested_bbox)
                        if requested_bbox is not None
                        else None
                    ),
                    "alignment": alignment,
                    "method": mode,
                    "requested_mode": args.mode,
                    "mode_selection_reason": reason,
                    "selected_pixel_count": pixel_count,
                    "estimated_working_set_bytes": (
                        estimated_working_set_bytes
                    ),
                    "source_file_bytes_a": source_file_bytes_a,
                    "source_file_bytes_b": source_file_bytes_b,
                    "population_coverage": (
                        "bounded-spatial-sample"
                        if mode == "sampled"
                        else "all-selected-overlap-pixels"
                    ),
                    "mean_is_approximate": mode == "sampled",
                    "input_means_approximate": mode == "sampled",
                    "min_max_approximate": mode == "sampled",
                    "spatial_sample_count": (
                        result["processed_pixel_count"]
                        if mode == "sampled"
                        else None
                    ),
                    "resource_limits": {
                        "full_max_pixels": SAFE_FULL_MAX_PIXELS,
                        "full_max_working_bytes": (
                            SAFE_FULL_MAX_WORKING_BYTES
                        ),
                        "exact_tiled_max_pixels": EXACT_TILED_MAX_PIXELS,
                        "tile_size": tile_size,
                        "spatial_sample_limit": max_samples,
                        "quantile_sample_limit": quantile_sample_limit,
                    },
                }
            )
            if mode == "sampled":
                result["quantiles_approximate"] = True
            print(json.dumps(result))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
