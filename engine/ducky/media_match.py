"""Semantic matching for photos and sampled video frames.

The existing image matcher stays responsible for sentence windows and embeddings.
Video samples are temporary implementation details; every returned reference points
to the original library asset, with a finite source trim for video assignments.
"""

import math
import tempfile
import threading
from pathlib import Path

from . import videomake
from .config import IMAGE_INPUT_EXTENSIONS
from .ffmpeg_tools import run_ffmpeg
from .video import probe

IMAGE_EXTENSIONS = IMAGE_INPUT_EXTENSIONS | {".tif", ".tiff", ".avif", ".heic", ".heif"}


def rematch_media(images: list[str], words: list[dict], audio_duration: float,
                  dedup: bool = True, offtopic: float | None = None,
                  img_min: float | None = None, img_max: float | None = None,
                  on_progress=None, cancel: threading.Event | None = None,
                  script_text: str | None = None) -> dict:
    """Match native library photos/videos, retaining original paths and trims."""
    if not math.isfinite(audio_duration) or audio_duration <= 0:
        raise ValueError("La durata della narrazione non è valida.")
    paths = list(dict.fromkeys(str(Path(value)) for value in images))
    if not paths or len(paths) > 1000:
        raise ValueError("Seleziona da 1 a 1000 foto o video.")
    if any(not Path(value).is_file() for value in paths):
        raise ValueError("Uno dei media selezionati non è più disponibile.")
    with tempfile.TemporaryDirectory(prefix="duckymovie-match-") as folder:
        samples: list[str] = []
        source_by_sample: dict[str, tuple[str, float | None, float | None]] = {}
        for index, source in enumerate(paths):
            videomake._check_cancel(cancel)
            if Path(source).suffix.lower() in IMAGE_EXTENSIONS:
                sample = source
                if Path(source).suffix.lower() not in IMAGE_INPUT_EXTENSIONS:
                    sample = str(Path(folder) / f"{index:05d}-photo.jpg")
                    try:
                        run_ffmpeg(["-i", source, "-frames:v", "1", "-vf",
                                    "scale=640:640:force_original_aspect_ratio=decrease", sample], cancel=cancel)
                    except Exception as error:
                        videomake._check_cancel(cancel)
                        raise ValueError(f"Immagine non decodificabile per l'analisi: {Path(source).name}") from error
                samples.append(sample)
                source_by_sample[sample] = (source, None, None)
            else:
                info = probe(source)
                if not math.isfinite(info.duration) or info.duration <= 0:
                    raise ValueError(f"Video senza durata valida: {Path(source).name}")
                # One sample is enough for a very short clip. Longer video uses
                # three separated moments so matching can select relevant action.
                fractions = (.5,) if info.duration < 2 else (.15, .5, .85)
                for sample_index, fraction in enumerate(fractions):
                    videomake._check_cancel(cancel)
                    timestamp = min(max(0, info.duration * fraction), max(0, info.duration - .04))
                    sample = str(Path(folder) / f"{index:05d}-{sample_index}.jpg")
                    run_ffmpeg(["-ss", str(timestamp), "-i", source, "-frames:v", "1",
                                "-vf", "scale=640:640:force_original_aspect_ratio=decrease",
                                "-q:v", "3", sample], cancel=cancel)
                    if not Path(sample).is_file():
                        raise ValueError(f"Impossibile analizzare il video: {Path(source).name}")
                    samples.append(sample)
                    source_by_sample[sample] = (source, timestamp, info.duration)
            if on_progress:
                on_progress(.12 * (index + 1) / len(paths))
        result = videomake.rematch(samples, words, audio_duration, dedup=dedup,
                                   offtopic=offtopic, img_min=img_min, img_max=img_max,
                                   on_progress=videomake._band(on_progress, .12, 1),
                                   cancel=cancel, script_text=script_text)
        segments = []
        for segment in result.get("segments", []):
            source, timestamp, duration = source_by_sample[segment["source"]]
            mapped = {**segment, "source": source, "type": "video" if timestamp is not None else "image"}
            if timestamp is not None:
                span = max(0, float(segment["end"]) - float(segment["start"]))
                # A window may exceed a short source. The native planner fills
                # that remainder with another asset instead of freezing its frame.
                source_in = max(0, min(duration - min(span, duration), timestamp - span / 2))
                mapped["sourceIn"] = round(source_in, 6)
                mapped["sourceDuration"] = duration
            segments.append(mapped)
        statuses: dict[str, str] = {}
        priority = {"dup": 0, "offtopic": 1, "unused": 2, "used": 3}
        for media in result.get("media", []):
            source = source_by_sample[media["path"]][0]
            status = media.get("status", "unused")
            if source not in statuses or priority.get(status, 0) > priority.get(statuses[source], 0):
                statuses[source] = status
        return {**result, "segments": segments,
                "media": [{"path": source, "type": "image" if Path(source).suffix.lower() in IMAGE_EXTENSIONS else "video",
                           "status": statuses.get(source, "unused")} for source in paths]}
