#!/usr/bin/env python3
"""Run raster-difference integration cases in one isolated GDAL process."""

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile

from create_difference_rasters import main as create_rasters


def load_difference_module():
    script = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "tools", "calculate_raster_difference.py")
    )
    spec = importlib.util.spec_from_file_location("calculate_raster_difference", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def call_main(module, argv):
    prior_argv = sys.argv
    output = io.StringIO()
    try:
        sys.argv = ["calculate_raster_difference.py", *argv]
        with contextlib.redirect_stdout(output):
            status = module.main()
    finally:
        sys.argv = prior_argv
    if status != 0:
        raise RuntimeError("difference script returned a nonzero status")
    return json.loads(output.getvalue().strip())


def main():
    module = load_difference_module()
    with tempfile.TemporaryDirectory(prefix="mmgis-agent-difference-") as directory:
        prior_argv = sys.argv
        fixture_output = io.StringIO()
        try:
            sys.argv = ["create_difference_rasters.py", directory]
            with contextlib.redirect_stdout(fixture_output):
                create_rasters()
        finally:
            sys.argv = prior_argv
        rasters = json.loads(fixture_output.getvalue().strip())

        shifted = call_main(module, [
            "--path-a", rasters["shiftedA"],
            "--path-b", rasters["shiftedB"],
            "--layer-a", "A",
            "--layer-b", "B",
        ])
        projected = call_main(module, [
            "--path-a", rasters["projectedA"],
            "--path-b", rasters["projectedB"],
            "--bbox", "2,2,5,5",
        ])
        signed = call_main(module, [
            "--path-a", rasters["signedA"],
            "--path-b", rasters["signedB"],
            "--layer-a", "Signed A",
            "--layer-b", "Signed B",
        ])
        west = call_main(module, [
            "--path-a", rasters["westA"],
            "--path-b", rasters["westB"],
            "--bbox=-108,2,-105,5",
        ])
        large_tiled = call_main(module, [
            "--path-a", rasters["largeA"],
            "--path-b", rasters["largeB"],
            "--mode", "auto",
            "--tile-size", "256",
            "--max-quantile-samples", "2048",
        ])
        large_sampled = call_main(module, [
            "--path-a", rasters["largeA"],
            "--path-b", rasters["largeB"],
            "--mode", "sampled",
            "--max-samples", "100",
            "--max-quantile-samples", "1024",
        ])
        unsafe_full = call_main(module, [
            "--path-a", rasters["largeA"],
            "--path-b", rasters["largeB"],
            "--mode", "full",
        ])
        huge_auto_mode = module.choose_mode(
            module.EXACT_TILED_MAX_PIXELS + 1,
            (module.EXACT_TILED_MAX_PIXELS + 1)
            * module.ESTIMATED_FULL_BYTES_PER_PIXEL,
            1,
            1,
            "auto",
        )
        print(json.dumps({
            "shifted": shifted,
            "projected": projected,
            "signed": signed,
            "west": west,
            "largeTiled": large_tiled,
            "largeSampled": large_sampled,
            "unsafeFull": unsafe_full,
            "hugeAutoMode": huge_auto_mode,
        }))


if __name__ == "__main__":
    main()
