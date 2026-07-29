#!/usr/bin/env python3
"""Compute per-pixel difference statistics between two rasters.

All inputs are passed as argv by the Node backend; this script never receives
or evaluates caller-supplied code. Layer names are used only as opaque labels
in the JSON output. Absolute filesystem paths are never echoed back.

Usage:
    calculate_raster_difference.py --path-a A.tif --path-b B.tif \
        [--layer-a NAME] [--layer-b NAME] [--bbox lon_min,lat_min,lon_max,lat_max]
"""
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="Raster difference statistics")
    parser.add_argument("--path-a", required=True)
    parser.add_argument("--path-b", required=True)
    parser.add_argument("--layer-a", default="")
    parser.add_argument("--layer-b", default="")
    parser.add_argument("--bbox", default="")
    args = parser.parse_args()

    try:
        import numpy as np
    except ImportError:
        print(json.dumps({"error": "numpy not installed"}))
        return 0

    try:
        import rasterio
        from rasterio.warp import reproject, Resampling
    except ImportError:
        print(json.dumps({"error": "rasterio not installed"}))
        return 0

    def make_valid_mask(data, nodata):
        mask = np.isfinite(data)
        if nodata is not None:
            mask = mask & (data != nodata)
        # Auto-detect fill value: if many pixels are exactly -9999, use that.
        if np.sum(data == -9999) > data.size * 0.1:
            mask = mask & (data != -9999)
        if not np.any(mask):
            return mask
        # If data range suggests 0-1 (e.g. sea-ice concentration) filter
        # negatives; otherwise drop extreme negative fill values.
        if np.max(data[mask]) <= 1.5:
            mask = mask & (data >= 0)
        else:
            mask = mask & (data > -9000)
        return mask

    with rasterio.open(args.path_a) as src_a, rasterio.open(args.path_b) as src_b:
        data_a = src_a.read(1).astype(np.float64)
        data_b = src_b.read(1).astype(np.float64)
        nodata_a = src_a.nodata
        nodata_b = src_b.nodata

        mask_a = make_valid_mask(data_a, nodata_a)
        mask_b = make_valid_mask(data_b, nodata_b)

        if data_a.shape != data_b.shape:
            data_b_resampled = np.empty_like(data_a)
            reproject(
                data_b, data_b_resampled,
                src_transform=src_b.transform, src_crs=src_b.crs,
                dst_transform=src_a.transform, dst_crs=src_a.crs,
                resampling=Resampling.nearest,
            )
            data_b = data_b_resampled
            mask_b = make_valid_mask(data_b, nodata_b)

        valid = mask_a & mask_b
        diff = np.where(valid, data_a - data_b, np.nan)
        valid_diff = diff[valid]

        if valid_diff.size == 0:
            print(json.dumps({"error": "No overlapping valid pixels"}))
            return 0

        result = {
            "mean": float(np.nanmean(valid_diff)),
            "std": float(np.nanstd(valid_diff)),
            "min": float(np.nanmin(valid_diff)),
            "max": float(np.nanmax(valid_diff)),
            "median": float(np.nanmedian(valid_diff)),
            "q25": float(np.nanpercentile(valid_diff, 25)),
            "q75": float(np.nanpercentile(valid_diff, 75)),
            "valid_count": int(np.sum(valid)),
            "total_count": int(data_a.size),
            "mean_a": float(np.nanmean(data_a[mask_a])) if np.any(mask_a) else None,
            "mean_b": float(np.nanmean(data_b[mask_b])) if np.any(mask_b) else None,
            "layer_a": args.layer_a,
            "layer_b": args.layer_b,
        }
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
