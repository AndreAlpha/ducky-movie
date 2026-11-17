"""Wrapper di ffmpeg: esecuzione con progresso reale, errori leggibili, annullamento.

Il vecchio codice lanciava ffmpeg scartando stderr e senza controllare il
codice di uscita: un errore produceva solo "nessun file di output" senza
spiegazioni. Qui ogni esecuzione:

- riporta il progresso reale (parsing di ``-progress``) invece di valori finti;
- solleva ``FfmpegError`` con la coda di stderr se ffmpeg fallisce;
- può essere annullata tramite un ``threading.Event``.
"""

import subprocess
import sys
import threading
from collections import deque
from collections.abc import Callable

from .config import FFMPEG_EXE

CREATE_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

ProgressFn = Callable[[float], None]


class FfmpegError(RuntimeError):
    pass


def _require_ffmpeg() -> str:
    if not FFMPEG_EXE:
        raise FfmpegError(
            "ffmpeg non trovato. Installalo (o installa il pacchetto Python "
            "'imageio-ffmpeg') e riavvia l'app."
        )
    return FFMPEG_EXE


def run_ffmpeg(
    args: list[str],
    duration: float | None = None,
    on_progress: ProgressFn | None = None,
    cancel: threading.Event | None = None,
    cwd: str | None = None,
) -> None:
    """Esegue ffmpeg con gli argomenti dati (senza il nome del programma).

    Se ``duration`` (secondi di output attesi) è nota, ``on_progress`` riceve
    valori 0..1 calcolati da ``out_time`` di ffmpeg. Con ``cwd`` il processo gira
    in quella cartella: utile per il filtro ``subtitles=`` (si passa il solo nome
    del file ASS, evitando l'escaping ostico dei path di Windows).
    """
    exe = _require_ffmpeg()
    cmd = [exe, "-hide_banner", "-y", *args]
    if on_progress and duration:
        cmd += ["-progress", "pipe:1", "-nostats"]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=cwd,
        creationflags=CREATE_NO_WINDOW,
    )

    stderr_tail: deque[str] = deque(maxlen=30)

    def _drain_stderr():
        for line in proc.stderr:
            stderr_tail.append(line.rstrip())

    err_thread = threading.Thread(target=_drain_stderr, daemon=True)
    err_thread.start()

    try:
        for line in proc.stdout:
            if cancel is not None and cancel.is_set():
                proc.terminate()
                break
            if on_progress and duration and line.startswith("out_time_ms="):
                value = line.split("=", 1)[1].strip()
                if value.isdigit():
                    done = int(value) / 1_000_000 / duration
                    on_progress(min(max(done, 0.0), 1.0))
    finally:
        proc.stdout.close()
        proc.wait()
        err_thread.join(timeout=2)
        proc.stderr.close()

    if cancel is not None and cancel.is_set():
        raise FfmpegError("Operazione annullata.")
    if proc.returncode != 0:
        detail = "\n".join(stderr_tail) or "nessun dettaglio disponibile"
        raise FfmpegError(f"ffmpeg è terminato con errore:\n{detail}")
    if on_progress:
        on_progress(1.0)


def remux_faststart(
    src: str,
    dst: str,
    duration: float | None = None,
    on_progress: ProgressFn | None = None,
    cancel: threading.Event | None = None,
) -> None:
    """Riscrive il contenitore spostando il moov atom all'inizio (faststart).

    Nessuna ricodifica: serve a rendere il file riproducibile in streaming.
    """
    run_ffmpeg(
        ["-i", src, "-c", "copy", "-movflags", "+faststart", dst],
        duration=duration,
        on_progress=on_progress,
        cancel=cancel,
    )
