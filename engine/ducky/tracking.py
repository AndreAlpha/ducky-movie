"""Local subject association and shot-aware vertical camera planning."""
from dataclasses import dataclass, field
from functools import lru_cache
import math
import subprocess

import cv2
import numpy as np

from .config import FFMPEG_EXE
from .ffmpeg_tools import CREATE_NO_WINDOW, FfmpegError

SAMPLE_FPS = 8


@dataclass
class Detection:
    x: float
    y: float
    w: float
    h: float
    confidence: float = 1.0
    kind: str = "face"
    appearance: np.ndarray | None = None

    @property
    def center(self):
        return np.array([self.x + self.w / 2, self.y + self.h / 2], np.float64)


@dataclass
class TrackingPlan:
    times: np.ndarray
    centers: np.ndarray
    widths: np.ndarray
    cuts: np.ndarray
    stats: dict = field(default_factory=dict)

    def at(self, time):
        right = int(np.searchsorted(self.times, time, side="right"))
        if right == 0:
            return self.centers[0], self.widths[0]
        if right >= len(self.times):
            return self.centers[-1], self.widths[-1]
        left = right - 1
        if self.cuts[right]:
            return self.centers[left], self.widths[left]
        alpha = (time - self.times[left]) / max(1e-6, self.times[right] - self.times[left])
        return self.centers[left] * (1 - alpha) + self.centers[right] * alpha, float(self.widths[left] * (1 - alpha) + self.widths[right] * alpha)


def _box_iou(first, second):
    left, top = max(first.x, second.x), max(first.y, second.y)
    right, bottom = min(first.x + first.w, second.x + second.w), min(first.y + first.h, second.y + second.h)
    intersection = max(0, right - left) * max(0, bottom - top)
    return intersection / max(1e-8, first.w * first.h + second.w * second.h - intersection)


def _clip_box(box):
    box.x = max(0.0, min(.99, box.x))
    box.y = max(0.0, min(.99, box.y))
    box.w = max(.01, min(1 - box.x, box.w))
    box.h = max(.01, min(1 - box.y, box.h))
    return box


def _histogram(frame, box):
    height, width = frame.shape[:2]
    x, y = int(box.x * width), int(box.y * height)
    right = min(width, max(x + 1, round((box.x + box.w) * width)))
    bottom = min(height, max(y + 1, round((box.y + box.h) * height)))
    roi = frame[y:bottom, x:right]
    if not roi.size:
        return None
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256])
    return cv2.normalize(histogram, histogram, norm_type=cv2.NORM_L1)


@lru_cache(maxsize=4)
def _cascade(filename):
    result = cv2.CascadeClassifier(cv2.data.haarcascades + filename)
    return result if not result.empty() else None


class SubjectDetector:
    def __init__(self):
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    def __call__(self, frame, index):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        height, width = gray.shape
        detections = []
        for filename, confidence in [("haarcascade_frontalface_default.xml", 1.0), ("haarcascade_profileface.xml", .85)]:
            detector = _cascade(filename)
            if detector is None:
                continue
            for x, y, w, h in detector.detectMultiScale(gray, scaleFactor=1.12, minNeighbors=5, minSize=(20, 20)):
                face = _clip_box(Detection(x / width, y / height, w / width, h / height, confidence, "face"))
                if any(_box_iou(face, old) > .3 for old in detections):
                    continue
                # Include the upper torso in the appearance descriptor.
                torso = _clip_box(Detection((x - w * .45) / width, y / height, w * 1.9 / width, h * 3.4 / height))
                face.appearance = _histogram(frame, torso)
                detections.append(face)
        if not detections and index % 3 == 0 and width >= 64 and height >= 128:
            boxes, weights = self.hog.detectMultiScale(frame, hitThreshold=.35, winStride=(8, 8), padding=(8, 8), scale=1.08)
            for (x, y, w, h), weight in zip(boxes, weights):
                person = _clip_box(Detection(x / width, y / height, w / width, h / height, min(.9, .5 + float(weight) * .12), "person"))
                person.appearance = _histogram(frame, person)
                detections.append(person)
        return detections


def _scene_cut(previous, current):
    first = cv2.resize(previous, (64, 36))
    second = cv2.resize(current, (64, 36))
    first_gray = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY).astype(np.float32)
    second_gray = cv2.cvtColor(second, cv2.COLOR_BGR2GRAY).astype(np.float32)
    difference = float(np.mean(np.abs(first_gray - second_gray)))
    color_difference = float(np.mean(np.abs(first.astype(np.float32) - second.astype(np.float32))))
    first_hist = cv2.calcHist([cv2.cvtColor(first, cv2.COLOR_BGR2HSV)], [0, 1], None, [16, 8], [0, 180, 0, 256])
    second_hist = cv2.calcHist([cv2.cvtColor(second, cv2.COLOR_BGR2HSV)], [0, 1], None, [16, 8], [0, 180, 0, 256])
    cv2.normalize(first_hist, first_hist, norm_type=cv2.NORM_L1)
    cv2.normalize(second_hist, second_hist, norm_type=cv2.NORM_L1)
    histogram_distance = cv2.compareHist(first_hist, second_hist, cv2.HISTCMP_BHATTACHARYYA)
    first_centered, second_centered = first_gray - first_gray.mean(), second_gray - second_gray.mean()
    correlation = float(np.sum(first_centered * second_centered) / max(1, np.linalg.norm(first_centered) * np.linalg.norm(second_centered)))
    return bool(color_difference > 28 and histogram_distance > .62 or difference > 48 and correlation < .18)


def _flow(previous, current, box=None):
    height, width = previous.shape
    mask = None
    if box is not None:
        mask = np.zeros_like(previous)
        x, y = max(0, int((box.x - box.w * .2) * width)), max(0, int((box.y - box.h * .2) * height))
        right, bottom = min(width, int((box.x + box.w * 1.2) * width)), min(height, int((box.y + box.h * 1.2) * height))
        mask[y:bottom, x:right] = 255
    points = cv2.goodFeaturesToTrack(previous, maxCorners=100, qualityLevel=.01, minDistance=4, mask=mask)
    if points is None or len(points) < 3:
        return None
    if box is None:
        # A small moving subject is not camera motion. Only compensate global
        # flow when features cover a substantial part of the background.
        spread = np.ptp(points[:, 0], axis=0) / np.array([width, height])
        if spread[0] * spread[1] < .22:
            return None
    following, status, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, None, winSize=(25, 25), maxLevel=3)
    if following is None:
        return None
    backward, reverse_status, _ = cv2.calcOpticalFlowPyrLK(current, previous, following, None, winSize=(25, 25), maxLevel=3)
    if backward is None:
        return None
    good = status.ravel().astype(bool) & reverse_status.ravel().astype(bool) & (np.linalg.norm(backward - points, axis=2).ravel() < 1.8)
    if np.count_nonzero(good) < 3:
        return None
    displacement = following[good, 0] - points[good, 0]
    median = np.median(displacement, axis=0)
    inliers = np.linalg.norm(displacement - median, axis=1) < 5
    if np.count_nonzero(inliers) < 3:
        return None
    return np.median(displacement[inliers], axis=0) / np.array([width, height])


def _motion_detections(previous, current):
    previous_gray = cv2.cvtColor(previous, cv2.COLOR_BGR2GRAY)
    current_gray = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)
    movement = _flow(previous_gray, current_gray)
    if movement is not None:
        height, width = current_gray.shape
        transform = np.array([[1, 0, movement[0] * width], [0, 1, movement[1] * height]], np.float32)
        previous_gray = cv2.warpAffine(previous_gray, transform, (width, height), borderMode=cv2.BORDER_REPLICATE)
    difference = cv2.absdiff(previous_gray, current_gray)
    mask = cv2.threshold(difference, 20, 255, cv2.THRESH_BINARY)[1]
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.dilate(mask, np.ones((9, 9), np.uint8))
    height, width = mask.shape
    detections = []
    for contour in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, w, h = cv2.boundingRect(contour)
        if .002 < w * h / (width * height) < .55 and w >= 8 and h >= 8:
            detection = Detection(x / width, y / height, w / width, h / height, .35, "motion")
            detection.appearance = _histogram(current, detection)
            detections.append(detection)
    return detections


class TargetAssociation:
    def __init__(self, options=None):
        self.options = options or {}
        self.box = None
        self.velocity = np.zeros(2)
        self.appearance = None
        self.missing = 0.0
        self.challenger = None
        self.challenger_frames = 0

    def reset(self):
        self.box = None
        self.velocity[:] = 0
        self.appearance = None
        self.missing = 0
        self.challenger = None
        self.challenger_frames = 0

    def _initial(self, detections, manual):
        if not detections:
            return None
        focus = np.array([self.options.get("focusX", .5), self.options.get("focusY", .4)])
        if manual:
            closest = min(detections, key=lambda candidate: np.linalg.norm((candidate.center - focus) * np.array([1, .5])))
            # A click on an unrecognized subject must not select a distant
            # recognized face elsewhere in the frame.
            return closest if np.linalg.norm((closest.center - focus) * np.array([1, .5])) <= .18 else None
        return max(detections, key=lambda candidate: candidate.confidence + .45 * math.sqrt(candidate.w * candidate.h) - .25 * abs(candidate.center[0] - .5))

    def update(self, detections, dt, flow=None, initial=False):
        if self.box is None:
            selected = self._initial(detections, initial and "focusX" in self.options)
            if selected is not None:
                self.box = selected
                self.appearance = selected.appearance
                return selected, selected.confidence
            if initial and "focusX" in self.options:
                x, y = self.options["focusX"], self.options.get("focusY", .4)
                self.box = _clip_box(Detection(x - .07, y - .12, .14, .24, .45, "manual"))
                return self.box, .45
            return None, 0
        prediction = self.box.center + self.velocity * dt
        if flow is not None:
            prediction = self.box.center + flow
        candidates = []
        for candidate in detections:
            distance = np.linalg.norm((candidate.center - prediction) * np.array([1, .4]))
            appearance = 0.0
            if self.appearance is not None and candidate.appearance is not None:
                appearance = cv2.compareHist(self.appearance, candidate.appearance, cv2.HISTCMP_BHATTACHARYYA)
            size_change = abs(math.log(max(.001, candidate.w) / max(.001, self.box.w)))
            cost = distance * 2.4 + appearance * .6 + min(size_change, 2) * .08 - candidate.confidence * .08
            limit = .2 + min(self.missing, 1.5) * .15
            if distance <= limit and (appearance < .78 or distance < .035):
                candidates.append((cost, candidate))
        if candidates:
            _, selected = min(candidates, key=lambda entry: entry[0])
            old_center = self.box.center
            observed_velocity = (selected.center - old_center) / max(dt, .001)
            self.velocity = np.clip(self.velocity * .65 + observed_velocity * .35, -.9, .9)
            self.box = selected
            if selected.appearance is not None:
                self.appearance = selected.appearance if self.appearance is None else self.appearance * .92 + selected.appearance * .08
            self.missing = 0
            self.challenger_frames = 0
            return selected, selected.confidence
        self.missing += dt
        displacement = flow if flow is not None else self.velocity * dt * math.exp(-self.missing * 2)
        self.box = _clip_box(Detection(self.box.x + displacement[0], self.box.y + displacement[1], self.box.w, self.box.h, .35, self.box.kind, self.appearance))
        if flow is None:
            self.velocity *= .82
        if self.missing > 2.5 and detections and (flow is None or self.missing > 5):
            alternative = min(detections, key=lambda candidate: abs(candidate.center[0] - self.box.center[0]))
            if self.challenger is not None and np.linalg.norm(alternative.center - self.challenger.center) < .12:
                self.challenger_frames += 1
            else:
                self.challenger_frames = 1
            self.challenger = alternative
            if self.challenger_frames >= 3:
                self.box, self.appearance = alternative, alternative.appearance
                self.velocity[:] = 0
                self.missing = 0
        return self.box, .5 if flow is not None else .15


def _camera_path(observations, widths, cuts, base_width, source_aspect, options):
    centers = []
    framed_widths = []
    camera = None
    velocity = np.zeros(2)
    width = base_width
    responsive = options.get("sensitivity") == "responsive"
    response = .14 if responsive else .3
    maximum_speed = 1.0 if responsive else .72
    acceleration = 4.0 if responsive else 2.4
    dt = 1 / SAMPLE_FPS
    for index, target in enumerate(observations):
        desired = np.asarray(target, np.float64)
        requested_width = max(base_width, min(1, widths[index]))
        if camera is None or cuts[index]:
            camera = desired.copy()
            velocity[:] = 0
            width = requested_width
        else:
            width += (requested_width - width) * (1 - math.exp(-dt / (.18 if requested_width > width else 1.1)))
            difference = desired - camera
            dead_zone = np.array([width * .1, min(1, width * source_aspect * 16 / 9) * .09])
            offset = np.sign(difference) * np.maximum(0, np.abs(difference) - dead_zone)
            wanted_velocity = np.clip(offset / response, -maximum_speed, maximum_speed)
            velocity += np.clip(wanted_velocity - velocity, -acceleration * dt, acceleration * dt)
            camera += velocity * dt
            # The subject stays within the safe portion even during fast motion.
            camera[0] = np.clip(camera[0], desired[0] - width * .4, desired[0] + width * .4)
        half_width = width / 2
        half_height = min(1, width * source_aspect * 16 / 9) / 2
        camera[0] = np.clip(camera[0], half_width, 1 - half_width)
        camera[1] = np.clip(camera[1], half_height, 1 - half_height)
        centers.append(camera.copy())
        framed_widths.append(width)
    return np.asarray(centers), np.asarray(framed_widths)


def analyze_frames(frames, source_width, source_height, options=None, detector=None, on_sample=None):
    options = validate_options(options)
    detector = detector or SubjectDetector()
    association = TargetAssociation(options)
    base_width = min(1, source_height * 9 / 16 / source_width)
    observations, widths, cuts = [], [], []
    previous = None
    stats = {"samples": 0, "sceneCuts": 0, "faceSamples": 0, "personSamples": 0, "motionSamples": 0, "flowSamples": 0, "heldSamples": 0, "wideSamples": 0}
    persistent_group = []
    last_group_sample = -100
    for index, frame in enumerate(frames):
        cut = previous is not None and _scene_cut(previous, frame)
        if cut:
            association.reset()
            persistent_group = []
            last_group_sample = -100
            stats["sceneCuts"] += 1
        detections = detector(frame, index)
        flow = None
        if previous is not None and not cut:
            if association.box is not None:
                flow = _flow(cv2.cvtColor(previous, cv2.COLOR_BGR2GRAY), cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), association.box)
            if not detections:
                detections = _motion_detections(previous, frame)
        target, confidence = association.update(detections, 1 / SAMPLE_FPS, flow, initial=index == 0)
        if target is not None and target.kind == "manual" and association.appearance is None:
            association.appearance = target.appearance = _histogram(frame, target)
        if target is None:
            center = np.array([options.get("focusX", .5), options.get("focusY", .5)])
            view_width = base_width
            stats["heldSamples"] += 1
        else:
            center = target.center
            view_width = max(base_width, target.w * 1.6 if target.kind in ("face", "person") else base_width)
            people = [candidate for candidate in detections if candidate.kind in ("face", "person")]
            if options.get("mode") == "group" and len(people) >= 2:
                persistent_group = people
                last_group_sample = index
            elif options.get("mode") == "group" and persistent_group and index - last_group_sample <= SAMPLE_FPS:
                people = persistent_group
            if options.get("mode") == "group" and len(people) >= 2:
                left, right = min(person.x for person in people), max(person.x + person.w for person in people)
                center = np.array([(left + right) / 2, .5])
                view_width = max(base_width, min(1, right - left + .12))
            if view_width > base_width + .02:
                stats["wideSamples"] += 1
            if target.kind == "face" and confidence > .5:
                stats["faceSamples"] += 1
            elif target.kind == "person" and confidence > .5:
                stats["personSamples"] += 1
            elif target.kind == "motion" and confidence > .3:
                stats["motionSamples"] += 1
            elif flow is not None:
                stats["flowSamples"] += 1
            else:
                stats["heldSamples"] += 1
        observations.append(center)
        widths.append(view_width)
        cuts.append(cut)
        previous = frame
        stats["samples"] += 1
        if on_sample:
            on_sample(index + 1)
    if not observations:
        raise FfmpegError("Nessun fotogramma disponibile per l'inquadratura.")
    centers, framed_widths = _camera_path(observations, widths, cuts, base_width, source_width / source_height, options)
    return TrackingPlan(np.arange(len(centers)) / SAMPLE_FPS, centers, framed_widths, np.asarray(cuts, bool), stats)


def validate_options(options):
    if options is None:
        return {}
    if not isinstance(options, dict):
        raise ValueError("Opzioni di inquadratura non valide.")
    clean = {"mode": options.get("mode", "person"), "sensitivity": options.get("sensitivity", "steady")}
    if clean["mode"] not in ("person", "group") or clean["sensitivity"] not in ("steady", "responsive"):
        raise ValueError("Modalità di inquadratura non valida.")
    for key in ("focusX", "focusY"):
        if key in options:
            value = float(options[key])
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError("Punto di inquadratura non valido.")
            clean[key] = value
    return clean


def track_video(info, start, end, options=None, on_progress=None, cancel=None):
    scale = min(640 / info.width, 360 / info.height)
    width, height = max(2, round(info.width * scale / 2) * 2), max(2, round(info.height * scale / 2) * 2)
    process = subprocess.Popen([FFMPEG_EXE, "-hide_banner", "-loglevel", "error", "-ss", str(start), "-t", str(end - start), "-i", info.path,
        "-an", "-vf", f"fps={SAMPLE_FPS},scale={width}:{height}", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
    def frames():
        while True:
            if cancel is not None and cancel.is_set():
                process.kill()
                raise InterruptedError("Generazione annullata.")
            data = process.stdout.read(width * height * 3)
            if len(data) < width * height * 3:
                break
            yield np.frombuffer(data, np.uint8).reshape(height, width, 3)
    try:
        expected = max(1, (end - start) * SAMPLE_FPS)
        return analyze_frames(frames(), info.width, info.height, options,
            on_sample=lambda done: on_progress(.18 * min(1, done / expected)) if on_progress else None)
    finally:
        process.stdout.close()
        process.wait()


def frame_for_view(frame, center, view_width, output_width=1080, output_height=1920):
    height, width = frame.shape[:2]
    crop_width = max(2, min(width, round(view_width * width)))
    desired_height = crop_width * output_height / output_width
    crop_height = max(2, min(height, round(desired_height)))
    x = max(0, min(width - crop_width, round(center[0] * width - crop_width / 2)))
    y = max(0, min(height - crop_height, round(center[1] * height - crop_height / 2)))
    cropped = frame[y:y + crop_height, x:x + crop_width]
    if desired_height <= height + 1:
        return cv2.resize(cropped, (output_width, output_height), interpolation=cv2.INTER_CUBIC)
    background_scale = max(output_width / width, output_height / height)
    background = cv2.resize(frame, (max(output_width, round(width * background_scale)), max(output_height, round(height * background_scale))))
    left, top = (background.shape[1] - output_width) // 2, (background.shape[0] - output_height) // 2
    background = cv2.GaussianBlur(background[top:top + output_height, left:left + output_width], (0, 0), output_width * .025)
    foreground_height = max(1, round(crop_height * output_width / crop_width))
    foreground = cv2.resize(cropped, (output_width, foreground_height), interpolation=cv2.INTER_CUBIC)
    top = (output_height - foreground_height) // 2
    background[top:top + foreground_height] = foreground
    return background
