#!/usr/bin/env python3
"""Create small deterministic GeoTIFFs for raster-difference tests."""

import json
import os
import sys

import numpy as np
import rasterio
from rasterio.transform import from_origin


def write(path, value, crs, transform, nodata=-9999, shape=(10, 10)):
    data = (
        np.full(shape, value, dtype=np.float32)
        if np.isscalar(value)
        else np.asarray(value, dtype=np.float32)
    )
    if data.ndim != 2:
        raise ValueError("Raster fixture data must be two-dimensional")
    height, width = data.shape
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="float32",
        crs=crs,
        transform=transform,
        nodata=nodata,
    ) as dataset:
        dataset.write(data, 1)


def main():
    output = os.path.abspath(sys.argv[1])
    os.makedirs(output, exist_ok=True)

    shifted_a = os.path.join(output, "shifted-a.tif")
    shifted_b = os.path.join(output, "shifted-b.tif")
    write(shifted_a, 10, "EPSG:4326", from_origin(0, 10, 1, 1))
    # Same dimensions as A but shifted two degrees east. A shape-only
    # comparison would incorrectly claim 100 overlapping pixels.
    write(shifted_b, 4, "EPSG:4326", from_origin(2, 10, 1, 1))

    projected_a = os.path.join(output, "projected-a.tif")
    projected_b = os.path.join(output, "projected-b.tif")
    projected_transform = from_origin(0, 1118889, 111319, 111319)
    write(projected_a, 10, "EPSG:3857", projected_transform)
    write(projected_b, 4, "EPSG:3857", projected_transform)

    west_a = os.path.join(output, "west-a.tif")
    west_b = os.path.join(output, "west-b.tif")
    west_transform = from_origin(-110, 10, 1, 1)
    write(west_a, 10, "EPSG:4326", west_transform)
    write(west_b, 4, "EPSG:4326", west_transform)

    # All scientifically valid samples are negative, including values below
    # -9000, while each raster declares a different nodata sentinel. The two
    # layer means must be calculated on the exact shared seven-pixel support.
    signed_a = os.path.join(output, "signed-a.tif")
    signed_b = os.path.join(output, "signed-b.tif")
    signed_transform = from_origin(0, 3, 1, 1)
    signed_data_a = np.array([
        [-1, -10001, -3],
        [-4, -9999, -6],
        [-7, -8, -9],
    ], dtype=np.float32)
    signed_data_b = np.array([
        [-32768, -10003, -5],
        [-6, -7, -8],
        [-9, -10, -11],
    ], dtype=np.float32)
    write(
        signed_a,
        signed_data_a,
        "EPSG:4326",
        signed_transform,
        nodata=-9999,
    )
    write(
        signed_b,
        signed_data_b,
        "EPSG:4326",
        signed_transform,
        nodata=-32768,
    )

    # 1.1 million selected pixels exceed both the full-mode pixel cap and the
    # estimated 32 MiB pair working-set cap. Auto must stream tiles, while an
    # explicitly sampled run retains at most the requested spatial/quantile
    # samples. A constant difference makes approximation assertions exact and
    # deterministic without requiring large fixture files in the repository.
    large_a = os.path.join(output, "large-a.tif")
    large_b = os.path.join(output, "large-b.tif")
    large_transform = from_origin(0, 10, 0.01, 0.01)
    write(
        large_a,
        10,
        "EPSG:4326",
        large_transform,
        shape=(1000, 1100),
    )
    write(
        large_b,
        4,
        "EPSG:4326",
        large_transform,
        shape=(1000, 1100),
    )

    print(json.dumps({
        "shiftedA": shifted_a,
        "shiftedB": shifted_b,
        "projectedA": projected_a,
        "projectedB": projected_b,
        "westA": west_a,
        "westB": west_b,
        "signedA": signed_a,
        "signedB": signed_b,
        "largeA": large_a,
        "largeB": large_b,
    }))


if __name__ == "__main__":
    main()
