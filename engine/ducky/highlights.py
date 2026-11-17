"""Local highlight suggestions: sound/action, speech-safe edges and diversity.

Silero VAD is the small model already shipped with faster-whisper. It detects
speech, not meaning or speaker identity. No transcription/model download is
needed for this analysis. Energy-only boundary detection remains a fallback.
"""
import math
import bisect
import subprocess
from dataclasses import dataclass

import cv2
import numpy as np

from .config import FFMPEG_EXE
from .ffmpeg_tools import CREATE_NO_WINDOW, FfmpegError
from .video import probe
from .tracking import _scene_cut

BIN = .5
AUDIO_SR = 16000
MOTION_FPS = 2
MOTION_W, MOTION_H = 160, 90


@dataclass
class Candidate:
    start: float
    end: float
    score: float

    def to_dict(self):
        return {"start": round(self.start, 3), "end": round(self.end, 3), "score": round(self.score, 1)}


def _stream_ffmpeg(args, chunk_size, on_chunk, expected_chunks, on_progress=None,
                   progress_from=0, progress_to=1, cancel=None, partial=False):
    if not FFMPEG_EXE:
        raise FfmpegError("ffmpeg non trovato.")
    process = subprocess.Popen([FFMPEG_EXE, "-hide_banner", "-loglevel", "error", *args, "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
    done = 0
    try:
        while True:
            if cancel is not None and cancel.is_set():
                process.kill()
                raise InterruptedError("Analisi annullata.")
            chunk = process.stdout.read(chunk_size)
            if not chunk:
                break
            if len(chunk) == chunk_size or partial:
                on_chunk(chunk)
            done += 1
            if on_progress and expected_chunks:
                on_progress(progress_from + min(1, done / expected_chunks) * (progress_to - progress_from))
            if len(chunk) < chunk_size:
                break
    finally:
        process.stdout.close()
        process.wait()


def _merge_speech(intervals):
    merged = []
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if merged and start <= merged[-1][1] + .18:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def _audio_features(path, duration, on_progress, cancel, diagnostics=None):
    rms, speech = [], []
    offset = 0
    previous_tail = np.empty(0, np.float32)
    vad = None
    if diagnostics is not None:
        diagnostics["speechDetection"] = "none"
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
        vad_options = VadOptions(threshold=.5, min_speech_duration_ms=180,
            min_silence_duration_ms=280, speech_pad_ms=80)
        vad = lambda audio: get_speech_timestamps(audio, vad_options, sampling_rate=AUDIO_SR)
    except (ImportError, OSError):
        pass

    def consume(chunk):
        nonlocal offset, previous_tail, vad
        audio = np.frombuffer(chunk, np.int16).astype(np.float32) / 32768
        if diagnostics is not None:
            diagnostics["speechDetection"] = "energy"
        samples_per_bin = int(AUDIO_SR * BIN)
        for index in range(0, len(audio), samples_per_bin):
            sample = audio[index:index + samples_per_bin]
            rms.append(float(np.sqrt(np.mean(sample * sample))))
        if vad is not None:
            # One second of overlap joins speech spanning the bounded-memory
            # 30-second analysis blocks; it is not an artificial safe boundary.
            block = np.concatenate([previous_tail, audio])
            origin = offset - len(previous_tail) / AUDIO_SR
            try:
                for interval in vad(block):
                    speech.append((max(0, origin + interval["start"] / AUDIO_SR),
                        min(duration, origin + interval["end"] / AUDIO_SR)))
                if diagnostics is not None:
                    diagnostics["speechDetection"] = "silero"
            except (RuntimeError, ValueError, OSError):
                vad = None
                speech.clear()
            previous_tail = audio[-AUDIO_SR:]
        offset += len(audio) / AUDIO_SR

    _stream_ffmpeg(["-i", path, "-vn", "-ac", "1", "-ar", str(AUDIO_SR), "-f", "s16le"],
        AUDIO_SR * 30 * 2, consume, max(1, math.ceil(duration / 30)), on_progress, 0, .48, cancel, partial=True)
    return np.asarray(rms, np.float32), _merge_speech(speech)


def _motion_and_cuts(path, duration, on_progress, cancel):
    movement, cuts, signatures = [], [], []
    previous = None

    def consume(chunk):
        nonlocal previous
        frame = np.frombuffer(chunk, np.uint8).reshape(MOTION_H, MOTION_W, 3)
        cut = previous is not None and _scene_cut(previous, frame)
        difference = 0 if previous is None else float(np.mean(cv2.absdiff(frame, previous)))
        movement.append(min(difference, 20) if cut else difference)
        cuts.append(float(cut))
        histogram = cv2.calcHist([cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)], [0, 1], None, [8, 4], [0, 180, 0, 256])
        signatures.append(cv2.normalize(histogram, histogram, norm_type=cv2.NORM_L1).ravel())
        previous = frame

    _stream_ffmpeg(["-i", path, "-an", "-vf", f"fps={MOTION_FPS},scale={MOTION_W}:{MOTION_H}",
        "-f", "rawvideo", "-pix_fmt", "bgr24"], MOTION_W * MOTION_H * 3, consume,
        max(1, duration * MOTION_FPS), on_progress, .48, .9, cancel)
    return np.asarray(movement, np.float32), np.asarray(cuts, np.float32), np.asarray(signatures, np.float32)


def _rank(values):
    """Equal observations get equal ranks, including quiet/repeated scenes."""
    values = np.asarray(values, np.float32)
    if len(values) < 2 or float(np.ptp(values)) < 1e-10:
        return np.zeros_like(values)
    _, inverse, counts = np.unique(values, return_inverse=True, return_counts=True)
    average_rank = np.cumsum(counts) - (counts + 1) / 2
    return (average_rank[inverse] / (len(values) - 1)).astype(np.float32)


def _smooth(values, width):
    if not len(values):
        return values
    width = max(1, min(len(values), width))
    left = (width - 1) // 2
    return np.convolve(np.pad(values, (left, width - 1 - left), mode="edge"), np.ones(width) / width, mode="valid")


def _fit(values, count):
    if len(values) == count:
        return values
    if not len(values):
        return np.zeros(count, np.float32)
    return np.interp(np.linspace(0, len(values) - 1, count), np.arange(len(values)), values).astype(np.float32)


def _inside_speech(time, speech):
    return any(start + .06 < time < end - .06 for start, end in speech)


def propose_intervals(duration, count, target_duration, rms, motion, cuts, speech=(), signatures=None):
    """Deterministic planner separated from media/model I/O for regression tests."""
    duration, target = float(duration), max(.25, min(180, float(target_duration)))
    if not math.isfinite(duration) or duration <= 0 or not math.isfinite(target_duration):
        raise ValueError("Durata del video o dello short non valida.")
    count = max(1, min(20, int(count)))
    if duration <= target + min(2, target * .1) and duration <= 180:
        return [Candidate(0, duration, 100)]
    bins = max(1, math.ceil(duration / BIN))
    rms, motion, cuts = (_fit(np.asarray(values), bins) for values in (rms, motion, cuts))
    speech = _merge_speech(speech)
    speech_starts = [interval[0] for interval in speech]
    def inside_speech(time):
        index = bisect.bisect_right(speech_starts, time) - 1
        return index >= 0 and speech[index][0] + .06 < time < speech[index][1] - .06
    speech_coverage = np.zeros(bins, np.float32)
    for start, end in speech:
        speech_coverage[max(0, int(start / BIN)):min(bins, math.ceil(end / BIN))] = 1
    rise = np.maximum(0, np.diff(rms, prepend=rms[:1]))
    score = _smooth(.35 * _rank(rms) + .12 * _rank(rise) + .27 * _rank(motion) +
        .08 * _rank(_smooth(cuts, 12)) + .18 * speech_coverage, 5)
    quiet = _rank(rms) + .35 * _rank(motion)
    boundaries = {0.0, duration}
    for start, end in speech:
        boundaries.add(max(0, start - .08))
        boundaries.add(min(duration, end + .08))
    for index in np.flatnonzero(cuts):
        time = index * BIN
        if not inside_speech(time):
            boundaries.add(time)
    if not speech and float(np.ptp(quiet)) > .01:
        for index in range(1, bins - 1):
            if quiet[index] < quiet[index - 1] and quiet[index] <= quiet[index + 1]:
                boundaries.add(index * BIN)
    boundaries = np.asarray(sorted(boundaries), np.float64)
    radius = min(5, max(1, target * .15))
    minimum, maximum = min(target, max(.25, target * .7)), min(180, target + radius * 1.5)

    def snap(time, lower, upper):
        nearby = boundaries[(boundaries >= max(lower, time - radius)) & (boundaries <= min(upper, time + radius))]
        if len(nearby):
            return float(nearby[np.argmin(np.abs(nearby - time))])
        return min(upper, max(lower, time))

    starts = set(np.arange(0, max(.001, duration - minimum), BIN * 2).tolist())
    starts.update(float(value) for value in boundaries if value <= duration - minimum)
    starts.add(max(0, duration - target))
    prefix = np.r_[0, np.cumsum(score)]
    signature_prefix = None
    global_signature = None
    if signatures is not None and len(signatures):
        signature_prefix = np.vstack([np.zeros(signatures.shape[1]), np.cumsum(signatures, axis=0)])
        global_signature = np.mean(signatures, axis=0)
    pool = {}
    def add_candidate(start, end):
        if not minimum - .01 <= end - start <= maximum + .01:
            return
        first, last = max(0, int(start / BIN)), min(bins, max(1, math.ceil(end / BIN)))
        activity = float((prefix[last] - prefix[first]) / max(1, last - first))
        safe_edges = (int(not inside_speech(start)) + int(not inside_speech(end))) / 2
        quality = activity + .12 * safe_edges - .1 * abs(end - start - target) / max(1, target)
        if speech and safe_edges < 1:
            quality -= .18
        signature = None
        if signature_prefix is not None:
            a = min(len(signatures) - 1, int(start * MOTION_FPS))
            b = min(len(signatures), max(a + 1, math.ceil(end * MOTION_FPS)))
            signature = (signature_prefix[b] - signature_prefix[a]) / (b - a)
        key = (round(start, 3), round(end, 3))
        pool[key] = (Candidate(start, end, min(100, max(0, quality / .85 * 100))), quality, signature)
    for proposal in starts:
        start = snap(proposal, 0, duration - minimum)
        preferred_end = snap(start + target, start + minimum, min(duration, start + maximum))
        ends = set([preferred_end])
        nearby_ends = boundaries[(boundaries >= max(start + minimum, start + target - radius * 1.5)) &
            (boundaries <= min(duration, start + maximum, start + target + radius * 1.5))]
        ends.update(float(value) for value in nearby_ends)
        for end in sorted(ends):
            add_candidate(start, end)
    remaining = list(pool.values())
    selected = []
    gap = min(8, target * .2)
    for _ in range(count):
        available = [item for item in remaining if all(item[0].end + gap <= old[0].start + .001 or item[0].start >= old[0].end + gap - .001 for old in selected)]
        if not available:
            break
        def objective(item):
            candidate, quality, signature = item
            center = (candidate.start + candidate.end) / 2
            novelty = 0 if signature is None else 1 - float(np.minimum(signature, global_signature).sum())
            if not selected:
                return quality + .05 * novelty - .001 * abs(center / duration - .5)
            separation = min(abs(center - (old[0].start + old[0].end) / 2) / duration for old in selected)
            similarity = 0
            if signature is not None:
                similarities = [float(np.minimum(signature, old[2]).sum()) for old in selected if old[2] is not None]
                similarity = max(similarities, default=0)
            return quality + .05 * novelty + .10 * separation - .22 * similarity
        chosen = max(available, key=objective)
        selected.append(chosen)
        # Compare identity: tuple equality would compare numpy descriptors.
        remaining = [item for item in remaining if item is not chosen]
    if len(selected) < count and pool:
        # Greedy diversity may strand an otherwise usable interval between two
        # suggestions. Weighted interval scheduling recovers the requested count
        # when it fits, using the FINAL snapped intervals rather than estimates.
        ordered = sorted(pool.values(), key=lambda item: (item[0].end, item[0].start))
        ends = [item[0].end for item in ordered]
        compatible = [bisect.bisect_right(ends, item[0].start - gap + .001, hi=index) for index, item in enumerate(ordered)]
        scores = np.full((count + 1, len(ordered) + 1), -np.inf)
        scores[0, :] = 0
        choices = np.zeros_like(scores, dtype=bool)
        for number in range(1, count + 1):
            for index, item in enumerate(ordered, 1):
                take = scores[number - 1, compatible[index - 1]] + 1 + item[1]
                if take > scores[number, index - 1]:
                    scores[number, index] = take
                    choices[number, index] = True
                else:
                    scores[number, index] = scores[number, index - 1]
        number = max(number for number in range(count + 1) if np.isfinite(scores[number, -1]))
        if number > len(selected):
            selected, index = [], len(ordered)
            while number and index:
                if choices[number, index]:
                    selected.append(ordered[index - 1])
                    index = compatible[index - 1]
                    number -= 1
                else:
                    index -= 1
    if not selected:
        return [Candidate(0, min(target, duration), 0)]
    return sorted([item[0] for item in selected], key=lambda item: -item.score)


def analyze_and_propose(path, count=4, target_duration=40, on_progress=None, cancel=None, diagnostics=None):
    info = probe(path)
    if info.duration <= target_duration + min(2, target_duration * .1) and info.duration <= 180:
        if on_progress:
            on_progress(1)
        return propose_intervals(info.duration, count, target_duration, [], [], [])
    rms, speech = _audio_features(path, info.duration, on_progress, cancel, diagnostics)
    motion, cuts, signatures = _motion_and_cuts(path, info.duration, on_progress, cancel)
    if diagnostics is not None:
        diagnostics.update({"speechIntervals": len(speech), "sceneCuts": int(np.count_nonzero(cuts))})
    candidates = propose_intervals(info.duration, count, target_duration, rms, motion, cuts, speech, signatures)
    if on_progress:
        on_progress(1)
    return candidates
