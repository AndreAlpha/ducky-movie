"""Video Make: da immagini/clip + copione + audio + intro/outro + logo a un MP4.

Struttura del risultato:

    [intro] → [montaggio immagini/clip con narrazione] → [outro]

Il montaggio mostra i media *in ordine*: le immagini durano 3–4 s a seconda della
frase pronunciata (tempi dalla trascrizione), con uno zoom Ken Burns non invadente
sul soggetto; le clip video durano quanto il loro trim/velocità. Tra un media e
l'altro c'è un crossfade; il logo è sovrimpresso in basso a destra. Si può
ribaltare orizzontalmente l'intero video o il singolo media (modalità a specchio)
e bruciare sottotitoli karaoke che evidenziano la parola pronunciata.

Il montaggio è renderizzato come in ``shorts.py``: i frame vengono generati in
Python (OpenCV) e inviati grezzi in pipe a un solo encoder ffmpeg, con la
narrazione come traccia audio e i sottotitoli ASS bruciati col filtro
``subtitles``. Intro e outro vengono normalizzati alla risoluzione/fps scelti e
infine assemblati con un filtergraph (audio: voce + eventuale audio delle clip +
musica di sottofondo con ducking).
"""

import functools
import math
import os
import re
import subprocess
import tempfile
import threading
import wave
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from . import semantic
from .tempo import _atempo_chain
from .config import (CROSSFADE_SECONDS, FFMPEG_EXE, IMAGE_INPUT_EXTENSIONS,
                     IMAGE_MAX_SECONDS, LOGO_MARGIN_FRAC, LOGO_WIDTH_FRAC,
                     MUSIC_DEFAULT_DUCK, MUSIC_DEFAULT_VOLUME,
                     OFFTOPIC_SIMILARITY, OUTRO_TAIL_SECONDS,
                     SUBTITLE_DEFAULT_STYLE, SUBTITLE_MAX_LINES,
                     SUBTITLE_MAX_WORDS, VIDEO_MAKE_FILE_NAME, X264_PRESET,
                     ZOOM_MAX_SCALE)
from .ffmpeg_tools import CREATE_NO_WINDOW, FfmpegError, run_ffmpeg
from .shorts import _face_cascade
from .utils import natural_key
from .video import probe

VM_CRF = "20"
JOIN_FADE = 0.5             # crossfade intro→montaggio e montaggio→outro
MIN_SEG = 0.5              # durata minima di un segmento (s)


# ----------------------------------------------------------------- utilità

def _band(on_progress, lo: float, hi: float):
    """Mappa il progresso 0..1 di una fase nella banda [lo, hi] globale."""
    if on_progress is None:
        return None
    return lambda f: on_progress(lo + (hi - lo) * min(max(f, 0.0), 1.0))


def _check_cancel(cancel: threading.Event | None, msg: str = "Operazione annullata."):
    if cancel is not None and cancel.is_set():
        raise InterruptedError(msg)


def _wav_duration(path: str) -> float:
    with wave.open(path, "rb") as w:
        frames, rate = w.getnframes(), w.getframerate()
    if rate <= 0:
        raise ValueError("Audio WAV non valido (frequenza di campionamento nulla).")
    return frames / rate


def _project_audios(project: dict) -> list[dict]:
    """Blocchi audio (narrazione) del progetto. Migra i progetti vecchi (un solo
    ``audio``/``audio_duration``) al nuovo schema ``audios`` (lista di blocchi
    spostabili/ritagliabili sulla timeline)."""
    audios = project.get("audios")
    if audios:
        return audios
    path = project.get("audio")
    if not path:
        return []
    dur = float(project.get("audio_duration") or _wav_duration(path))
    return [{"path": path, "start": 0.0, "in": 0.0, "out": dur,
             "src_dur": dur, "words": project.get("words") or []}]


def _has_audio(path: str) -> bool:
    """Vero se il file contiene almeno una traccia audio (parsing di ffmpeg -i)."""
    proc = subprocess.run([FFMPEG_EXE, "-hide_banner", "-i", path],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", creationflags=CREATE_NO_WINDOW)
    return "Audio:" in (proc.stderr or "")


def _load_bgr(path: str) -> np.ndarray:
    """Carica un'immagine come array BGR (PIL: gestisce unicode, webp, EXIF)."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        rgb = np.asarray(im)
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


# ----------------------------------------------------------------- segmenti

@dataclass
class Segment:
    """Un media sulla timeline del montaggio (immagine o clip video)."""
    type: str                 # "image" | "clip"
    source: str
    start: float
    end: float
    mirror: bool = False      # ribaltamento orizzontale del SINGOLO media
    # immagine
    zoom_in: bool = True
    no_zoom: bool = False      # nessun effetto Ken Burns: immagine statica
    # clip video
    in_: float = 0.0          # trim: inizio nella sorgente (s)
    out: float = 0.0          # trim: fine nella sorgente (s)
    speed: float = 1.0
    crop: dict | None = None  # ritaglio normalizzato {x,y,w,h}
    use_audio: bool = False   # mixa l'audio della clip con la narrazione
    transition: str = "fade"  # transizione in ingresso ("fade" | "none")

    @property
    def base_duration(self) -> float:
        """Durata 'naturale': per le clip è fissa (trim/velocità), per le
        immagini è la durata corrente (flessibile, verrà ridistribuita)."""
        if self.type == "clip":
            span = max(0.05, self.out - self.in_)
            return max(MIN_SEG, span / max(0.05, self.speed))
        return max(MIN_SEG, self.end - self.start)


def _build_segments(windows, assignment, kept_paths) -> list[Segment]:
    """Unisce finestre consecutive con la stessa immagine in un unico segmento."""
    segments: list[Segment] = []
    for j, img_idx in enumerate(assignment.window_image):
        win = windows[j]
        path = kept_paths[img_idx]
        if segments and segments[-1].source == path:
            segments[-1].end = win.end
        else:
            segments.append(Segment(
                type="image", source=path, start=win.start, end=win.end,
                zoom_in=(len(segments) % 2 == 0)))
    return segments


def _fill_long_segments(segments: list[Segment], pool_paths: list[str],
                        img_max: float) -> list[Segment]:
    """Rispetta la durata massima per immagine: ogni segmento più lungo di
    ``img_max`` viene spezzato in più pezzi (≤ img_max) e i pezzi extra vengono
    riempiti con altre immagini disponibili (non usate, fuori tema, duplicate).

    Così, invece di tenere a lungo la stessa immagine, si usano anche gli scarti
    quando servono — come richiesto. Se le immagini extra finiscono, il pezzo
    ripiega sull'immagine originale.
    """
    img_max = max(1.0, float(img_max))
    pool = list(pool_paths)
    pi = 0
    out: list[Segment] = []
    for seg in segments:
        dur = seg.end - seg.start
        n = max(1, int(math.ceil(dur / img_max - 1e-6)))
        if seg.type != "image" or n <= 1 or pi >= len(pool):
            seg.zoom_in = (len(out) % 2 == 0)
            out.append(seg)
            continue
        piece = dur / n
        for k in range(n):
            s0 = seg.start + k * piece
            s1 = seg.end if k == n - 1 else seg.start + (k + 1) * piece
            if k == 0:
                src = seg.source
            elif pi < len(pool):
                src = pool[pi]
                pi += 1
            else:
                src = seg.source
            out.append(Segment(type="image", source=src, start=s0, end=s1,
                               zoom_in=(len(out) % 2 == 0)))
    return out


def _segment_from_dict(d: dict) -> Segment:
    """Costruisce un Segment dal JSON del progetto (tollera lo schema vecchio)."""
    stype = d.get("type") or "image"
    source = d.get("source") or d.get("image")
    crop = d.get("crop")
    if crop and not (crop.get("w", 0) > 0 and crop.get("h", 0) > 0):
        crop = None
    return Segment(
        type=stype, source=source,
        start=float(d.get("start", 0.0)), end=float(d.get("end", 0.0)),
        mirror=bool(d.get("mirror", False)),
        zoom_in=bool(d.get("zoom_in", True)),
        no_zoom=bool(d.get("no_zoom", False)),
        in_=float(d.get("in", 0.0)), out=float(d.get("out", 0.0)),
        speed=float(d.get("speed", 1.0) or 1.0), crop=crop,
        use_audio=bool(d.get("use_audio", False)),
        transition=d.get("transition", "fade"))


def _layout_with_gaps(segments: list[Segment], t_audio: float) -> list[Segment]:
    """Rispetta le posizioni ESPLICITE (start/end) dei segmenti: la timeline può
    avere SPAZI VUOTI (modalità manuale) — niente più stretch forzato a riempire
    l'audio. Ordina, sanifica (dentro [0,t_audio], niente sovrapposizioni) e riempie
    i buchi (e la coda) con segmenti ``gap`` = NERO, così il montaggio copre comunque
    [0,t_audio] e l'audio resta intero. La modalità automatica produce semplicemente
    posizioni contigue senza buchi (nessun gap inserito)."""
    real = sorted((s for s in segments if s.type != "gap"), key=lambda s: s.start)
    out: list[Segment] = []
    t = 0.0
    for s in real:
        start = max(t, min(float(s.start), t_audio))     # niente sovrapposizioni / fuori scala
        end = max(start, min(float(s.end), t_audio))
        if end - start < 0.05:
            continue
        if start - t > 0.02:                              # buco prima → gap nero
            out.append(Segment(type="gap", source="", start=t, end=start))
        s.start, s.end = start, end
        out.append(s)
        t = end
    if t < t_audio - 0.02 or not out:                     # coda vuota (o nessun media) → gap nero
        out.append(Segment(type="gap", source="", start=t, end=t_audio))
    out[-1].end = t_audio
    return out


# ----------------------------------------------------------------- sorgenti frame

def _fit_canvas(bgr: np.ndarray, cw: int, ch: int) -> np.ndarray:
    """Cover-fit a (cw, ch): scala per coprire e ritaglia al centro."""
    ih, iw = bgr.shape[:2]
    scale = max(cw / iw, ch / ih)
    rw, rh = max(cw, int(round(iw * scale))), max(ch, int(round(ih * scale)))
    resized = cv2.resize(bgr, (rw, rh), interpolation=cv2.INTER_AREA)
    x0, y0 = (rw - cw) // 2, (rh - ch) // 2
    return resized[y0:y0 + ch, x0:x0 + cw]


def _subject_center(canvas: np.ndarray) -> tuple[float, float]:
    """Centro normalizzato del soggetto (volto più grande, altrimenti il centro)."""
    cascade = _face_cascade()
    if cascade is not None:
        h, w = canvas.shape[:2]
        scale = 320 / max(w, 1)
        small = cv2.resize(canvas, (max(1, int(w * scale)), max(1, int(h * scale))))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=4,
                                         minSize=(18, 18))
        if len(faces):
            x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
            return (x + fw / 2) / small.shape[1], (y + fh / 2) / small.shape[0]
    return 0.5, 0.5


class _ImageSource:
    """Sorgente di frame zoomati (Ken Burns) per una singola immagine."""

    def __init__(self, path: str, w: int, h: int, zoom_in: bool, mirror: bool, no_zoom: bool = False):
        self.w, self.h, self.zoom_in, self.mirror, self.no_zoom = w, h, zoom_in, mirror, no_zoom
        self.cw, self.ch = round(w * ZOOM_MAX_SCALE), round(h * ZOOM_MAX_SCALE)
        self.canvas = _fit_canvas(_load_bgr(path), self.cw, self.ch)
        cx, cy = _subject_center(self.canvas)
        # Pan gentile: ci si avvicina solo a metà strada verso il soggetto.
        self.cx = 0.5 + (cx - 0.5) * 0.4
        self.cy = 0.5 + (cy - 0.5) * 0.4

    def frame(self, p: float) -> np.ndarray:
        e = p * p * (3 - 2 * p)                       # smoothstep
        # "Nessuno" = immagine ferma a metà zoom (nessun movimento Ken Burns).
        z = (1 + ZOOM_MAX_SCALE) / 2 if self.no_zoom else 1 + (ZOOM_MAX_SCALE - 1) * (e if self.zoom_in else (1 - e))
        crop_w, crop_h = int(round(self.cw / z)), int(round(self.ch / z))
        cx_px, cy_px = self.cx * self.cw, self.cy * self.ch
        x0 = int(round(min(max(cx_px - crop_w / 2, 0), self.cw - crop_w)))
        y0 = int(round(min(max(cy_px - crop_h / 2, 0), self.ch - crop_h)))
        crop = self.canvas[y0:y0 + crop_h, x0:x0 + crop_w]
        frame = cv2.resize(crop, (self.w, self.h), interpolation=cv2.INTER_CUBIC)
        if self.mirror:
            frame = cv2.flip(frame, 1)
        return frame

    def close(self) -> None:
        self.canvas = None


class _ClipSource:
    """Sorgente di frame da una clip video: trim, velocità, crop, mirror, cover-fit."""

    def __init__(self, seg: Segment, w: int, h: int, mirror: bool):
        self.w, self.h, self.mirror = w, h, mirror
        self.in_, self.out = seg.in_, max(seg.in_ + 0.05, seg.out)
        self.crop = seg.crop
        self.cap = cv2.VideoCapture(seg.source)
        if not self.cap.isOpened():
            raise FfmpegError(f"Impossibile aprire la clip: {seg.source}")
        self._last: np.ndarray | None = None

    def frame(self, p: float) -> np.ndarray:
        src_t = self.in_ + min(max(p, 0.0), 1.0) * (self.out - self.in_)
        self.cap.set(cv2.CAP_PROP_POS_MSEC, src_t * 1000)
        ok, frame = self.cap.read()
        if not ok or frame is None:
            frame = self._last if self._last is not None else \
                np.zeros((self.h, self.w, 3), np.uint8)
        self._last = frame
        if self.crop:
            fh, fw = frame.shape[:2]
            x1 = max(0, min(int(self.crop["x"] * fw), fw - 2))
            y1 = max(0, min(int(self.crop["y"] * fh), fh - 2))
            x2 = max(x1 + 1, min(int((self.crop["x"] + self.crop["w"]) * fw), fw))
            y2 = max(y1 + 1, min(int((self.crop["y"] + self.crop["h"]) * fh), fh))
            frame = frame[y1:y2, x1:x2]
        frame = _fit_canvas(frame, self.w, self.h)
        if self.mirror:
            frame = cv2.flip(frame, 1)
        return frame

    def close(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None


class _GapSource:
    """Spazio VUOTO della timeline = fotogramma nero (fresco a ogni frame, così il
    logo/le comparse possono comporvisi sopra senza accumularsi)."""

    def __init__(self, w: int, h: int):
        self.w, self.h = w, h

    def frame(self, p: float) -> np.ndarray:
        return np.zeros((self.h, self.w, 3), np.uint8)

    def close(self) -> None:
        pass


def _make_source(seg: Segment, w: int, h: int, mirror_global: bool):
    """Crea la sorgente di frame adatta al tipo di segmento.

    Il mirror effettivo è ``mirror_global XOR seg.mirror``: l'interruttore
    globale ribalta tutto; ribaltare un media già ribaltato lo riporta dritto.
    """
    if seg.type == "gap":
        return _GapSource(w, h)
    mirror = bool(mirror_global) ^ bool(seg.mirror)
    if seg.type == "clip":
        return _ClipSource(seg, w, h, mirror)
    return _ImageSource(seg.source, w, h, seg.zoom_in, mirror, seg.no_zoom)


def _prep_logo(path: str, w: int, width_frac: float = LOGO_WIDTH_FRAC):
    """Logo BGR + maschera alpha, dimensionati a ``width_frac`` della larghezza."""
    width_frac = max(0.02, min(0.6, float(width_frac)))
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGBA")
        target_w = max(1, int(w * width_frac))
        ratio = target_w / im.width
        im = im.resize((target_w, max(1, int(im.height * ratio))), Image.LANCZOS)
        rgba = np.asarray(im).astype(np.float32)
    bgr = rgba[:, :, [2, 1, 0]]
    alpha = (rgba[:, :, 3:4] / 255.0)
    return bgr, alpha


def _logo_xy(layout, w: int, h: int, lw: int, lh: int) -> tuple[int, int]:
    """Posizione (top-left, px) del logo. Con ``layout`` (frazioni x/y) la
    rispetta; senza, default in basso a destra con margine (come prima)."""
    if layout and layout.get("x") is not None and layout.get("y") is not None:
        lx = int(round(float(layout["x"]) * w))
        ly = int(round(float(layout["y"]) * h))
    else:
        margin = int(w * LOGO_MARGIN_FRAC)
        lx, ly = w - lw - margin, h - lh - margin
    return max(0, min(lx, w - lw)), max(0, min(ly, h - lh))


# ----------------------------------------------------------- comparse (overlay animati)

# Posizioni nominali → centro (frazioni del frame).
_OVERLAY_POS = {
    "center": (0.5, 0.5), "top": (0.5, 0.2), "bottom": (0.5, 0.82),
    "top-left": (0.22, 0.2), "top-right": (0.78, 0.2),
    "bottom-left": (0.22, 0.82), "bottom-right": (0.78, 0.82),
}
# Animazioni disponibili (mirror identico nel frontend `vm-preview`/`vm-panels`).
OVERLAY_ANIMS = ["fade", "fade-grow", "pop", "zoom-out", "slide-up", "slide-right", "breathe"]


def _smooth(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def _ease_back_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    c1 = 1.70158
    return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2


def _overlay_transform(anim: str, p: float) -> tuple[float, float, float, float]:
    """(moltiplicatore alpha, scala, dx, dy) della comparsa al progress p∈[0,1].
    dx/dy in frazioni del frame. Entrata/uscita di 18% con dissolvenza; nel mezzo
    resta visibile. DEVE restare identico al mirror JS per coerenza anteprima↔video."""
    tin = tout = 0.18
    ein = _smooth(p / tin)
    eout = _smooth((1 - p) / tout)
    a, s, dx, dy = min(ein, eout), 1.0, 0.0, 0.0
    if anim == "fade-grow":          # dissolve al centro e si ingrandisce, poi sfuma
        s = 0.62 + 0.38 * ein + 0.12 * (1 - eout)
    elif anim == "pop":              # entra con un piccolo rimbalzo
        s = _ease_back_out(p / tin) if p < tin else 1.0
    elif anim == "zoom-out":         # parte grande e rimpicciolisce
        s = 1.5 - 0.5 * ein
    elif anim == "slide-up":         # sale dal basso, poi sale ancora uscendo
        dy = (1 - ein) * 0.14 - (1 - eout) * 0.10
    elif anim == "slide-right":      # entra da sinistra, esce verso destra
        dx = -(1 - ein) * 0.18 + (1 - eout) * 0.14
    elif anim == "breathe":          # leggero "respiro" mentre è visibile
        s = 1.0 + 0.045 * math.sin(p * math.pi * 4)
    return a, s, dx, dy


def _hex_rgba(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    s = (hex_color or "#FFFFFF").lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    try:
        return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), alpha
    except ValueError:
        return 255, 255, 255, alpha


def _load_overlay_font(size: int, bold: bool = True):
    names = (["segoeuib.ttf", "arialbd.ttf", "calibrib.ttf"] if bold
             else ["segoeui.ttf", "arial.ttf", "calibri.ttf"])
    fdir = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    for nm in names:
        fp = os.path.join(fdir, nm)
        if os.path.isfile(fp):
            try:
                return ImageFont.truetype(fp, size)
            except OSError:
                pass
    try:
        return ImageFont.truetype("arialbd.ttf" if bold else "arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _prep_text_overlay(text: str, w: int, h: int, size_frac: float, color_hex: str,
                       box: bool = False, box_color_hex: str = "#E11D2A",
                       bold: bool = True, box_opacity: float = 235/255):
    """Disegna il testo (multi-riga con \\n) su un'immagine RGBA → (BGR float, alpha)."""
    fs = max(10, int(round(size_frac * h)))
    font = _load_overlay_font(fs, bold)
    lines = (text or "").split("\n") or [""]
    measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    stroke = 0 if box else max(1, fs // 14)
    line_h = int(fs * 1.32)
    widths = [measure.textbbox((0, 0), ln, font=font, stroke_width=stroke)[2] for ln in lines]
    tw = max(widths + [1])
    pad_x = int(fs * (0.72 if box else 0.32))
    pad_y = int(fs * (0.42 if box else 0.24))
    W, H = max(1, tw + pad_x * 2), max(1, line_h * len(lines) + pad_y * 2)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if box:
        rect = [0, 0, W - 1, H - 1]
        try:
            d.rounded_rectangle(rect, radius=int(fs * 0.38), fill=_hex_rgba(box_color_hex, round(max(0,min(1,box_opacity))*255)))
        except AttributeError:
            d.rectangle(rect, fill=_hex_rgba(box_color_hex, round(max(0,min(1,box_opacity))*255)))
    fill = _hex_rgba(color_hex, 255)
    y = pad_y
    for ln in lines:
        bb = measure.textbbox((0, 0), ln, font=font, stroke_width=stroke)
        x = (W - (bb[2] - bb[0])) // 2 - bb[0]
        d.text((x, y), ln, font=font, fill=fill, stroke_width=stroke,
               stroke_fill=(0, 0, 0, 255))
        y += line_h
    rgba = np.asarray(img).astype(np.float32)
    return rgba[:, :, [2, 1, 0]], rgba[:, :, 3:4] / 255.0


def _with_shadow(bgr: np.ndarray, alpha: np.ndarray):
    """Aggiunge un'ombra morbida dietro la comparsa: così STACCA dall'immagine e si
    legge come un overlay SOPRA, non incollato/dentro la foto."""
    oh, ow = bgr.shape[:2]
    pad = max(10, int(round(max(oh, ow) * 0.11)))
    H, W = oh + pad * 2, ow + pad * 2
    out_bgr = np.zeros((H, W, 3), np.float32)
    out_a = np.zeros((H, W, 1), np.float32)
    a = alpha.reshape(oh, ow)
    # Ombra MORBIDA (sigma ampio) e spostata soprattutto verso il basso, come l'anteprima
    # canvas (shadowBlur): prima era più stretta e si leggeva con bordi netti.
    blur = cv2.GaussianBlur(a, (0, 0), pad * 0.62)
    offx, offy = max(1, pad // 5), max(2, pad // 3)
    out_a[pad + offy:pad + offy + oh, pad + offx:pad + offx + ow, 0] = blur * 0.5   # ombra
    reg = out_a[pad:pad + oh, pad:pad + ow, 0]
    out_a[pad:pad + oh, pad:pad + ow, 0] = reg * (1 - a) + a                        # comparsa sopra
    out_bgr[pad:pad + oh, pad:pad + ow] = bgr
    return out_bgr, out_a


def _prep_overlay(ov: dict, logo_path: str | None, w: int, h: int) -> dict | None:
    """Prepara una comparsa. ``logo``/``text`` = immagine statica (BGR+alpha) animata
    via trasformazione; ``subscribe`` = bottone disegnato PER-FRAME (campanella+mano)."""
    typ = ov.get("type", "text")
    size = float(ov.get("size", 0.26 if typ == "logo" else 0.075))
    # posizione: x/y libera (frazioni del frame) se impostata, altrimenti pos nominale
    if ov.get("x") is not None and ov.get("y") is not None:
        fx, fy = float(ov["x"]), float(ov["y"])
    else:
        fx, fy = _OVERLAY_POS.get(ov.get("pos", "center"), (0.5, 0.5))
    start = max(0.0, float(ov.get("start", 0.0)))
    dur = max(0.5, float(ov.get("duration", 8.0)))
    common = {"cx": fx * w, "cy": fy * h, "start": start, "end": start + dur,
              "opacity": max(0.0, min(1.0, float(ov.get("opacity", 0.85))))}
    if typ == "subscribe":
        return {"kind": "subscribe",
                "text": (ov.get("text") or "ISCRIVITI").strip() or "ISCRIVITI",
                "color": ov.get("color", "#FFFFFF"),
                "box_color": ov.get("box_color", "#E11D2A"),
                "size": max(0.03, min(0.2, size)), **common}
    if typ == "logo":
        if not logo_path:
            return None
        bgr, alpha = _prep_logo(logo_path, w, max(0.03, min(0.6, size)))
    else:
        text = (ov.get("text") or "").strip()
        if not text:
            return None
        bgr, alpha = _prep_text_overlay(
            text, w, h, size, ov.get("color", "#FFFFFF"),
            box=bool(ov.get("box", False)), box_color_hex=ov.get("box_color", "#E11D2A"),
            bold=bool(ov.get("bold", True)), box_opacity=float(ov.get("box_opacity",235/255)))
    bgr, alpha = _with_shadow(bgr, alpha)
    return {"kind": "static", "bgr": bgr, "alpha": alpha,
            "anim": ov.get("anim", "fade"), **common}


def _composite_overlay(frame: np.ndarray, bgr: np.ndarray, alpha: np.ndarray,
                       cx: float, cy: float, scale: float, alpha_mul: float) -> None:
    """Compone (in-place) la comparsa scalata e centrata in (cx,cy) con alpha_mul."""
    if alpha_mul <= 0.004 or scale <= 0.02:
        return
    fh, fw = frame.shape[:2]
    oh, ow = bgr.shape[:2]
    nw, nh = max(1, int(round(ow * scale))), max(1, int(round(oh * scale)))
    if (nw, nh) != (ow, oh):
        interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
        b = cv2.resize(bgr, (nw, nh), interpolation=interp)
        a = cv2.resize(alpha, (nw, nh), interpolation=interp).reshape(nh, nw, 1)
    else:
        b, a = bgr, alpha
    x0, y0 = int(round(cx - nw / 2)), int(round(cy - nh / 2))
    fx0, fy0 = max(0, x0), max(0, y0)
    fx1, fy1 = min(fw, x0 + nw), min(fh, y0 + nh)
    if fx1 <= fx0 or fy1 <= fy0:
        return
    sx0, sy0 = fx0 - x0, fy0 - y0
    sb = b[sy0:sy0 + (fy1 - fy0), sx0:sx0 + (fx1 - fx0)]
    sa = a[sy0:sy0 + (fy1 - fy0), sx0:sx0 + (fx1 - fx0)] * alpha_mul
    roi = frame[fy0:fy1, fx0:fx1].astype(np.float32)
    frame[fy0:fy1, fx0:fx1] = np.clip(roi * (1 - sa) + sb * sa, 0, 255).astype(np.uint8)


# ------------------------------------------------ comparsa "Iscriviti" animata + suono

def _subscribe_state(p: float) -> dict:
    """Parametri dell'animazione del bottone Iscriviti al progress p∈[0,1].
    DEVE restare identico al mirror JS ``vmSubscribeState`` (anteprima↔video)."""
    p = max(0.0, min(1.0, p))
    appear = _smooth(p / 0.16) if p < 0.16 else 1.0
    out = _smooth((1.0 - p) / 0.14) if p > 0.86 else 1.0
    scale = _ease_back_out(p / 0.16) if p < 0.16 else 1.0
    tap_c, tap_w = 0.34, 0.07
    hand = _smooth(min(1.0, max(0.0, (p - 0.06) / 0.26)))     # posizione: entra dal basso
    hand_a = _smooth(min(1.0, max(0.0, (p - 0.04) / 0.16)))   # alpha: compare…
    if p > 0.40:
        hand_a *= max(0.0, 1.0 - (p - 0.40) / 0.14)           # …e SPARISCE dopo il clic
    press = _smooth(max(0.0, 1.0 - abs(p - tap_c) / tap_w)) if abs(p - tap_c) < tap_w else 0.0
    bt = (p - tap_c) / 0.16                                   # lampo dei trattini del clic
    burst = (1.0 - bt) if 0.0 <= bt <= 1.0 else 0.0
    rt = (p - tap_c) / 0.5
    if 0.0 < rt <= 1.2:                                       # campanella: squillo smorzato
        swing = math.sin(rt * math.pi * 5.0) * math.exp(-rt * 3.0)
        wave = max(0.0, 1.0 - rt)
    else:
        swing = wave = 0.0
    rip = (p - tap_c) / 0.24
    return {"a": min(appear, out), "scale": scale, "hand": hand, "hand_a": hand_a,
            "press": press, "burst": burst, "swing": swing, "wave": wave,
            "ripple": rip if 0.0 <= rip <= 1.0 else -1.0}


def _rr(d, box, r, **kw):
    """rounded_rectangle con fallback (Pillow vecchie)."""
    try:
        d.rounded_rectangle(box, radius=r, **kw)
    except AttributeError:
        d.rectangle(box, **kw)


# Icone reali (Font Awesome 6, solid) — stesse path usate nell'anteprima (vm-preview).
# Mano che clicca, indice alzato (hand-pointer, viewBox 448×512; polpastrello ≈ (168, 0),
# con le scanalature fra le dita = fori) e campanella stile YouTube (448×512). In BIANCO.
HAND_PATH = ("M128 40c0-22.1 17.9-40 40-40s40 17.9 40 40l0 148.2c8.5-7.6 19.7-12.2 32-12.2c20.6 0 "
             "38.2 13 45 31.2c8.8-9.3 21.2-15.2 35-15.2c25.3 0 46 19.5 47.9 44.3c8.5-7.7 19.8-12.3 "
             "32.1-12.3c26.5 0 48 21.5 48 48l0 48 0 16 0 48c0 70.7-57.3 128-128 128l-16 0-64 0-.1 0"
             "-5.2 0c-5 0-9.9-.3-14.7-1c-55.3-5.6-106.2-34-140-79L8 336c-13.3-17.7-9.7-42.7 8-56s42.7"
             "-9.7 56 8l56 74.7L128 40zM240 304c0-8.8-7.2-16-16-16s-16 7.2-16 16l0 96c0 8.8 7.2 16 16 "
             "16s16-7.2 16-16l0-96zm48-16c-8.8 0-16 7.2-16 16l0 96c0 8.8 7.2 16 16 16s16-7.2 16-16l0"
             "-96c0-8.8-7.2-16-16-16zm80 16c0-8.8-7.2-16-16-16s-16 7.2-16 16l0 96c0 8.8 7.2 16 16 16s"
             "16-7.2 16-16l0-96z")
BELL_PATH = ("M224 0c-17.7 0-32 14.3-32 32l0 19.2C119 66 64 130.6 64 208l0 18.8c0 47-17.3 92.4-48.5 "
             "127.6l-7.4 8.3c-8.4 9.4-10.4 22.9-5.3 34.4S19.4 416 32 416l384 0c12.6 0 24-7.4 29.2"
             "-18.9s3.1-25-5.3-34.4l-7.4-8.3C401.3 319.2 384 273.9 384 226.8l0-18.8c0-77.4-55-142"
             "-128-156.8L256 32c0-17.7-14.3-32-32-32zm45.3 493.3c12-12 18.7-28.3 18.7-45.3l-64 0-64 "
             "0c0 17 6.7 33.3 18.7 45.3s28.3 18.7 45.3 18.7s33.3-6.7 45.3-18.7z")


def _flatten_svg(d: str, steps: int = 16) -> list:
    """Path SVG → liste di poligoni (sotto-tracciati), appiattendo le curve di Bézier.
    Supporta M m L l H h V v C c S s Q q T t Z z (le icone usate non hanno archi)."""
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?", d)
    i, n = 0, len(toks)
    subs, cur = [], []
    x = y = sx = sy = 0.0
    pcx = pcy = None
    cmd = None

    def bez(x0, y0, x1, y1, x2, y2, x3, y3):
        for k in range(1, steps + 1):
            t = k / steps; mt = 1 - t
            cur.append((mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
                        mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3))

    while i < n:
        if toks[i].isalpha():
            cmd = toks[i]; i += 1
        c = cmd
        def num():
            nonlocal i
            v = float(toks[i]); i += 1; return v
        if c in "Mm":
            nx, ny = num(), num()
            if c == "m": nx += x; ny += y
            if cur: subs.append(cur); cur = []
            cur.append((nx, ny)); x, y, sx, sy = nx, ny, nx, ny
            cmd = "l" if c == "m" else "L"; pcx = pcy = None
        elif c in "Ll":
            nx, ny = num(), num()
            if c == "l": nx += x; ny += y
            cur.append((nx, ny)); x, y = nx, ny; pcx = pcy = None
        elif c in "Hh":
            nx = num(); nx = nx + x if c == "h" else nx
            cur.append((nx, y)); x = nx; pcx = pcy = None
        elif c in "Vv":
            ny = num(); ny = ny + y if c == "v" else ny
            cur.append((x, ny)); y = ny; pcx = pcy = None
        elif c in "Cc":
            x1, y1, x2, y2, x3, y3 = num(), num(), num(), num(), num(), num()
            if c == "c": x1 += x; y1 += y; x2 += x; y2 += y; x3 += x; y3 += y
            bez(x, y, x1, y1, x2, y2, x3, y3); pcx, pcy = x2, y2; x, y = x3, y3
        elif c in "Ss":
            x2, y2, x3, y3 = num(), num(), num(), num()
            if c == "s": x2 += x; y2 += y; x3 += x; y3 += y
            x1, y1 = (2 * x - pcx, 2 * y - pcy) if pcx is not None else (x, y)
            bez(x, y, x1, y1, x2, y2, x3, y3); pcx, pcy = x2, y2; x, y = x3, y3
        elif c in "QqTt":
            if c in "Qq":
                x1, y1, x3, y3 = num(), num(), num(), num()
                if c == "q": x1 += x; y1 += y; x3 += x; y3 += y
            else:
                x3, y3 = num(), num()
                if c == "t": x3 += x; y3 += y
                x1, y1 = (2 * x - pcx, 2 * y - pcy) if pcx is not None else (x, y)
            bez(x, y, x + 2 / 3 * (x1 - x), y + 2 / 3 * (y1 - y),
                x3 + 2 / 3 * (x1 - x3), y3 + 2 / 3 * (y1 - y3), x3, y3)
            pcx, pcy = x1, y1; x, y = x3, y3
        elif c in "Zz":
            if cur: cur.append((sx, sy)); subs.append(cur); cur = []
            x, y = sx, sy; pcx = pcy = None
        else:
            i += 1
    if cur: subs.append(cur)
    return subs


@functools.lru_cache(maxsize=24)
def _icon_img(path_d: str, vw: int, vh: int, px: int, rgb: tuple,
              border_px: int = 0, border_rgb: tuple = (0, 0, 0)):
    """Rasterizza un'icona SVG riempita come SILHOUETTE PIENA (UNION dei sotto-tracciati →
    niente linee/fori interni), con bordo opzionale di ``border_px`` px (per dilatazione).
    Anti-aliasing supersampling ×4. Il punto viewBox (vx,vy) cade a (vx·scale+mb, vy·scale+mb)."""
    px = max(8, int(px)); ss = 4
    scale = px / max(vw, vh)
    ow, oh = max(1, int(round(vw * scale))), max(1, int(round(vh * scale)))
    mb = int(round(border_px)) + 2
    ow2, oh2 = ow + 2 * mb, oh + 2 * mb
    wd, hd = ow2 * ss, oh2 * ss
    off = mb * ss
    acc = np.zeros((hd, wd), np.uint8)
    for sp in _flatten_svg(path_d):
        if len(sp) < 3:
            continue
        m = Image.new("L", (wd, hd), 0)
        ImageDraw.Draw(m).polygon([(p[0] * scale * ss + off, p[1] * scale * ss + off) for p in sp], fill=255)
        acc |= np.asarray(m)                                  # UNION: silhouette piena
    arr = np.zeros((hd, wd, 4), np.uint8)
    if border_px > 0:
        k = max(1, int(round(border_px * ss)))
        ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))
        arr[..., 0], arr[..., 1], arr[..., 2] = border_rgb
        arr[..., 3] = cv2.dilate(acc, ker)                    # bordo = forma dilatata
        inner = acc > 127
        arr[inner, 0], arr[inner, 1], arr[inner, 2] = rgb     # riempimento sopra il bordo
    else:
        arr[..., 0], arr[..., 1], arr[..., 2] = rgb
        arr[..., 3] = acc
    return Image.fromarray(arr, "RGBA").resize((ow2, oh2), Image.LANCZOS)


def _draw_subscribe_tile(text: str, fs: int, box_hex: str, text_hex: str, s: dict):
    """Bottone Iscriviti con ombra morbida, campanella 🔔 che oscilla e mano 👆 che fa
    tap → (BGR, alpha, centro_bottone). Emoji a colori = resa pulita e professionale."""
    font = _load_overlay_font(fs, bold=True)
    measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    tb = measure.textbbox((0, 0), text, font=font)
    tw = tb[2] - tb[0]
    BH = int(round(fs * 1.7))
    bell_h = fs * 1.34
    bell_w = bell_h * 448.0 / 512.0
    pad_x, gap = fs * 0.66, fs * 0.42
    BW = int(round(pad_x * 2 + bell_w + gap + tw))
    lpad, rpad = int(round(fs * 1.7)), int(round(fs * 1.6))
    tpad, bpad = int(round(fs * 1.6)), int(round(fs * 3.6))
    TW, TH = lpad + BW + rpad, tpad + BH + bpad
    img = Image.new("RGBA", (TW, TH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bx0, by0 = lpad, tpad
    cxt, cyt = bx0 + BW / 2.0, by0 + BH / 2.0          # centro bottone = ancora overlay
    pdy = s["press"] * fs * 0.12                       # affondo alla pressione

    if s["ripple"] >= 0:                               # onda del tap dietro al bottone
        rr = s["ripple"]; rad = BH * (0.55 + 0.95 * rr)
        d.ellipse([cxt - rad, cyt - rad + pdy, cxt + rad, cyt + rad + pdy],
                  outline=(255, 255, 255, int(round(80 * (1 - rr)))), width=max(2, int(fs * 0.10)))

    # ombra morbida del bottone (sfocata) → stacca dallo sfondo come in anteprima
    shadow = Image.new("RGBA", (TW, TH), (0, 0, 0, 0))
    _rr(ImageDraw.Draw(shadow), [bx0, by0 + pdy + fs * 0.13, bx0 + BW, by0 + BH + pdy + fs * 0.13],
        r=BH * 0.34, fill=(0, 0, 0, 110))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(fs * 0.22)))

    base = list(_hex_rgba(box_hex, 255))               # bottone + riflesso + testo
    if s["press"] > 0:
        base = [int(c * (1 - 0.12 * s["press"])) for c in base[:3]] + [255]
    _rr(d, [bx0, by0 + pdy, bx0 + BW, by0 + BH + pdy], r=BH * 0.34, fill=tuple(base))
    # riflesso in alto: livello A PARTE e COMPOSITATO (ImageDraw SOSTITUISCE i pixel → un
    # bianco semi-trasparente disegnato direttamente CANCELLEREBBE il rosso rendendolo
    # trasparente: era il bug "sopra non colorato" nell'export).
    gloss = Image.new("RGBA", (TW, TH), (0, 0, 0, 0))
    _rr(ImageDraw.Draw(gloss), [bx0 + fs * 0.10, by0 + pdy + fs * 0.10, bx0 + BW - fs * 0.10, by0 + BH * 0.52 + pdy],
        r=BH * 0.27, fill=(255, 255, 255, 38))
    img.alpha_composite(gloss)
    d.text((bx0 + pad_x + bell_w + gap, cyt + pdy - (tb[3] - tb[1]) / 2.0 - tb[1]),
           text, font=font, fill=_hex_rgba(text_hex, 255))

    # campanella bianca (stile YouTube) che oscilla + onde sonore quando squilla
    bcx, bcy = bx0 + pad_x + bell_w / 2.0, cyt + pdy
    bell = _icon_img(BELL_PATH, 448, 512, int(round(bell_h)), (255, 255, 255))
    bi = bell.rotate(s["swing"] * 16.0, resample=Image.BICUBIC, expand=True)
    img.paste(bi, (int(round(bcx - bi.width / 2)), int(round(bcy - bi.height / 2))), bi)
    if s["wave"] > 0.01:
        wa = int(round(200 * s["wave"]))
        for k in (1, 2):
            r2 = bell_w * (0.7 + 0.40 * k)
            bb = [bcx - r2, bcy - r2, bcx + r2, bcy + r2]
            d.arc(bb, 206, 256, fill=(255, 255, 255, wa), width=max(2, int(fs * 0.06)))
            d.arc(bb, -76, -26, fill=(255, 255, 255, wa), width=max(2, int(fs * 0.06)))

    # mano bianca (silhouette piena, bordo nero) che clicca → entra dal basso, fa tap e SPARISCE
    tcx, tcy = cxt + BW * 0.02, by0 + BH + pdy - fs * 0.05     # bersaglio: bordo basso bottone
    if s["hand_a"] > 0.01:
        hpx = int(round(BH * 1.2))                             # mano (un po' più piccola)
        bpx = max(2, int(round(hpx * 0.05)))                  # bordo nero evidente
        hand = _icon_img(HAND_PATH, 448, 512, hpx, (255, 255, 255), bpx, (0, 0, 0))
        hw, hh = hand.size
        sc = hpx / 512.0
        pad = (hh - round(512 * sc)) / 2.0
        fxo, fyo = 168.0 * sc + pad, pad                      # polpastrello dell'indice nell'immagine
        scx, scy = cxt + BW * 0.12, by0 + BH + pdy + hh * 0.80
        fx = scx + (tcx - scx) * s["hand"]
        fy = scy + (tcy - scy) * s["hand"] - s["press"] * fs * 0.18
        if s["hand_a"] < 0.999:                                # applica la dissolvenza
            a = hand.getchannel("A").point(lambda v: int(v * s["hand_a"]))
            hand = hand.copy(); hand.putalpha(a)
        img.paste(hand, (int(round(fx - fxo)), int(round(fy - fyo))), hand)

    if s["burst"] > 0.01:                                      # trattini del clic sopra il dito
        bc = (tcx, tcy - fs * 0.18)
        r0 = fs * (0.10 + 0.10 * s["burst"]); r1 = r0 + fs * (0.20 + 0.16 * s["burst"])
        wcol = (255, 255, 255, int(round(255 * s["burst"])))
        wln = max(2, int(fs * 0.08))
        for dx, dy in ((0, -1), (-0.6, -0.82), (0.6, -0.82), (-0.96, -0.32), (0.96, -0.32)):
            d.line([(bc[0] + dx * r0, bc[1] + dy * r0), (bc[0] + dx * r1, bc[1] + dy * r1)],
                   fill=wcol, width=wln)

    rgba = np.asarray(img).astype(np.float32)
    return rgba[:, :, [2, 1, 0]], rgba[:, :, 3:4] / 255.0, cxt, cyt


def _render_subscribe_frame(frame: np.ndarray, ov: dict, p: float, w: int, h: int) -> None:
    s = _subscribe_state(p)
    amul = s["a"] * ov["opacity"]
    if amul <= 0.004 or s["scale"] <= 0.02:
        return
    fs = max(12, int(round(ov["size"] * h * 0.62)))
    bgr, alpha, cxt, cyt = _draw_subscribe_tile(
        ov.get("text") or "ISCRIVITI", fs, ov["box_color"], ov["color"], s)
    scale = s["scale"]
    if ov.get("target_width"):
        button_width=max(1,2*(cxt-round(fs*1.7)))
        scale *= ov["target_width"]/button_width
    if abs(scale - 1.0) > 1e-3:
        nh, nw = max(1, int(round(bgr.shape[0] * scale))), max(1, int(round(bgr.shape[1] * scale)))
        interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
        bgr = cv2.resize(bgr, (nw, nh), interpolation=interp)
        alpha = cv2.resize(alpha, (nw, nh), interpolation=interp).reshape(nh, nw, 1)
        cxt *= scale; cyt *= scale
    _composite_rgba(frame, bgr, alpha * amul,
                    int(round(ov["cx"] - cxt)), int(round(ov["cy"] - cyt)))


def _composite_rgba(frame: np.ndarray, bgr: np.ndarray, alpha: np.ndarray, x0: int, y0: int) -> None:
    """Compone in-place un tile BGR+alpha (già moltiplicato per l'opacità) a (x0,y0)."""
    fh, fw = frame.shape[:2]
    nh, nw = bgr.shape[:2]
    fx0, fy0 = max(0, x0), max(0, y0)
    fx1, fy1 = min(fw, x0 + nw), min(fh, y0 + nh)
    if fx1 <= fx0 or fy1 <= fy0:
        return
    sx0, sy0 = fx0 - x0, fy0 - y0
    sb = bgr[sy0:sy0 + (fy1 - fy0), sx0:sx0 + (fx1 - fx0)]
    sa = alpha[sy0:sy0 + (fy1 - fy0), sx0:sx0 + (fx1 - fx0)]
    roi = frame[fy0:fy1, fx0:fx1].astype(np.float32)
    frame[fy0:fy1, fx0:fx1] = np.clip(roi * (1 - sa) + sb * sa, 0, 255).astype(np.uint8)


def _synth_chime(sr: int = 48000) -> np.ndarray:
    """Campanellina gradevole e NON invasiva: doppio rintocco con sintesi a campana
    (parziali inarmonici con decadimento esponenziale)."""
    def bell(f0: float, dur: float):
        t = np.arange(int(sr * dur)) / sr
        x = np.zeros_like(t)
        for ratio, amp in [(1.0, 1.0), (2.0, 0.6), (2.76, 0.35), (3.76, 0.22), (5.4, 0.12)]:
            x += amp * np.sin(2 * np.pi * f0 * ratio * t) * np.exp(-t * (3.0 + ratio * 0.8))
        return x * (1.0 - np.exp(-t * 120.0))          # attacco morbido
    total = int(sr * 1.1)
    out = np.zeros(total, np.float32)
    for f0, t0 in [(1318.5, 0.0), (1046.5, 0.16)]:     # E6 → C6
        x = bell(f0, 0.9).astype(np.float32)
        off = int(sr * t0); end = min(total, off + len(x))
        out[off:end] += x[:end - off]
    out *= 0.3 / max(1e-6, float(np.max(np.abs(out))))  # volume contenuto
    fade = int(sr * 0.05)
    out[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return out


def _write_wav(path: Path, samples: np.ndarray, sr: int = 48000) -> None:
    import wave
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


# ----------------------------------------------------------------- sottotitoli ASS

def _ass_color(hex_color: str, alpha: int = 0) -> str:
    """Converte '#RRGGBB' nel formato ASS &HAABBGGRR (alpha 0=opaco, 255=invisibile)."""
    s = (hex_color or "#FFFFFF").lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    try:
        rr, gg, bb = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except ValueError:
        rr, gg, bb = 255, 255, 255
    return f"&H{alpha & 0xFF:02X}{bb:02X}{gg:02X}{rr:02X}"


def _ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _ass_escape(text: str) -> str:
    return (text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
            .replace("\n", " ").strip())


def _wrap_words(n: int, max_lines: int, per_line: int = 4) -> list[tuple[int, int]]:
    """Divide n parole in righe bilanciate (al massimo ``max_lines``).
    Restituisce gli intervalli [a, b) degli indici parola di ogni riga."""
    if n <= 0:
        return []
    max_lines = max(1, int(max_lines))
    lines_count = min(max_lines, max(1, math.ceil(n / per_line)))
    per = math.ceil(n / lines_count)
    return [(i, min(i + per, n)) for i in range(0, n, per)]


def _clean_rows(rows, n: int) -> list[tuple[int, int]] | None:
    """Valida gli a-capo per-parola calcolati dal client (editor short): devono essere una
    PARTIZIONE contigua di ``[0, n)`` — [(0,a), (a,b), …, (…, n)]. Solo così l'export va a
    capo esattamente come l'anteprima. Qualsiasi anomalia (non contigui, fuori limite, conteggio
    diverso perché una parola è stata scartata) → ``None`` e si ricade su ``_wrap_words``."""
    if not isinstance(rows, list) or not rows:
        return None
    out: list[tuple[int, int]] = []
    expect = 0
    for r in rows:
        if not (isinstance(r, (list, tuple)) and len(r) == 2):
            return None
        try:
            a, b = int(r[0]), int(r[1])
        except (TypeError, ValueError):
            return None
        if a != expect or b <= a or b > n:
            return None
        out.append((a, b))
        expect = b
    return out if expect == n else None


def _write_ass(events: list[dict], style: dict, w: int, h: int,
               audio_duration: float, path: Path, max_lines: int = 2) -> None:
    """Scrive un ASS che evidenzia SOLO la parola in pronuncia in quel momento
    (non in modo cumulativo), su al massimo ``max_lines`` righe.

    Per ogni blocco si emette una battuta per parola: tutto il blocco resta
    visibile e cambia colore la sola parola corrente (override inline ``\\1c``).
    """
    st = {**SUBTITLE_DEFAULT_STYLE, **(style or {})}
    fontsize = max(8, round(st["size_frac"] * h))
    outline = round(st["outline"] * h, 1)
    shadow = round(st["shadow"] * h, 1)
    margin_v = round(st["margin_frac"] * h)
    align = {"bottom": 2, "center": 5, "top": 8}.get(st["position"], 2)
    bold = -1 if st.get("bold") else 0
    box = bool(st.get("box"))
    border_style = 3 if box else 1
    base = _ass_color(st["color"])
    outline_col = _ass_color(st["outline_color"])
    if box:
        back_col = _ass_color(st["box_color"],
                              alpha=round((1 - st.get("box_opacity", 0.55)) * 255))
    else:
        back_col = _ass_color("#000000", alpha=120)   # ombra morbida
    base_inline = base + "&"
    active_inline = _ass_color(st["active_color"]) + "&"

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {w}\nPlayResY: {h}\n"
        "ScaledBorderAndShadow: yes\nWrapStyle: 2\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
        "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{st['font']},{fontsize},{base},{base},"
        f"{outline_col},{back_col},{bold},0,0,0,100,100,0,0,{border_style},"
        f"{outline},{shadow},{align},40,40,{margin_v},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n"
    )

    upper = bool(st.get("uppercase"))
    fade = st.get("anim") == "fade"
    # Posizione ASSOLUTA esplicita (\an + \pos) su OGNI battuta. Emettendo una battuta
    # per parola con tempi contigui, quando due parole sono molto vicine il minimo di
    # durata può far SOVRAPPORRE due battute: libass allora applica il "collision
    # avoidance" e le SPOSTA in verticale (il sottotitolo "parte dal centro e scende").
    # Gli eventi con \pos sono esclusi dal collision detection → posizione stabile.
    # Scostamento libero (drag nell'editor short): `pos` = {dx, dy} in frazioni del frame,
    # sommato all'ancora base. Le stesse frazioni sono usate nell'anteprima canvas
    # (_paintSub) → posizione identica. Assente/non-dict per Video Make → nessuno spostamento.
    _pos = st.get("pos") if isinstance(st.get("pos"), dict) else {}

    def _pf(v):
        try:
            v = float(v)
        except (TypeError, ValueError):
            return 0.0
        return 0.0 if v != v else max(-1.0, min(1.0, v))   # NaN → 0, clamp [-1,1]

    dx, dy = _pf(_pos.get("dx", 0.0)), _pf(_pos.get("dy", 0.0))
    base_pos_y = margin_v if align == 8 else (h // 2 if align == 5 else h - margin_v)
    pos_x = max(0, min(w, round(w / 2 + dx * w)))
    pos_y = max(0, min(h, round(base_pos_y + dy * h)))
    pos_tag = f"\\an{align}\\pos({pos_x},{pos_y})"
    # Ombra/contorno SFOCATI come nell'anteprima (canvas usa shadowBlur): senza \blur
    # libass disegna un'ombra netta dai bordi definiti, incoerente con la timeline.
    blur_tag = f"\\blur{shadow:g}" if shadow > 0 else ""
    lines_out: list[str] = []
    for ev in events:
        words = ev.get("words") or []
        if not words:
            continue
        n = len(words)
        # A-capo per LARGHEZZA decisi dall'editor (campo `rows`, partizione di [0,n)): se
        # presenti e validi si usano tali e quali → parità con l'anteprima. Altrimenti
        # (Video Make, render diretto) si ricade sul bilanciamento per conteggio parole.
        rows = _clean_rows(ev.get("rows"), n) or _wrap_words(n, max_lines)
        toks = [_ass_escape(wd["text"].upper() if upper else wd["text"]) for wd in words]
        block_start = float(ev["start"])
        block_end = min(float(ev["end"]), audio_duration)
        boundaries = sorted({block_start, block_end} | {
            max(block_start, min(block_end, float(word[key])))
            for word in words for key in ("t0", "t1")})
        for seg_start, seg_end in zip(boundaries, boundaries[1:]):
            if seg_end - seg_start < 0.005:
                continue
            middle = (seg_start + seg_end) / 2
            active_word = next((index for index, word in enumerate(words)
                                if float(word["t0"]) <= middle < float(word["t1"])), -1)
            row_strs = []
            for a, b in rows:
                cells = []
                for j in range(a, b):
                    if j == active_word:
                        cells.append(f"{{\\1c{active_inline}}}{toks[j]}{{\\1c{base_inline}}}")
                    else:
                        cells.append(toks[j])
                row_strs.append(" ".join(cells))
            text = "\\N".join(row_strs)
            tags = pos_tag + blur_tag + ("\\fad(150,0)" if (fade and seg_start == block_start) else "")
            text = "{" + tags + "}" + text
            lines_out.append(
                f"Dialogue: 0,{_ass_time(seg_start)},{_ass_time(seg_end)},"
                f"Default,,0,0,0,,{text}")

    path.write_text(header + "\n".join(lines_out) + "\n", encoding="utf-8")


# ----------------------------------------------------------------- render montaggio

# Tipi di transizione in ingresso fra due scene (deve combaciare con VM_TRANSITION_OPTS
# nel frontend vm-context.js). "none" = taglio netto (gestito a monte, niente blend).
TRANSITIONS = ["fade", "none", "black", "white", "zoom", "blur"]


def _zoom_center(img: np.ndarray, f: float) -> np.ndarray:
    """Zoom dell'immagine attorno al centro (mantiene le dimensioni)."""
    if f <= 1.0001:
        return img
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), 0, f)
    return cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def _blend_transition(name: str, cur: np.ndarray, nxt: np.ndarray, beta: float) -> np.ndarray:
    """Fonde il frame uscente ``cur`` con quello entrante ``nxt`` a ``beta`` ∈ [0,1].
    ``black``/``white`` = stacco al nero/bianco; ``zoom`` = spinta cinematografica;
    ``blur`` = dissolvenza sfocata; default ``fade`` = dissolvenza incrociata."""
    if name == "black":                         # cur → nero → nuova
        if beta < 0.5:
            return (cur.astype(np.float32) * (1 - beta * 2)).astype(np.uint8)
        return (nxt.astype(np.float32) * ((beta - 0.5) * 2)).astype(np.uint8)
    if name == "white":                         # cur → bianco (flash) → nuova
        if beta < 0.5:
            f = beta * 2
            return (cur.astype(np.float32) * (1 - f) + 255 * f).astype(np.uint8)
        g = (beta - 0.5) * 2
        return (nxt.astype(np.float32) * g + 255 * (1 - g)).astype(np.uint8)
    if name == "zoom":                          # cur zooma ed esce, la nuova si assesta entrando
        cur_z = _zoom_center(cur, 1 + 0.28 * beta)
        nxt_z = _zoom_center(nxt, 1 + 0.28 * (1 - beta))
        return cv2.addWeighted(cur_z, 1 - beta, nxt_z, beta, 0)
    if name == "blur":                          # dissolvenza sfocata (sigma max a metà)
        sig = max(cur.shape[1], cur.shape[0]) * 0.022
        cb = cv2.GaussianBlur(cur, (0, 0), max(0.1, sig * beta)) if beta > 0.02 else cur
        nb = cv2.GaussianBlur(nxt, (0, 0), max(0.1, sig * (1 - beta))) if beta < 0.98 else nxt
        return cv2.addWeighted(cb, 1 - beta, nb, beta, 0)
    return cv2.addWeighted(cur, 1 - beta, nxt, beta, 0)   # "fade" (default)


def _render_montage(segments: list[Segment], dst: Path,
                    w: int, h: int, fps: float, logo_path: str | None,
                    logo_layout: dict | None, mirror_global: bool,
                    subtitles_ass: Path | None, overlays: list | None,
                    on_progress, cancel) -> None:
    """Renderizza il montaggio come stream VIDEO (senza audio): i frame numpy
    vengono pipati a ffmpeg. L'audio (narrazione multipla, clip, musica) è
    assemblato dopo, in :func:`_assemble_final`."""
    duration = segments[-1].end
    total = max(1, int(round(duration * fps)))
    cf_frames = max(1, int(round(CROSSFADE_SECONDS * fps)))

    # Range di frame [start, end) di ogni segmento.
    bounds = [(int(round(s.start * fps)), int(round(s.end * fps))) for s in segments]
    bounds[-1] = (bounds[-1][0], total)

    logo = _prep_logo(logo_path, w, (logo_layout or {}).get("w", LOGO_WIDTH_FRAC)) \
        if logo_path else None
    if logo is not None:
        lh, lw = logo[0].shape[:2]
        lx, ly = _logo_xy(logo_layout, w, h, lw, lh)

    # Comparse temporizzate (logo/testo/iscriviti) preparate una volta.
    ov_prepped = [o for o in (_prep_overlay(ov, logo_path, w, h)
                              for ov in (overlays or [])) if o]

    args = ["-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
            "-r", f"{fps:.6f}", "-i", "pipe:0"]
    if subtitles_ass is not None:
        # Eseguito con cwd = cartella temporanea: passiamo il solo nome del file
        # ASS per evitare l'escaping ostico dei path di Windows nel filtro.
        args += ["-vf", f"subtitles={subtitles_ass.name}"]
    # Solo video: la durata è data dai frame pipati (= round(t_montage*fps)).
    args += ["-an", "-c:v", "libx264", "-preset", X264_PRESET, "-crf", VM_CRF,
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)]

    encoder = subprocess.Popen(
        [FFMPEG_EXE, *args], stdin=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=str(dst.parent), creationflags=CREATE_NO_WINDOW)

    stderr_tail: list[bytes] = []
    drain = threading.Thread(
        target=lambda: stderr_tail.append(encoder.stderr.read()), daemon=True)
    drain.start()

    cur_seg = -1
    cur_src = None
    next_src = None
    next_idx = -1
    try:
        for t in range(total):
            _check_cancel(cancel, "Creazione video annullata.")
            while cur_seg + 1 < len(bounds) and t >= bounds[cur_seg + 1][0]:
                cur_seg += 1
                if next_src is not None and next_idx == cur_seg:
                    cur_src = next_src
                else:
                    if next_src is not None:
                        next_src.close()
                    cur_src = _make_source(segments[cur_seg], w, h, mirror_global)
                next_src, next_idx = None, -1
            s_start, s_end = bounds[cur_seg]
            seg_len = max(1, s_end - s_start)
            p = (t - s_start) / max(1, seg_len - 1)
            frame = cur_src.frame(min(p, 1.0))

            # Crossfade verso il segmento successivo.
            remaining = s_end - t
            if cur_seg + 1 < len(segments) and remaining <= cf_frames \
                    and segments[cur_seg + 1].transition != "none":
                if next_src is None:
                    next_src = _make_source(segments[cur_seg + 1], w, h, mirror_global)
                    next_idx = cur_seg + 1
                beta = (cf_frames - remaining) / cf_frames
                frame = _blend_transition(segments[cur_seg + 1].transition,
                                          frame, next_src.frame(0.0), beta)

            if logo is not None:
                roi = frame[ly:ly + lh, lx:lx + lw].astype(np.float32)
                frame[ly:ly + lh, lx:lx + lw] = (
                    roi * (1 - logo[1]) + logo[0] * logo[1]).astype(np.uint8)

            if ov_prepped:                                  # comparse animate (sopra al logo fisso)
                t_sec = t / fps
                for ov in ov_prepped:
                    if ov["start"] <= t_sec < ov["end"]:
                        p = (t_sec - ov["start"]) / max(1e-6, ov["end"] - ov["start"])
                        if ov.get("kind") == "subscribe":
                            _render_subscribe_frame(frame, ov, p, w, h)
                        else:
                            am, sc, dx, dy = _overlay_transform(ov["anim"], p)
                            _composite_overlay(frame, ov["bgr"], ov["alpha"],
                                               ov["cx"] + dx * w, ov["cy"] + dy * h,
                                               sc, am * ov["opacity"])

            try:
                encoder.stdin.write(np.ascontiguousarray(frame).tobytes())
            except OSError:
                break
            if on_progress and t % 10 == 0:
                on_progress(t / total)
    finally:
        for src in (cur_src, next_src):
            if src is not None:
                src.close()
        try:
            encoder.stdin.close()
        except OSError:
            pass
        encoder.wait()
        drain.join(timeout=2)

    _check_cancel(cancel, "Creazione video annullata.")
    if encoder.returncode != 0:
        detail = (stderr_tail[0].decode("utf-8", "replace")[-1500:]
                  if stderr_tail else "nessun dettaglio")
        raise FfmpegError(f"Codifica del montaggio fallita:\n{detail}")
    if on_progress:
        on_progress(1.0)


# ----------------------------------------------------------------- normalizza / assembla

def _normalize_clip(src: str, dst: Path, w: int, h: int, fps: float,
                    on_progress, cancel, dur: float | None = None) -> None:
    """Porta intro/outro a w×h/fps, yuv420p, audio AAC stereo 48k (silenzio se assente).

    Se ``dur`` è inferiore alla durata della sorgente, TAGLIA il clip a quella
    durata mantenendo l'inizio (l'utente accorcia intro/outro dalla timeline)."""
    info = probe(src)
    do_trim = bool(dur and dur > 0.05 and dur < info.duration - 0.05)
    trim = ["-t", f"{float(dur):.3f}"] if do_trim else []
    vf = (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={fps:.6f},format=yuv420p")
    if _has_audio(src):
        args = ["-i", src, "-vf", vf, *trim,
                "-c:v", "libx264", "-preset", X264_PRESET, "-crf", VM_CRF,
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                str(dst)]
    else:
        args = ["-i", src, "-f", "lavfi", "-i",
                "anullsrc=channel_layout=stereo:sample_rate=48000",
                "-vf", vf, "-map", "0:v", "-map", "1:a", "-shortest", *trim,
                "-c:v", "libx264", "-preset", X264_PRESET, "-crf", VM_CRF,
                "-c:a", "aac", "-b:a", "192k", str(dst)]
    run_ffmpeg(args, duration=(float(dur) if do_trim else info.duration),
               on_progress=on_progress, cancel=cancel)


def _assemble_final(intro: Path | None, montage: Path, outro: Path | None, out_path: Path,
                    t_intro: float, t_montage: float, t_outro: float,
                    voice_clips: list[dict], music: dict | None,
                    on_progress, cancel,
                    chime_path: Path | None = None, sub_starts: list | None = None) -> None:
    """Concatena con crossfade intro → montaggio → outro (outro che finisce
    OUTRO_TAIL_SECONDS dopo la durata-master del montaggio) e mixa l'audio: voci
    del montaggio (blocchi di narrazione + audio delle clip, ognuno ritardato alla
    sua posizione) + campanellina + musica con ducking. Il montaggio è video-only.
    Intro e/o outro possono essere assenti (``None``): in tal caso si saltano le
    relative dissolvenze e l'audio del cap mancante (montaggio nudo all'estremità)."""
    cf = JOIN_FADE
    has_i = intro is not None
    has_o = outro is not None
    montage_visual = max(cf + 0.1, t_montage - t_outro + OUTRO_TAIL_SECONDS) if has_o else t_montage
    total = t_intro + montage_visual + (t_outro if has_o else 0.0)
    m0 = (t_intro - cf) if has_i else 0.0        # inizio del montaggio nel composite
    delay_outro = int(round((t_intro + montage_visual) * 1000))

    inputs: list[str] = []
    i = 0
    if has_i: inputs += ["-i", str(intro)]; intro_i = i; i += 1
    inputs += ["-i", str(montage)]; montage_i = i; i += 1
    if has_o: inputs += ["-i", str(outro)]; outro_i = i; i += 1

    parts: list[str] = []
    cur = f"[{montage_i}:v]"
    if has_i:
        off1 = max(0.0, t_intro - cf)
        parts.append(f"[{intro_i}:v][{montage_i}:v]xfade=transition=fade:duration={cf}:offset={off1:.3f}[v01]")
        cur = "[v01]"
    if has_o:
        off2 = max(m0 + cf, m0 + montage_visual - cf)
        parts.append(f"{cur}[{outro_i}:v]xfade=transition=fade:duration={cf}:offset={off2:.3f}[vo]")
        cur = "[vo]"
    parts.append(f"{cur}null[v]")                 # etichetta finale uniforme

    voice: list[str] = []
    if has_i:
        parts.append(f"[{intro_i}:a]atrim=0:{t_intro:.3f},asetpts=PTS-STARTPTS[aintro]")
        voice.append("[aintro]")
    if has_o:
        parts.append(f"[{outro_i}:a]adelay={delay_outro}|{delay_outro}[aoutro]")
        voice.append("[aoutro]")

    idx = i
    for ca in voice_clips:
        inputs += ["-i", ca["path"]]
        delay = int(round((t_intro + ca["start"]) * 1000))
        atempo = _atempo_chain(ca["speed"]) if abs(ca["speed"] - 1.0) > 1e-3 else "anull"
        vol = float(ca.get("volume", 1.0))
        volf = f",volume={vol:g}" if abs(vol - 1.0) > 1e-3 else ""
        lbl = f"[ac{idx}]"
        parts.append(
            f"[{idx}:a]atrim={ca['in']:.3f}:{ca['out']:.3f},asetpts=PTS-STARTPTS,"
            f"{atempo}{volf},adelay={delay}|{delay}{lbl}")
        voice.append(lbl)
        idx += 1

    # Campanellina della comparsa "Iscriviti": stesso file, ritardato a ogni apparizione.
    for stt in (sub_starts or []) if chime_path else []:
        inputs += ["-i", str(chime_path)]
        cdelay = int(round((t_intro + stt) * 1000))
        lbl = f"[chm{idx}]"
        parts.append(f"[{idx}:a]pan=stereo|c0=c0|c1=c0,"
                     f"adelay={cdelay}|{cdelay},volume=0.9{lbl}")
        voice.append(lbl)
        idx += 1

    # Nessuna voce (niente cap, narrazione né clip audio): traccia silenziosa così
    # amix ha sempre almeno un ingresso e l'output ha audio per tutta la durata.
    if not voice:
        parts.append(f"anullsrc=channel_layout=stereo:sample_rate=48000,"
                     f"atrim=0:{total:.3f},asetpts=PTS-STARTPTS[asilence]")
        voice.append("[asilence]")

    music_path = (music or {}).get("path")
    if music_path:
        # -stream_loop -1 ripete la musica se più corta del video.
        inputs += ["-stream_loop", "-1", "-i", music_path]
        vol = float((music or {}).get("volume", MUSIC_DEFAULT_VOLUME))
        duck = bool((music or {}).get("duck", MUSIC_DEFAULT_DUCK))
        parts.append(f"{''.join(voice)}amix=inputs={len(voice)}:"
                     f"normalize=0:dropout_transition=0[voice]")
        parts.append(f"[{idx}:a]atrim=0:{total:.3f},asetpts=PTS-STARTPTS,"
                     f"volume={vol:g}[music0]")
        if duck:
            parts.append("[voice]asplit=2[voicemain][voicesc]")
            parts.append("[music0][voicesc]sidechaincompress=threshold=0.03:"
                         "ratio=8:attack=15:release=300[ducked]")
            parts.append("[voicemain][ducked]amix=inputs=2:normalize=0:"
                         "dropout_transition=0[a]")
        else:
            parts.append("[voice][music0]amix=inputs=2:normalize=0:"
                         "dropout_transition=0[a]")
    else:
        parts.append(f"{''.join(voice)}amix=inputs={len(voice)}:"
                     f"normalize=0:dropout_transition=0[a]")

    run_ffmpeg(
        [*inputs, "-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-preset", X264_PRESET, "-crf", VM_CRF,
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", "-t", f"{total:.3f}", str(out_path)],
        duration=total, on_progress=on_progress, cancel=cancel)


# ----------------------------------------------------------------- analisi

def analyze(images: list[str], wavs: list[str], intro_path: str, outro_path: str,
            width: int, height: int, fps: float,
            docx_path: str | None = None, logo_path: str | None = None,
            transcribe: bool = True,
            on_progress=None, cancel: threading.Event | None = None) -> dict:
    """Prepara il progetto per l'editor. Nessun render, niente embedding immagini.

    Accetta PIÙ file audio (``wavs``): vengono ordinati per nome e posizionati in
    sequenza sulla traccia audio (``audios``); l'editor potrà spostarli/ritagliarli.
    Il montaggio (``segments``) parte VUOTO: l'editor lo riempie (manuale o
    "Posiziona automaticamente"/"Auto") e lo ripassa a ``render``.

    Se ``transcribe`` è ``True`` ogni audio viene trascritto (tempo SORGENTE) e le
    parole combinate generano sottotitoli e finestre del trascritto. Se è ``False``
    si salta la trascrizione (lenta): l'editor si apre SUBITO con audio/intro/outro/
    template a posto e sottotitoli vuoti; la trascrizione si chiede poi dalla
    timeline (vedi :func:`transcribe_audios`).
    """
    if not FFMPEG_EXE:
        raise FfmpegError("ffmpeg non trovato.")
    paths = sorted((p for p in images
                    if Path(p).suffix.lower() in IMAGE_INPUT_EXTENSIONS),
                   key=lambda p: natural_key(Path(p).name))
    if not paths:
        raise ValueError("Nessuna immagine valida selezionata.")
    wav_list = sorted((w for w in (wavs or []) if w),
                      key=lambda p: natural_key(Path(p).name))
    if not wav_list:
        raise ValueError("Nessun audio selezionato.")
    for label, f in [("intro", intro_path), ("outro", outro_path)]:
        if not Path(f).is_file():
            raise ValueError(f"File {label} non trovato: {f}")
    for w in wav_list:
        if not Path(w).is_file():
            raise ValueError(f"File audio non trovato: {w}")

    intro_info = probe(intro_path)
    outro_info = probe(outro_path)

    # Posiziona gli audio in sequenza senza vuoti; l'editor poi sposta/ritaglia.
    # NIENTE embedding immagini qui (lento): il montaggio si apre VUOTO. Con
    # ``transcribe`` si trascrive ogni audio (banda di progresso divisa per N),
    # altrimenti si salta del tutto la trascrizione per un'apertura immediata.
    audios: list[dict] = []
    combined: list[semantic.Word] = []
    cursor = 0.0
    n = len(wav_list)
    for i, w in enumerate(wav_list):
        src_dur = _wav_duration(w)
        if transcribe:
            tr = semantic.transcribe(
                w, on_progress=_band(on_progress, i / n * 0.95, (i + 1) / n * 0.95),
                cancel=cancel)
            words = [{"start": round(x.start, 3), "end": round(x.end, 3), "text": x.text}
                     for x in tr.words]
            combined += [semantic.Word(cursor + x.start, cursor + x.end, x.text)
                         for x in tr.words]
        else:
            words = []
        audios.append({"path": w, "start": round(cursor, 3), "in": 0.0,
                       "out": round(src_dur, 3), "src_dur": round(src_dur, 3),
                       "words": words})
        cursor += src_dur

    t_audio = cursor
    script_text = semantic.read_docx(docx_path) if (transcribe and docx_path) else ""
    windows: list = []
    if transcribe:
        transcript = semantic.Transcript(duration=t_audio, words=combined)
        fallback = semantic.count_sentences(script_text) if script_text else 0
        windows = semantic.build_windows(transcript, t_audio, fallback_sentences=fallback)
        if not windows:
            raise ValueError("Audio troppo corto o vuoto per costruire il video.")
        if script_text:
            semantic.refine_windows_with_script(windows, script_text)
    if on_progress:
        on_progress(1.0)

    # Tutte le immagini, in ordine di nome, disponibili nella libreria; nessuna è
    # ancora nel montaggio (segments vuoto).
    media = [{"path": p, "type": "image", "status": "unused"} for p in paths]

    return {
        "version": 3,
        "audio": wav_list[0],
        "audios": audios,
        "audio_duration": round(t_audio, 3),
        "intro": {"path": intro_path, "duration": round(intro_info.duration, 3)},
        "outro": {"path": outro_path, "duration": round(outro_info.duration, 3)},
        "logo": logo_path,
        "width": width, "height": height, "fps": fps,
        "mirror_global": False,
        "media": media,
        "segments": [],
        "words": [{"start": round(w.start, 3), "end": round(w.end, 3), "text": w.text}
                  for w in combined],
        "subtitles": {
            # Sottotitoli ATTIVI di default: l'editor di Video Make, all'apertura,
            # calcola la trascrizione in parallelo (non bloccante) e riempie gli
            # eventi. Senza trascrizione qui gli eventi partono vuoti (o già
            # popolati se ``transcribe``), poi l'editor li completa in background.
            "enabled": True,
            "preset": "clean",
            "max_words": SUBTITLE_MAX_WORDS,
            "max_lines": SUBTITLE_MAX_LINES,
            "style": dict(SUBTITLE_DEFAULT_STYLE),
            "events": semantic.build_subtitle_events(combined, SUBTITLE_MAX_WORDS) if combined else [],
        },
        "music": {"path": None, "volume": MUSIC_DEFAULT_VOLUME,
                  "duck": MUSIC_DEFAULT_DUCK},
        "windows": [{"start": round(w.start, 3), "end": round(w.end, 3), "text": w.text}
                    for w in windows],
        "used": 0,
        "dropped_dup": 0,
        "dropped_offtopic": 0,
        "images_total": len(paths),
        "pool": {"duplicates": [], "offtopic": [], "unused": list(paths)},
    }


# ----------------------------------------------------------------- trascrizione on-demand

def transcribe_audios(paths: list[str],
                      on_progress=None, cancel: threading.Event | None = None) -> dict:
    """Trascrive gli audio richiesti dalla timeline (analisi on-demand).

    Trascrive OGNI path unico una sola volta e restituisce le parole in tempo
    SORGENTE per path: ``{"words_by_path": {path: [{start, end, text}, ...]}}``.
    L'editor le assegna ai blocchi audio (per path) e ricostruisce parole e
    sottotitoli combinati. Riuso di :func:`semantic.transcribe`.
    """
    if not FFMPEG_EXE:
        raise FfmpegError("ffmpeg non trovato.")
    uniq = list(dict.fromkeys(p for p in (paths or []) if p))
    if not uniq:
        raise ValueError("Nessun audio da analizzare.")
    for p in uniq:
        if not Path(p).is_file():
            raise ValueError(f"File audio non trovato: {p}")

    words_by_path: dict[str, list] = {}
    n = len(uniq)
    for i, p in enumerate(uniq):
        tr = semantic.transcribe(
            p, on_progress=_band(on_progress, i / n, (i + 1) / n), cancel=cancel)
        words_by_path[p] = [
            {"start": round(x.start, 3), "end": round(x.end, 3), "text": x.text}
            for x in tr.words]
    if on_progress:
        on_progress(1.0)
    return {"words_by_path": words_by_path}


# ----------------------------------------------------------------- riabbinamento

def rematch(images: list[str], words: list[dict], audio_duration: float,
            dedup: bool = True, offtopic: float | None = None,
            img_min: float | None = None, img_max: float | None = None,
            on_progress=None, cancel: threading.Event | None = None,
            script_text: str | None = None) -> dict:
    """Riesegue solo l'abbinamento immagini↔audio (niente trascrizione).

    Riusa le parole già trascritte per ricostruire le finestre (durata opzionale
    ``img_min``..``img_max``), riembedda le immagini, deduplica (facoltativo) e
    riallinea. Restituisce i nuovi segmenti immagine e lo stato dei media: usato
    dal comando "Posiziona immagini in automatico" dell'editor.
    """
    if not FFMPEG_EXE:
        raise FfmpegError("ffmpeg non trovato.")
    paths = sorted((p for p in images
                    if Path(p).suffix.lower() in IMAGE_INPUT_EXTENSIONS),
                   key=lambda p: natural_key(Path(p).name))
    if not paths:
        raise ValueError("Nessuna immagine valida.")
    transcript = semantic.Transcript(
        duration=float(audio_duration),
        words=[semantic.Word(float(w["start"]), float(w["end"]), w.get("text", ""))
               for w in (words or [])])
    windows = semantic.build_windows(transcript, float(audio_duration),
                                     img_min=img_min, img_max=img_max)
    if not windows:
        raise ValueError("Audio troppo corto per il riposizionamento.")
    if script_text:
        semantic.refine_windows_with_script(windows, script_text)

    img_emb = semantic.embed_images(
        paths, on_progress=_band(on_progress, 0.0, 0.9), cancel=cancel)
    if dedup:
        kept, dup_of = semantic.dedup(img_emb)
    else:
        kept, dup_of = list(range(len(paths))), {}
    kept_paths = [paths[i] for i in kept]
    kept_emb = img_emb[kept]
    _check_cancel(cancel)
    win_emb = semantic.embed_texts([w.text for w in windows], dim=img_emb.shape[1])
    off = OFFTOPIC_SIMILARITY if offtopic is None else float(offtopic)
    assignment = semantic.align(kept_emb, win_emb, offtopic_threshold=off)
    segments = _build_segments(windows, assignment, kept_paths)
    cap = IMAGE_MAX_SECONDS if img_max is None else float(img_max)
    pool_paths = ([kept_paths[i] for i in assignment.unused]
                  + [kept_paths[i] for i in assignment.offtopic]
                  + [paths[i] for i in dup_of])
    segments = _fill_long_segments(segments, pool_paths, cap)
    if on_progress:
        on_progress(1.0)

    used_set, off_set = set(assignment.used), set(assignment.offtopic)
    status: dict[str, str] = {}
    for i in dup_of:
        status[paths[i]] = "dup"
    for idx, kp in enumerate(kept_paths):
        status[kp] = ("used" if idx in used_set
                      else "offtopic" if idx in off_set else "unused")
    media = [{"path": p, "type": "image", "status": status.get(p, "unused")}
             for p in paths]

    return {
        "segments": [{"type": "image", "source": s.source,
                      "start": round(s.start, 3), "end": round(s.end, 3),
                      "zoom_in": s.zoom_in, "mirror": False, "transition": "fade"}
                     for s in segments],
        "media": media,
        "windows": [{"start": round(w.start, 3), "end": round(w.end, 3), "text": w.text}
                    for w in windows],
    }


# ----------------------------------------------------------------- render

def render(project: dict, out_path: str,
           on_progress=None, cancel: threading.Event | None = None) -> dict:
    """Renderizza il video finale dal progetto (eventualmente modificato nell'editor)."""
    if not FFMPEG_EXE:
        raise FfmpegError("ffmpeg non trovato.")
    out_path = Path(out_path)
    width, height, fps = int(project["width"]), int(project["height"]), float(project["fps"])
    audios = _project_audios(project)
    intro_obj = project.get("intro") or None
    outro_obj = project.get("outro") or None
    intro_path = intro_obj["path"] if intro_obj else None
    outro_path = outro_obj["path"] if outro_obj else None
    logo_path = project.get("logo")
    logo_layout = project.get("logo_layout")
    mirror_global = bool(project.get("mirror_global", False))
    t_intro = float(intro_obj["duration"]) if intro_obj else 0.0
    t_outro = float(outro_obj["duration"]) if outro_obj else 0.0

    seg_dicts = project.get("segments") or []
    if not seg_dicts:
        raise ValueError("Nessun media nel montaggio da renderizzare.")
    segments = [_segment_from_dict(d) for d in seg_dicts]

    # Durata-master del montaggio = fine dell'ultimo media (audio O immagine/clip).
    audio_end = max((float(a["start"]) + max(0.05, float(a["out"]) - float(a["in"]))
                     for a in audios), default=0.0)
    seg_end = max((s.end for s in segments), default=0.0)
    t_montage = max(JOIN_FADE + 0.1, audio_end, seg_end)
    segments = _layout_with_gaps(segments, t_montage)   # rispetta i vuoti; coda/buchi = nero

    # Voci del montaggio: blocchi di narrazione (in ordine/posizione scelti dall'utente)
    # + audio delle clip che lo richiedono. Stesso formato: ognuno ritardato a t_intro+start.
    narration_audios = [
        {"path": a["path"], "in": float(a["in"]),
         "out": max(float(a["in"]) + 0.05, float(a["out"])),
         "speed": 1.0, "start": float(a["start"]),
         "volume": float(a.get("volume", 1.0))}
        for a in audios
    ]
    clip_audios = [
        {"path": s.source, "in": s.in_, "out": max(s.in_ + 0.05, s.out),
         "speed": max(0.1, s.speed), "start": s.start, "volume": 1.0}
        for s in segments if s.type == "clip" and s.use_audio
    ]
    voice_clips = narration_audios + clip_audios

    subs = project.get("subtitles") or {}
    music = project.get("music") or {}
    # tempi (nel montaggio) in cui appare una comparsa "Iscriviti": lì squilla la campanellina
    sub_starts = sorted(max(0.0, float(o.get("start", 0.0)))
                        for o in (project.get("overlays") or [])
                        if o.get("type") == "subscribe")

    with tempfile.TemporaryDirectory(prefix="duckyvm_") as tmp:
        tmp = Path(tmp)
        montage, intro_n, outro_n = tmp / "montage.mp4", tmp / "intro.mp4", tmp / "outro.mp4"

        chime_path = None
        if sub_starts:
            chime_path = tmp / "chime.wav"
            _write_wav(chime_path, _synth_chime(48000), 48000)

        ass_path = None
        if subs.get("enabled") and subs.get("events"):
            ass_path = tmp / "subs.ass"
            _write_ass(subs["events"], subs.get("style") or {}, width, height,
                       t_montage, ass_path, max_lines=int(subs.get("max_lines", 2)))

        _render_montage(segments, montage, width, height, fps, logo_path,
                        logo_layout, mirror_global, ass_path, project.get("overlays"),
                        on_progress=_band(on_progress, 0.0, 0.80), cancel=cancel)
        if intro_path:
            _normalize_clip(intro_path, intro_n, width, height, fps,
                            on_progress=_band(on_progress, 0.80, 0.85), cancel=cancel, dur=t_intro)
        else:
            intro_n = None
        if outro_path:
            _normalize_clip(outro_path, outro_n, width, height, fps,
                            on_progress=_band(on_progress, 0.85, 0.90), cancel=cancel, dur=t_outro)
        else:
            outro_n = None
        _assemble_final(intro_n, montage, outro_n, out_path,
                        t_intro, t_montage, t_outro, voice_clips, music,
                        on_progress=_band(on_progress, 0.90, 1.0), cancel=cancel,
                        chime_path=chime_path, sub_starts=sub_starts)

    return {"file": str(out_path), "folder": str(out_path.parent),
            "segments": len(segments)}


# ----------------------------------------------------------------- one-shot

def make_video(images: list[str], wavs: list[str], intro_path: str, outro_path: str,
               out_path: str, width: int, height: int, fps: float,
               docx_path: str | None = None, logo_path: str | None = None,
               on_progress=None, cancel: threading.Event | None = None) -> dict:
    """Comodità: analyze + render in un colpo (usato fuori dall'editor/test)."""
    project = analyze(images, wavs, intro_path, outro_path, width, height, fps,
                      docx_path=docx_path, logo_path=logo_path,
                      on_progress=_band(on_progress, 0.0, 0.4), cancel=cancel)
    result = render(project, out_path,
                    on_progress=_band(on_progress, 0.4, 1.0), cancel=cancel)
    result.update({k: project[k] for k in
                   ("used", "dropped_dup", "dropped_offtopic", "images_total")})
    return result
