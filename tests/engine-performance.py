"""Reproducible native compositor benchmark, also useful with --renderer snapshot."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
os.environ.setdefault("DUCKY_FFMPEG_PATH", str(ROOT / "node_modules/ffmpeg-static/ffmpeg.exe"))


def load_renderer(path):
    spec = importlib.util.spec_from_file_location("benchmark_renderer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture(folder):
    folder.mkdir(parents=True, exist_ok=True)
    image = folder / "portrait.png"
    if not image.exists():
        y, x = np.mgrid[0:1600, 0:1100]
        pixels = np.stack([(x % 256), (y % 256), ((x + y) % 256)], axis=2).astype(np.uint8)
        Image.fromarray(pixels).save(image)
    clip = {"id": "still", "assetId": "photo", "in": 0, "out": 2, "speed": 1, "volume": 1, "muted": True,
        "filter": "warm", "brightness": .05, "contrast": 1.05, "saturation": 1.1,
        "fit": "contain", "background": "blur", "rotation": 0, "fadeIn": .15, "fadeOut": .15,
        "title": {"text": "DuckyMovie · Test GPU", "style": "lower", "color": "#ffffff"}}
    asset = {"id": "photo", "name": "portrait", "path": str(image), "kind": "image", "duration": 0, "hasAudio": False}
    project = {"aspectRatio": "16:9", "clips": [clip], "assets": [asset], "audioTracks": [],
        "overlays": [{"id": "card", "kind": "text", "start": .3, "end": 1.7, "text": "Anteprima e filmato coerenti",
            "x": .5, "y": .15, "width": .6, "opacity": .85, "animation": "fade", "color": "#ffffff"}]}
    return project, asset, clip


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", default=str(ROOT / "engine/renderer.py"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--folder", default=str(ROOT / "test-results/encoding-performance"))
    parser.add_argument("--resolution", default="1080p")
    parser.add_argument("--acceleration", default="cpu")
    args = parser.parse_args()
    renderer = load_renderer(args.renderer)
    folder = Path(args.folder)
    project, asset, clip = fixture(folder)
    w, h = renderer._dimensions("16:9", args.resolution)
    report = {"resolution": args.resolution, "acceleration": args.acceleration, "renderer": args.renderer, "sources": {}}
    for zoom in ("none", "in"):
        variant = {**clip, "zoom": zoom, "zoomAmount": 1.08}
        source = renderer.Source(variant, asset, project, w, h, 2)
        started = time.perf_counter()
        for index in range(24):
            source.frame(index / 12)
        seconds = time.perf_counter() - started
        source.close()
        report["sources"][zoom] = {"frames": 24, "seconds": seconds, "fps": 24 / seconds}
    started = time.perf_counter()
    output = folder / (Path(args.output).stem + ".mp4")
    renderer.render_project(project, {"resolution": args.resolution, "fps": 24, "quality": "standard", "acceleration": args.acceleration}, str(output), lambda *event: None, threading.Event())
    report["renderSeconds"] = time.perf_counter() - started
    report["output"] = str(output)
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
