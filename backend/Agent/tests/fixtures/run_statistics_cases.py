#!/usr/bin/env python3
"""Run bounded raster-statistics integration cases in one GDAL process."""

import contextlib
import importlib.util
import io
import json
import os
import tempfile

import numpy as np
import rasterio
from rasterio.transform import from_origin


def load_statistics_module():
    script = os.path.abspath(
        os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "tools",
            "calculate_raster_stats.py",
        )
    )
    spec = importlib.util.spec_from_file_location(
        "calculate_raster_stats", script
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_raster(path, data, crs):
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
        transform=from_origin(0, height, 1, 1),
        nodata=-9999,
        compress="deflate",
        tiled=width >= 256 and height >= 256,
    ) as dataset:
        dataset.write(np.asarray(data, dtype=np.float32), 1)


def invoke(module, argv):
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        status = module.main(argv)
    output = stdout.getvalue().strip()
    return {
        "status": status,
        "stdout": json.loads(output) if output else None,
        "stderr": stderr.getvalue().strip(),
    }


def main():
    module = load_statistics_module()
    with tempfile.TemporaryDirectory(
        prefix="mmgis-agent-statistics-"
    ) as directory:
        small_path = os.path.join(directory, "small.tif")
        large_path = os.path.join(directory, "large.tif")
        unreferenced_path = os.path.join(directory, "unreferenced.tif")

        write_raster(
            small_path,
            np.arange(16, dtype=np.float32).reshape(4, 4),
            "EPSG:4326",
        )
        write_raster(
            large_path,
            np.full((1000, 1100), 2, dtype=np.float32),
            "EPSG:4326",
        )
        write_raster(
            unreferenced_path,
            np.arange(16, dtype=np.float32).reshape(4, 4),
            None,
        )

        small = invoke(module, [small_path, "--mode", "auto"])
        large = invoke(
            module,
            [
                large_path,
                "--mode",
                "auto",
                "--tile-size",
                "256",
                "--max-quantile-samples",
                "2048",
            ],
        )
        unreferenced_whole = invoke(
            module, [unreferenced_path, "--mode", "auto"]
        )
        unreferenced_bbox = invoke(
            module,
            [
                unreferenced_path,
                "--mode",
                "auto",
                "--bbox",
                "0",
                "0",
                "2",
                "2",
            ],
        )
        unsafe_full = invoke(
            module, [large_path, "--mode", "full"]
        )

        large_file_mode = module._choose_mode_from_metrics(
            16,
            64,
            module.SAFE_FULL_MAX_FILE_BYTES + 1,
            "auto",
        )
        exceptional_mode = module._choose_mode_from_metrics(
            module.EXACT_TILED_MAX_PIXELS + 1,
            module.SAFE_FULL_MAX_UNCOMPRESSED_BYTES + 1,
            module.SAFE_FULL_MAX_FILE_BYTES + 1,
            "auto",
        )

        print(
            json.dumps(
                {
                    "small": small,
                    "large": large,
                    "unreferencedWhole": unreferenced_whole,
                    "unreferencedBbox": unreferenced_bbox,
                    "unsafeFull": unsafe_full,
                    "largeFileMode": large_file_mode,
                    "exceptionalMode": exceptional_mode,
                }
            )
        )


if __name__ == "__main__":
    main()
