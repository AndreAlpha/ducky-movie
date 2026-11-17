"""Reproducible 4K slideshow benchmark; intentionally outside the default test suite.

Examples (use a Python environment with engine/requirements.txt installed):
  python tests/engine-slideshow-performance.py
  python tests/engine-slideshow-performance.py --duration 120 --images 40
  python tests/engine-slideshow-performance.py --compositor cpu

Only synthetic images, audio and captions are used. Output stays in test-results.
--compositor cpu keeps automatic encoding; --acceleration cpu also disables GPU encoding.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from fractions import Fraction

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
os.environ.setdefault("DUCKY_FFMPEG_PATH", str(ROOT / "node_modules/ffmpeg-static/ffmpeg.exe"))


def fixture(folder, duration, count, fps, ffmpeg):
    folder.mkdir(parents=True, exist_ok=True)
    y, x = np.mgrid[:1440, :1920]
    base = np.stack([x % 256, y % 256, (x // 10 + y // 10) % 256], axis=2).astype(np.uint8)
    assets, clips = [], []
    total_frames = round(duration * fps)
    for index in range(count):
        path = folder / f"photo-{index:03}.jpg"
        pixels = np.roll(np.roll(base, index * 23, axis=0), index * 47, axis=1)
        image = Image.fromarray(pixels)
        draw = ImageDraw.Draw(image)
        draw.rectangle((40, 40, 700, 120), fill="black")
        draw.text((65, 65), f"DuckyMovie - Immagine {index + 1:02}/{count}", fill="white", font_size=36)
        image.save(path, quality=93)
        asset_id = f"photo-{index}"
        assets.append({"id": asset_id, "name": path.name, "path": str(path), "kind": "image",
            "width": 1920, "height": 1440, "duration": 0, "hasAudio": False})
        start = round(index * total_frames / count) / fps
        end = round((index + 1) * total_frames / count) / fps
        clips.append({"id": f"clip-{index}", "assetId": asset_id, "trackId": "video-main",
            "in": 0, "out": end - start, "start": start, "speed": 1, "volume": 1, "muted": True,
            "fit": "contain", "background": "black", "filter": "none", "zoomAmount": 1.05,
            "zoom": "in" if index % 2 == 0 else "out", "transition": "fade" if index else "none",
            "transitionDuration": min(.45, (end - start) / 2)})
    audio = folder / "voice.wav"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        f"sine=frequency=440:duration={duration}", "-c:a", "pcm_s16le", str(audio)], check=True)
    assets.append({"id": "voice", "name": audio.name, "path": str(audio), "kind": "audio",
        "duration": duration, "hasAudio": True})
    text = "Questa prova riproduce un montaggio con immagini animate e sottotitoli.".split()
    words = [{"id": str(index), "text": text[index % len(text)], "start": index * .5,
        "end": min(duration, (index + 1) * .5)} for index in range(int(np.ceil(duration * 2)))]
    return {"aspectRatio": "16:9", "assets": assets, "clips": clips,
        "tracks": [{"id": "video-main", "kind": "video"}, {"id": "audio-main", "kind": "audio"}],
        "audioTracks": [{"id": "voiceclip", "assetId": "voice", "trackId": "audio-main",
            "in": 0, "out": duration, "start": 0, "volume": 1}],
        "subtitles": {"enabled": True, "words": words}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, default=3)
    parser.add_argument("--images", type=int, default=2)
    parser.add_argument("--fps", type=int, choices=(24, 25, 30, 50, 60), default=60)
    parser.add_argument("--resolution", choices=("720p", "1080p", "1440p", "2160p"), default="2160p")
    parser.add_argument("--acceleration", choices=("auto", "cpu"), default="auto")
    parser.add_argument("--compositor", choices=("auto", "cpu"), default="auto")
    parser.add_argument("--renderer", type=Path, default=ROOT / "engine/renderer.py")
    parser.add_argument("--folder", type=Path, default=ROOT / "test-results/slideshow-performance")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 0 < args.duration <= 3600 or not 1 <= args.images <= round(args.duration * args.fps):
        parser.error("Use a positive duration up to 3600 seconds and at least one frame per image.")
    duration = round(args.duration * args.fps) / args.fps
    folder = args.folder.resolve()
    spec = importlib.util.spec_from_file_location("slideshow_renderer", args.renderer.resolve())
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    project = fixture(folder, duration, args.images, args.fps, renderer.FFMPEG_EXE)
    settings = {"resolution": args.resolution, "fps": args.fps, "quality": "standard",
        "acceleration": args.acceleration, "_cpu_composition": args.compositor == "cpu"}
    report_path = args.output.resolve() if args.output else folder / "result.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    movie = report_path.with_suffix(".mp4")
    (folder / "project.json").write_text(json.dumps(project, indent=2), encoding="utf-8")
    last_progress = [0.0]

    def progress(value, message="", **metadata):
        if value - last_progress[0] >= .1 or value == 1:
            print(json.dumps({"progress": value, "message": message, **metadata}), flush=True)
            last_progress[0] = value

    progress.encoding_metadata = True
    started = time.perf_counter()
    result = renderer.render_project(project, settings, str(movie), progress, threading.Event())
    elapsed = time.perf_counter() - started
    probe = os.environ.get("DUCKY_FFPROBE_PATH", str(ROOT / "node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe"))
    metadata = json.loads(subprocess.check_output([probe, "-v", "error", "-show_entries",
        "stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames,duration:format=duration,size",
        "-of", "json", str(movie)], text=True))
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
    expected_width, expected_height = renderer._dimensions("16:9", args.resolution)
    expected_frames = round(duration * args.fps)
    assert (video["width"], video["height"]) == (expected_width, expected_height), "Wrong video dimensions"
    assert Fraction(video["r_frame_rate"]) == args.fps, "Wrong frame rate"
    assert int(video["nb_frames"]) == expected_frames, "Missing or extra video frames"
    assert video["codec_name"] == "h264" and audio["codec_name"] == "aac", "Wrong output codecs"
    assert abs(float(metadata["format"]["duration"]) - duration) < .1, "Wrong output duration"
    report = {"seconds": elapsed, "duration": duration, "frames": expected_frames,
        "fps": expected_frames / elapsed, "images": args.images, "renderer": str(args.renderer.resolve()),
        "python": sys.version, "settings": settings, "result": result, "probe": metadata}
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
