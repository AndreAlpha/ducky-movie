"""Real H.264 hardware probes and encoder arguments; composition stays on CPU."""
from dataclasses import dataclass
from functools import lru_cache
import os
import subprocess

from .config import FFMPEG_EXE
from .ffmpeg_tools import CREATE_NO_WINDOW, FfmpegError, run_ffmpeg

ENCODERS = {"h264_nvenc": "NVIDIA NVENC", "h264_qsv": "Intel Quick Sync", "h264_amf": "AMD AMF", "libx264": "CPU"}


@dataclass
class EncodingChoice:
    encoder: str
    args: list[str]
    fallback: str | None = None

    def diagnostic(self):
        return {"encoder": self.encoder, "mode": "cpu" if self.encoder == "libx264" else "gpu",
            "label": ENCODERS[self.encoder], **({"fallback": self.fallback} if self.fallback else {})}


def encoder_args(encoder, quality="standard"):
    q = str(quality) if str(quality).isdigit() and 0 <= int(quality) <= 51 else "18" if quality == "high" else "23"
    options = {
        "h264_nvenc": ["-preset", "p4", "-rc", "vbr", "-cq", q, "-b:v", "0"],
        "h264_qsv": ["-preset", "medium", "-global_quality", q, "-look_ahead", "0"],
        "h264_amf": ["-quality", "balanced", "-rc", "cqp", "-qp_i", q, "-qp_p", q],
        "libx264": ["-preset", "fast", "-crf", q],
    }
    return ["-c:v", encoder, *options[encoder], "-profile:v", "high", "-pix_fmt",
        "nv12" if encoder in ("h264_qsv", "h264_amf") else "yuv420p"]


def cpu_encoding(quality="standard", fallback=None):
    return EncodingChoice("libx264", encoder_args("libx264", quality), fallback)


@lru_cache(maxsize=12)
def _probe_encoder(executable, modified, encoder):
    # This really initializes the device and encodes packets. Merely listing
    # ffmpeg -encoders would also advertise unavailable driver backends.
    command = [executable, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "color=c=black:s=1280x720:r=24", "-frames:v", "3", "-an", *encoder_args(encoder), "-f", "null", "-"]
    try:
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            timeout=8, creationflags=CREATE_NO_WINDOW)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def choose_encoding(settings=None, provided=None, cancel=None):
    settings = settings or {}
    quality = settings.get("quality", "standard")
    if settings.get("acceleration") == "cpu" or os.environ.get("DUCKY_ENCODER") == "cpu":
        return cpu_encoding(quality)
    if isinstance(provided, dict) and provided.get("encoder") in ENCODERS:
        encoder = provided["encoder"]
        # Generate our known arguments; the trusted Electron helper has already
        # proved this encoder, but request files cannot inject arbitrary flags.
        return EncodingChoice(encoder, encoder_args(encoder, quality), provided.get("fallback"))
    modified = os.path.getmtime(FFMPEG_EXE) if FFMPEG_EXE and os.path.isfile(FFMPEG_EXE) else 0
    for encoder in ("h264_nvenc", "h264_qsv", "h264_amf"):
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Esportazione annullata.")
        if FFMPEG_EXE and _probe_encoder(FFMPEG_EXE, modified, encoder):
            return EncodingChoice(encoder, encoder_args(encoder, quality))
    return cpu_encoding(quality, "Nessun encoder GPU utilizzabile; codifica CPU.")


def is_hardware_failure(error):
    message = str(error).lower()
    if any(token in message for token in ("no such filter", "error initializing filter", "unable to parse option", "unable to open")):
        return False
    return any(token in message for token in ("nvenc", "cuda", "nvencode", "qsv", "mfx", "amf", "device failed", "device lost", "hardware encoder", "unsupported device", "cannot allocate memory"))


def report_encoding(progress, value, choice, with_message=True):
    label = ENCODERS[choice.encoder]
    message = f"Composizione CPU · codifica {'CPU' if choice.encoder == 'libx264' else 'GPU ' + label}"
    if choice.fallback:
        message += " · ripiego CPU"
    if getattr(progress, "encoding_metadata", False):
        progress(value, message, encoder=choice.encoder, **({"fallback": choice.fallback} if choice.fallback else {}))
    elif with_message:
        progress(value, message)
    else:
        progress(value)


def run_encoded_ffmpeg(before, after, duration=None, on_progress=None, cancel=None, cwd=None, quality="standard", diagnostics=None):
    choice = choose_encoding({"quality": quality}, cancel=cancel)
    if diagnostics is not None:
        diagnostics["encoding"] = choice.diagnostic()
    if on_progress:
        report_encoding(on_progress, 0, choice, False)
    try:
        run_ffmpeg([*before, *choice.args, *after], duration=duration, on_progress=on_progress, cancel=cancel, cwd=cwd)
    except FfmpegError as error:
        if choice.encoder == "libx264" or not is_hardware_failure(error) or cancel is not None and cancel.is_set():
            raise
        choice = cpu_encoding(quality, f"{ENCODERS[choice.encoder]} non disponibile durante la codifica; ripiego CPU.")
        if diagnostics is not None:
            diagnostics["encoding"] = choice.diagnostic()
        if on_progress:
            report_encoding(on_progress, 0, choice, False)
        run_ffmpeg([*before, *choice.args, *after], duration=duration, on_progress=on_progress, cancel=cancel, cwd=cwd)
    return choice
