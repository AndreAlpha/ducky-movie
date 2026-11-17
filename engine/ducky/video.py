"""Lettura video con OpenCV: informazioni, frame singoli, strisce di miniature.

Sostituisce decord + moviepy + VLC + pygame del vecchio progetto: l'anteprima
vera e propria la fa il browser (streaming HTTP), qui servono solo i metadati,
i frame JPEG per lo scrubbing di fallback e le miniature della timeline.
"""

import threading
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np

PREVIEW_MAX_WIDTH = 1280
THUMB_HEIGHT = 90
JPEG_QUALITY = 82


@dataclass
class VideoInfo:
    path: str
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    size_bytes: int

    def to_dict(self) -> dict:
        return asdict(self)


class _CaptureCache:
    """Tiene aperti gli ultimi VideoCapture usati.

    Aprire un VideoCapture a ogni richiesta di frame costa centinaia di ms sui
    file grandi; lo scrubbing fa decine di richieste al secondo.
    """

    def __init__(self, max_items: int = 2):
        self._max = max_items
        self._lock = threading.Lock()
        self._items: dict[str, cv2.VideoCapture] = {}

    def get(self, path: str) -> cv2.VideoCapture:
        with self._lock:
            cap = self._items.pop(path, None)
            if cap is None or not cap.isOpened():
                cap = cv2.VideoCapture(path)
                if not cap.isOpened():
                    raise ValueError(f"Impossibile aprire il video: {path}")
            self._items[path] = cap  # reinserito in coda (LRU)
            while len(self._items) > self._max:
                oldest_key = next(iter(self._items))
                self._items.pop(oldest_key).release()
            return cap


_cache = _CaptureCache()
_read_lock = threading.Lock()  # un solo lettore alla volta sul capture condiviso


def probe(path: str) -> VideoInfo:
    """Metadati del video. Solleva ValueError se il file non è leggibile."""
    p = Path(path)
    if not p.is_file():
        raise ValueError(f"File non trovato: {path}")
    with _read_lock:
        cap = _cache.get(str(p))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(cap.get(cv2.CAP_PROP_FPS)) or 30.0
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if width <= 0 or height <= 0 or frame_count <= 0:
        raise ValueError(f"Video non valido o non leggibile: {path}")
    return VideoInfo(
        path=str(p),
        width=width,
        height=height,
        fps=fps,
        frame_count=frame_count,
        duration=frame_count / fps,
        size_bytes=p.stat().st_size,
    )


def _encode_jpeg(frame_bgr: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        raise ValueError("Codifica JPEG fallita.")
    return buf.tobytes()


def frame_at(path: str, t: float, inpaint=None) -> bytes:
    """Frame JPEG al tempo ``t`` (secondi), ridotto per l'anteprima.

    Se ``inpaint`` (Rect normalizzato) è dato, la zona viene rimossa con lo
    stesso algoritmo dell'estrazione: è l'anteprima live della rimozione.
    L'inpaint avviene DOPO il ridimensionamento, così resta fluido anche
    sui video 4K (il rettangolo è normalizzato, il risultato è equivalente).
    """
    with _read_lock:
        cap = _cache.get(path)
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000)
        ok, frame = cap.read()
        if not ok:
            # oltre la fine: riprova sull'ultimo frame disponibile
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total - 1))
            ok, frame = cap.read()
        if not ok:
            raise ValueError("Impossibile leggere il frame richiesto.")
    h, w = frame.shape[:2]
    if w > PREVIEW_MAX_WIDTH:
        scale = PREVIEW_MAX_WIDTH / w
        frame = cv2.resize(frame, (PREVIEW_MAX_WIDTH, int(h * scale)),
                           interpolation=cv2.INTER_AREA)
    if inpaint is not None:
        from .frames import apply_inpaint, inpaint_mask  # import pigro (no ciclo)
        ph, pw = frame.shape[:2]
        frame = apply_inpaint(frame, inpaint_mask(pw, ph, inpaint))
    return _encode_jpeg(frame)


_strip_cache: dict[tuple[str, int, float], bytes] = {}


def thumbnail_strip(path: str, count: int = 20) -> bytes:
    """Striscia orizzontale di ``count`` miniature equidistanti (un solo JPEG).

    Usata come sfondo della timeline nel browser: una richiesta sola invece di
    N. Il risultato è cacheato per (path, count, mtime).
    """
    count = max(1, min(count, 60))
    mtime = Path(path).stat().st_mtime
    key = (path, count, mtime)
    cached = _strip_cache.get(key)
    if cached is not None:
        return cached

    info = probe(path)
    thumb_w = max(1, int(THUMB_HEIGHT * info.width / info.height))
    thumbs = []
    with _read_lock:
        cap = _cache.get(path)
        for i in range(count):
            t = info.duration * (i + 0.5) / count
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = cap.read()
            if not ok:
                frame = np.zeros((info.height, info.width, 3), dtype=np.uint8)
            thumbs.append(cv2.resize(frame, (thumb_w, THUMB_HEIGHT),
                                     interpolation=cv2.INTER_AREA))
    strip = _encode_jpeg(cv2.hconcat(thumbs))

    _strip_cache.clear()  # basta l'ultima striscia, i video pesano
    _strip_cache[key] = strip
    return strip
