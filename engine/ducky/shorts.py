"""Rendering degli short verticali 1080x1920.

Due stili:

- "blur": il video intero al centro, dietro una copia ingrandita e sfocata
  (lo stile classico degli Shorts). Un solo passaggio ffmpeg.

- "crop": camera verticale con associazione del soggetto, flusso ottico,
  rilevamento locale di volti/persone e fallback sul movimento. La traiettoria
  usa zona morta, previsione e reset agli stacchi. La modalità gruppo allarga
  l'inquadratura con sfondo sfocato quando necessario, poi i frame
  ritagliati vengono passati in pipe a ffmpeg per la codifica (l'audio viene
  preso dal video originale).
"""

import random
import math
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import cv2
import numpy as np

from .config import FFMPEG_EXE
from .ffmpeg_tools import CREATE_NO_WINDOW, FfmpegError, run_ffmpeg
from .utils import sequenced_file
from .video import probe
from .encoding import choose_encoding, cpu_encoding, report_encoding, is_hardware_failure, run_encoded_ffmpeg

SHORT_W, SHORT_H = 1080, 1920
MAX_SHORT_SECONDS = 180          # limite applicativo per la generazione degli short
SHORT_FILE_NAME = "Ducky SHORT"
SHORT_CRF = "21"

# I frac di dimensione dei sottotitoli (size/outline/shadow) sono tarati sul LATO
# CORTO (in 16:9 = l'altezza). In verticale il lato corto è la LARGHEZZA, quindi si
# scalano di W/H per mantenere le stesse proporzioni del testo viste in Video Make.
SUB_VERTICAL_K = SHORT_W / SHORT_H


def _band(fn, lo, hi):
    """Restringe una callback di progresso 0..1 alla banda [lo, hi]."""
    if fn is None:
        return None
    return lambda f: fn(lo + (hi - lo) * min(max(f, 0.0), 1.0))


def short_base_cache_dir() -> Path:
    """Cartella temporanea per gli short di BASE dell'editor (anteprima da modificare):
    non finiscono tra i file dell'utente; il finale va invece nella cartella del video."""
    import os
    d = Path(os.environ.get("DUCKY_CACHE_DIR", tempfile.gettempdir())) / "short-bases"
    d.mkdir(parents=True, exist_ok=True)
    return d


def prune_base_cache(max_age_s: float = 6 * 3600) -> None:
    """Elimina gli short di base più vecchi di ``max_age_s`` (pulizia opportunistica)."""
    try:
        now = time.time()
        for f in short_base_cache_dir().glob("*.mp4"):
            try:
                if now - f.stat().st_mtime > max_age_s:
                    f.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError:
        pass


# --------------------------------------------------------- "Rendi originale"
# Per pubblicare su Meta/Facebook senza essere trattati come re-upload, lo short
# riceve micro-trasformazioni che ne cambiano l'"impronta" audio/video pur restando
# fedele al contenuto. Tutto torch-free: solo filtri ffmpeg. I valori sono randomizzati
# entro un range a OGNI render, così due render dello stesso clip risultano diversi.

def _originality_filters(original: dict | None) -> tuple[list[str], list[str], list[str]]:
    """Costruisce i filtri ffmpeg anti-duplicato per "Rendi originale".

    Restituisce ``(vfilters_pre, vfilters_post, afilters)``: filtri video da applicare
    PRIMA dei sottotitoli, filtri video da applicare DOPO, e filtri audio. Tutte vuote
    se l'opzione è disattivata.

    L'ordine della catena video è ``vfilters_pre → subtitles → vfilters_post`` perché:
    - il **flip orizzontale** va PRIMA dei sottotitoli, così specchia solo l'immagine e
      NON i sottotitoli bruciati (che restano leggibili);
    - la **micro-speed** (``setpts``, solo "medio") va DOPO: i sottotitoli vengono bruciati
      sul timing originale e poi l'intero frame viene ri-temporizzato, mantenendo la
      sincronia con l'audio (a cui si applica lo stesso ``atempo``).

    - VIDEO: flip opzionale, color grade (eq+hue), bilanciamento colore (temperatura),
      grana temporale, vignetta, micro-zoom; micro-speed (solo "medio").
    - AUDIO: pitch/formant shift a durata invariata (asetrate→aresample→atempo), EQ
      leggera, loudness ridotta; micro-speed (solo "medio") come ``atempo`` uniforme.
    """
    if not (original and original.get("enabled")):
        return [], [], []

    medio = original.get("intensity") == "medio"
    r = random.uniform
    sign = lambda: random.choice((-1.0, 1.0))

    # ---- VIDEO ----
    if medio:
        hue = sign() * r(4.0, 7.0)
        sat = r(1.06, 1.09)
        contrast = r(1.04, 1.07)
        bright = sign() * r(0.005, 0.012)
        cb = sign() * r(0.03, 0.06)
        noise = 10
        zoom = r(1.04, 1.05)
        speed = r(1.025, 1.035)        # micro-speed attiva solo in "medio"
    else:
        hue = sign() * r(2.0, 4.0)
        sat = r(1.03, 1.05)
        contrast = r(1.02, 1.04)
        bright = sign() * r(0.003, 0.008)
        cb = sign() * r(0.015, 0.035)
        noise = 6
        zoom = r(1.02, 1.03)
        speed = 1.0

    vf_pre = []
    if original.get("flip"):
        vf_pre.append("hflip")               # PRIMA dei sottotitoli: non li specchia
    vf_pre += [
        f"eq=contrast={contrast:.3f}:saturation={sat:.3f}:brightness={bright:.4f}",
        f"hue=h={hue:.2f}",
        f"colorbalance=rm={cb:.3f}:bm={-cb:.3f}",        # caldo/freddo (temperatura)
        f"noise=alls={noise}:allf=t",
        "vignette",
        f"scale=iw*{zoom:.4f}:ih*{zoom:.4f},crop={SHORT_W}:{SHORT_H}",  # micro-zoom
    ]

    # ---- AUDIO ----
    if medio:
        pitch = 1.0 + sign() * r(0.04, 0.05)
        gain = -1.5
        eq_g = sign() * r(1.0, 2.0)
    else:
        pitch = 1.0 + sign() * r(0.02, 0.03)
        gain = -1.0
        eq_g = sign() * r(0.8, 1.5)
    eq_f = random.choice((180, 3000))

    # Il primo aresample fissa la base a 44100 (così il pitch shift è indipendente dal
    # sample rate sorgente): asetrate rietichetta la frequenza (alza pitch e velocità),
    # aresample riporta a 44100, atempo=1/pitch ripristina la durata lasciando il pitch.
    af = [
        "aresample=44100",
        f"asetrate={int(round(44100 * pitch))}",
        "aresample=44100",
        f"atempo={1.0 / pitch:.4f}",
        f"equalizer=f={eq_f}:t=q:w=1.0:g={eq_g:.2f}",
        f"volume={gain}dB",
    ]

    vf_post = []
    if speed != 1.0:                         # DOPO i sottotitoli: sync preservata
        vf_post.append(f"setpts=PTS/{speed:.4f}")
        af.append(f"atempo={speed:.4f}")

    return vf_pre, vf_post, af

def _validate(video_path: str, start: float, end: float):
    info = probe(video_path)
    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or start >= info.duration or end <= start:
        raise ValueError("Intervallo dello short non valido.")
    if end > info.duration + 0.5:
        raise ValueError("L'intervallo eccede la durata del video.")
    if end - start > MAX_SHORT_SECONDS:
        raise ValueError(f"Durata massima di uno short: {MAX_SHORT_SECONDS} s.")
    return info


def render_short(
    video_path: str,
    start: float,
    end: float,
    style: str = "blur",
    subtitles: dict | None = None,
    original: dict | None = None,
    dest_dir: str | None = None,
    on_progress=None,
    cancel: threading.Event | None = None,
    tracking: dict | None = None,
    diagnostics: dict | None = None,
) -> Path:
    """Genera lo short e restituisce il percorso del file creato.

    Se ``subtitles`` è attivo (``{"enabled": True, "style": {...}, "position": ...,
    "size": ..., "max_words": ...}``) trascrive l'audio del segmento, costruisce i
    sottotitoli (parola corrente evidenziata) e li BRUCIA nello short, con lo stile
    scelto adattato al formato verticale. ``dest_dir`` sposta l'output (default: la
    cartella del video sorgente; l'editor usa una cache temporanea per lo short di base).
    """
    info = _validate(video_path, start, end)
    end = min(end, info.duration)
    use_subs = bool(subtitles and subtitles.get("enabled"))

    # Filtri anti-duplicato ("Rendi originale"): calcolati UNA volta qui, così la
    # randomizzazione resta coerente per tutto il render (e identica tra i due stili).
    vf_pre, vf_post, afilters = _originality_filters(original)

    # Riserva il nome il più TARDI possibile (subito prima del render): se qualcosa
    # sopra fallisce non resta un segnaposto orfano. Il try sotto lo rimuove in caso
    # di errore/annullamento.
    out_path = sequenced_file(SHORT_FILE_NAME, Path(dest_dir) if dest_dir else Path(video_path).parent)

    def _render(ass_name, cwd, prog):
        if style == "crop":
            _render_tracked_crop(info, start, end, out_path, prog, cancel, ass_name, cwd,
                                  vf_pre, vf_post, afilters, tracking, diagnostics)
        elif style == "blur":
            _render_blur(video_path, start, end, out_path, prog, cancel, ass_name, cwd,
                         vf_pre, vf_post, afilters, diagnostics)
        else:
            raise ValueError(f"Stile short sconosciuto: {style}")

    try:
        if use_subs:
            with tempfile.TemporaryDirectory(prefix="duckyshort_") as tmp:
                tmp = Path(tmp)
                ass_name = _prepare_subtitles(
                    video_path, start, end, subtitles, tmp,
                    on_progress=_band(on_progress, 0.0, 0.4), cancel=cancel)
                _render(ass_name, str(tmp), _band(on_progress, 0.4, 1.0))
        else:
            _render(None, None, on_progress)
    except BaseException:
        out_path.unlink(missing_ok=True)   # render fallito/annullato: libera il segnaposto riservato
        raise
    return out_path


# ------------------------------------------------------------------ sottotitoli

def _prepare_subtitles(video_path, start, end, sub, tmp, on_progress, cancel):
    """Costruisce l'ASS dei sottotitoli (adattato al verticale) e restituisce il NOME
    del file (in ``tmp``), oppure ``None`` se non c'è niente da scrivere.

    Due sorgenti degli eventi:

    - se ``sub["events"]`` è presente (sottotitoli GIÀ modificati nell'editor per-short),
      si usano com'è — tempi RELATIVI al segmento (t=0 all'inizio dello short) — senza
      ri-trascrivere;
    - altrimenti si estrae l'audio del segmento, lo si trascrive e si costruiscono gli
      eventi al volo (comportamento storico, usato dalla configurazione globale)."""
    from . import semantic
    from .videomake import _write_ass, _has_audio   # riuso dell'infrastruttura di Video Make

    events = sub.get("events")
    if events is not None:
        # events PRESENTE (anche lista vuota) = sottotitoli già decisi nell'editor: si
        # onorano com'è, senza ri-trascrivere. Una lista vuota → nessun sottotitolo.
        events = _sanitize_events(events, end - start)
        if on_progress:
            on_progress(1.0)
    else:
        if not _has_audio(video_path):
            return None
        wav = tmp / "short_audio.wav"
        run_ffmpeg(["-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", video_path,
                    "-vn", "-ac", "1", "-ar", "16000", str(wav)], cancel=cancel)
        transcript = semantic.transcribe(str(wav), on_progress=on_progress, cancel=cancel)
        events = semantic.build_subtitle_events(
            transcript.words, int(sub.get("max_words", 4)))
    if not events:
        return None
    style = _adapt_style_vertical(
        sub.get("style") or {}, sub.get("position", "bottom"), float(sub.get("size", 1.0)))
    ass = tmp / "short_subs.ass"
    _write_ass(events, style, SHORT_W, SHORT_H, end - start, ass,
               max_lines=int(sub.get("max_lines", 2)))
    return ass.name


def _clampf(v, lo, hi):
    """float(v) limitato a [lo, hi]; ``lo`` se non convertibile o NaN."""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return lo
    if v != v:                      # NaN
        return lo
    return max(lo, min(hi, v))


MAX_SUB_EVENTS = 4000     # tetto di sicurezza sui blocchi (uno short reale ne ha ~decine)


def _sanitize_events(events, duration):
    """Ripulisce gli eventi ricevuti dall'editor (JSON dal client): tiene solo blocchi
    con parole non vuote e tempi finiti dentro ``[0, duration]``, ordina le parole per
    tempo e forza ``start <= end``. Difende ``_write_ass`` da input malformati, tempi
    fuori dal segmento o disordinati, e cappa il numero di blocchi (anti-DoS locale)."""
    duration = max(0.0, float(duration))
    clean = []
    for ev in (events or [])[:MAX_SUB_EVENTS]:
        if not isinstance(ev, dict):
            continue
        words = []
        for w in (ev.get("words") or []):
            if not isinstance(w, dict):
                continue
            text = str(w.get("text", "")).strip()
            if not text:
                continue
            t0 = _clampf(w.get("t0", ev.get("start", 0.0)), 0.0, duration)
            t1 = _clampf(w.get("t1", t0), 0.0, duration)
            if t1 < t0:
                t1 = t0
            words.append({"t0": t0, "t1": t1, "text": text})
        if not words:
            continue
        words.sort(key=lambda x: x["t0"])   # karaoke corretto anche con parole disordinate
        start = _clampf(ev.get("start", words[0]["t0"]), 0.0, duration)
        end = _clampf(ev.get("end", words[-1]["t1"]), 0.0, duration)
        if end < start:
            end = start
        out = {"start": start, "end": end, "words": words}
        # A-capo per-parola decisi dall'editor (larghezza): passati com'è; li valida
        # _write_ass (_clean_rows) contro il conteggio parole finale, con fallback sicuro.
        if isinstance(ev.get("rows"), list):
            out["rows"] = ev["rows"]
        clean.append(out)
    return clean


def transcribe_segment(video_path, start, end, max_words=4,
                       on_progress=None, cancel=None) -> dict:
    """Trascrive l'audio del solo segmento ``[start, end]`` e ne costruisce i blocchi di
    sottotitoli, in tempo RELATIVO al segmento (t=0 all'inizio dello short). Serve
    all'editor per-short: parole ed eventi si modificano nel client e si rimandano poi a
    ``render_short`` (che li brucia senza ri-trascrivere).

    Ritorna ``{"has_audio": bool, "words": [{start,end,text}], "events": [...]}``."""
    from . import semantic
    from .videomake import _has_audio

    info = _validate(video_path, start, end)
    end = min(end, info.duration)
    if not _has_audio(video_path):
        return {"has_audio": False, "words": [], "events": []}
    with tempfile.TemporaryDirectory(prefix="duckyshort_") as tmp:
        wav = Path(tmp) / "short_audio.wav"
        run_ffmpeg(["-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", video_path,
                    "-vn", "-ac", "1", "-ar", "16000", str(wav)], cancel=cancel)
        transcript = semantic.transcribe(str(wav), on_progress=on_progress, cancel=cancel)
    words = [{"start": round(w.start, 3), "end": round(w.end, 3), "text": w.text}
             for w in transcript.words if w.end > w.start and w.text.strip()]
    events = semantic.build_subtitle_events(transcript.words, int(max_words))
    return {"has_audio": True, "words": words, "events": events}


def _adapt_style_vertical(style: dict, position: str, size_mult: float) -> dict:
    """Adatta uno stile di Video Make (tarato 16:9) al formato verticale: scala i
    frac di dimensione per il lato corto e applica posizione e moltiplicatore scelti."""
    from .config import SUBTITLE_DEFAULT_STYLE
    st = {**SUBTITLE_DEFAULT_STYLE, **(style or {})}
    # Coercizione difensiva: lo stile arriva come dict JSON non validato dal client, e
    # sia qui che in _write_ass i frac numerici entrano in operazioni aritmetiche. Un
    # valore non numerico (es. "0.05") farebbe fallire il render con un TypeError opaco.
    for key, hi in (("size_frac", 1.0), ("outline", 1.0), ("shadow", 1.0),
                    ("margin_frac", 1.0), ("box_opacity", 1.0)):
        if key in st:
            st[key] = _clampf(st[key], 0.0, hi)
    st["position"] = position if position in ("top", "center", "bottom") else st.get("position", "bottom")
    k = SUB_VERTICAL_K * max(0.3, min(size_mult, 3.0))
    for key in ("size_frac", "outline", "shadow"):
        if st.get(key):
            st[key] = st[key] * k
    return st


# ------------------------------------------------------------------ finalizzazione (editor)
# L'editor apre uno short GIÀ generato (1080x1920 con audio) e vi applica, in un solo
# passaggio ffmpeg, le modifiche scelte: specchiatura, filtri colore, sottotitoli
# bruciati e cornice. Non ri-esegue crop/blur (evita di rifare il tracking, costoso).

def _color_filter_chain(filters: dict | None) -> list[str]:
    """Filtri colore ffmpeg dal modello dell'editor (fattori in stile CSS: 1.0 = neutro).
    ``contrast``/``saturation`` sono moltiplicativi (come CSS), ``brightness`` è reso come
    additivo ``b-1`` (approssimazione del fattore CSS), ``warmth`` è temperatura via
    colorbalance, ``grayscale`` porta la saturazione a 0."""
    if not filters:
        return []
    b = _clampf(filters.get("brightness", 1.0), 0.2, 2.0)
    c = _clampf(filters.get("contrast", 1.0), 0.2, 2.0)
    s = _clampf(filters.get("saturation", 1.0), 0.0, 3.0)
    w = _clampf(filters.get("warmth", 0.0), -1.0, 1.0)
    if filters.get("grayscale"):
        s = 0.0
    out = []
    # Luminosità MOLTIPLICATIVA (come CSS brightness()): colorchannelmixer scala i tre
    # canali di b. `eq=brightness` è additivo e schiarirebbe troppo le ombre (diverso
    # dall'anteprima). Contrasto e saturazione via eq (moltiplicativi, = CSS).
    if abs(b - 1) > 1e-3:
        out.append(f"colorchannelmixer=rr={b:.3f}:gg={b:.3f}:bb={b:.3f}")
    if abs(c - 1) > 1e-3 or abs(s - 1) > 1e-3:
        out.append(f"eq=contrast={c:.3f}:saturation={s:.3f}")
    if abs(w) > 1e-3:
        out.append(f"colorbalance=rm={w * 0.3:.3f}:gm={w * 0.05:.3f}:bm={-w * 0.3:.3f}")
    return out


def _write_frame_png(data_url, tmp: Path):
    """Decodifica il PNG della cornice (data URL base64 dal client) in ``tmp/frame.png``.
    La cornice è disegnata su canvas nel client a 1080x1920 e sovrapposta com'è → parità
    perfetta con l'anteprima. Ritorna il Path, oppure ``None`` se assente/non valido."""
    import base64
    s = data_url or ""
    if s.startswith("data:"):
        s = s.split(",", 1)[1] if "," in s else ""
    try:
        raw = base64.b64decode(s, validate=False)
    except (ValueError, TypeError):
        return None
    if not raw or raw[:8] != b"\x89PNG\r\n\x1a\n":   # firma PNG: rifiuta input non-PNG
        return None
    p = tmp / "frame.png"
    p.write_bytes(raw)
    return p


def _clean_logo_box(box) -> dict | None:
    """Valida il riquadro del logo (frazioni 0..1 del fotogramma) da proteggere dalla
    specchiatura. Ritorna ``{x,y,w,h}`` clampato, oppure ``None`` se assente/degenere."""
    if not isinstance(box, dict):
        return None
    x = _clampf(box.get("x", 0.0), 0.0, 1.0)
    y = _clampf(box.get("y", 0.0), 0.0, 1.0)
    w = _clampf(box.get("w", 0.0), 0.0, 1.0)
    h = _clampf(box.get("h", 0.0), 0.0, 1.0)
    w = min(w, 1.0 - x)
    h = min(h, 1.0 - y)
    if w < 0.01 or h < 0.01:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def finalize_short(base_path: str, dest_dir: str | None = None,
                   subtitles: dict | None = None, filters: dict | None = None,
                   frame_png: str | None = None, mirror: bool = False,
                   logo_box: dict | None = None,
                   on_progress=None, cancel: threading.Event | None = None) -> Path:
    """Applica al base short le modifiche dell'editor (specchiatura → filtri colore →
    sottotitoli → cornice) e restituisce il nuovo file finale. L'audio si copia (nessun
    filtro audio qui). La cornice è un overlay PNG a piena risoluzione.

    Se ``mirror`` e ``logo_box`` sono attivi, la porzione del logo (frazioni del frame)
    viene RICUCITA dall'originale non specchiato sopra il video specchiato, così il logo
    del canale resta dritto e nella sua posizione (in basso a destra)."""
    base = Path(base_path)
    if not base.is_file():
        raise ValueError("Short di base non trovato.")
    info = probe(str(base))
    duration = info.duration
    out_dir = Path(dest_dir) if dest_dir else base.parent
    out_path = sequenced_file(SHORT_FILE_NAME, out_dir)

    use_subs = bool(subtitles and subtitles.get("enabled"))
    logo = _clean_logo_box(logo_box) if mirror else None
    try:
        if use_subs or frame_png:
            with tempfile.TemporaryDirectory(prefix="duckyshortfin_") as tmp:
                tmp = Path(tmp)
                ass_name = _build_ass_for_base(subtitles, duration, tmp) if use_subs else None
                png_path = _write_frame_png(frame_png, tmp) if frame_png else None
                _finalize_encode(base, out_path, ass_name, str(tmp), filters, png_path, mirror,
                                 logo, duration, on_progress, cancel)
        else:
            _finalize_encode(base, out_path, None, None, filters, None, mirror,
                             logo, duration, on_progress, cancel)
    except BaseException:
        out_path.unlink(missing_ok=True)
        raise
    return out_path


def _build_ass_for_base(sub: dict, duration: float, tmp: Path) -> str | None:
    """ASS dei sottotitoli per il base short (timeline 0..duration, tempi segment-relative).
    Usa gli eventi GIÀ modificati nell'editor: nessuna trascrizione qui."""
    from .videomake import _write_ass
    events = _sanitize_events(sub.get("events") or [], duration)
    if not events:
        return None
    style = _adapt_style_vertical(
        sub.get("style") or {}, sub.get("position", "bottom"), float(sub.get("size", 1.0)))
    ass = tmp / "short_subs.ass"
    _write_ass(events, style, SHORT_W, SHORT_H, duration, ass,
               max_lines=int(sub.get("max_lines", 2)))
    return ass.name


def _finalize_encode(base, out_path, ass_name, cwd, filters, frame_png, mirror,
                     logo_box, duration, on_progress, cancel):
    # Ordine: (filtri colore) → specchia [+ ricuci logo] → cornice (overlay PNG) →
    # sottotitoli (in cima, sempre leggibili). La specchiatura agisce solo sul video.
    cfilters = _color_filter_chain(filters)
    inputs = ["-i", str(base)]
    frame_idx = None
    if frame_png:
        inputs += ["-i", str(frame_png)]
        frame_idx = 1

    # Percorso semplice (-vf) quando non servono overlay (né cornice né ricucitura logo).
    need_complex = bool(frame_png) or (mirror and logo_box)
    if not need_complex:
        chain = (["hflip"] if mirror else []) + cfilters
        if ass_name:
            chain.append(f"subtitles={ass_name}")
        graph = ["-vf", ",".join(chain)] if chain else []
    else:
        parts = []
        cur = "[0:v]"
        if cfilters:                                   # color grade (senza flip)
            parts.append(f"{cur}{','.join(cfilters)}[g]"); cur = "[g]"
        if mirror and logo_box:
            b = logo_box
            x, y, w, h = b['x'], b['y'], b['w'], b['h']
            mx = max(0.0, 1.0 - x - w)     # posizione orizzontale SPECCHIATA del logo (basso sx)
            crop_logo = f"crop=iw*{w:.5f}:ih*{h:.5f}:iw*{x:.5f}:ih*{y:.5f}"
            crop_cover = f"crop=iw*{w:.5f}:ih*{h:.5f}:iw*{mx:.5f}:ih*{y:.5f}"
            # Dal video graduato: [m] si specchia; [l] = logo originale (basso dx, non
            # specchiato); [c] = angolo originale basso SX (pulito). Si copre il logo
            # specchiato (basso sx) col contenuto pulito e si rimette il logo dritto a dx.
            parts.append(f"{cur}split=3[m][l][c]")
            parts.append("[m]hflip[mf]")
            parts.append(f"[l]{crop_logo}[lg]")
            parts.append(f"[c]{crop_cover}[cv]")
            parts.append(f"[mf][cv]overlay=W*{mx:.5f}:H*{y:.5f}[a]")
            parts.append(f"[a][lg]overlay=W*{x:.5f}:H*{y:.5f}[v]")
            cur = "[v]"
        elif mirror:
            parts.append(f"{cur}hflip[v]"); cur = "[v]"
        if frame_png:
            parts.append(f"{cur}[{frame_idx}:v]overlay=0:0[vf]"); cur = "[vf]"
        if ass_name:
            parts.append(f"{cur}subtitles={ass_name}[o]"); cur = "[o]"
        graph = ["-filter_complex", ";".join(parts), "-map", cur, "-map", "0:a?"]

    run_encoded_ffmpeg(
        [*inputs, *graph],
        [
         "-c:a", "copy",                         # nessun filtro audio: copia veloce
         "-movflags", "+faststart",
         str(out_path)],
        duration=duration, on_progress=on_progress, cancel=cancel, cwd=cwd, quality=SHORT_CRF,
    )


# ------------------------------------------------------------------ blur

def _render_blur(video_path, start, end, out_path, on_progress, cancel,
                 ass_name=None, cwd=None, vf_pre=None, vf_post=None, afilters=None, diagnostics=None):
    duration = end - start
    filtergraph = (
        "[0:v]split=2[bg][fg];"
        f"[bg]scale={SHORT_W}:{SHORT_H}:force_original_aspect_ratio=increase,"
        f"crop={SHORT_W}:{SHORT_H},boxblur=18:2[b];"
        f"[fg]scale={SHORT_W}:{SHORT_H}:force_original_aspect_ratio=decrease[f];"
        "[b][f]overlay=(W-w)/2:(H-h)/2"
    )
    # Catena video sul frame finale 1080x1920: flip+grade "Rendi originale" (vf_pre),
    # poi i sottotitoli bruciati (così non vengono specchiati), infine la micro-speed
    # (vf_post), che ri-temporizza i frame già sottotitolati senza sfasarli.
    chain = []
    if vf_pre:
        chain.extend(vf_pre)
    if ass_name:
        chain.append(f"subtitles={ass_name}")
    if vf_post:
        chain.extend(vf_post)
    maps, extra = [], []
    if chain:
        filtergraph += "[vid];[vid]" + ",".join(chain) + "[v]"
        maps = ["-map", "[v]", "-map", "0:a?"]
    if afilters:
        extra += ["-af", ",".join(afilters)]
        if not maps:
            maps = ["-map", "0:v", "-map", "0:a?"]
    if vf_pre:                                     # metadata puliti col "Rendi originale"
        extra += ["-map_metadata", "-1"]
    run_encoded_ffmpeg(
        ["-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", video_path,
         "-filter_complex", filtergraph, *maps, *extra],
        [
         "-c:a", "aac",
         "-movflags", "+faststart",
         str(out_path)],
        duration=duration, on_progress=on_progress, cancel=cancel, cwd=cwd, quality=SHORT_CRF, diagnostics=diagnostics,
    )


# ------------------------------------------------------------------ crop con tracking

def _face_cascade():
    try:
        cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        return cascade if not cascade.empty() else None
    except Exception:
        return None


def _render_tracked_crop(info, start, end, out_path, on_progress, cancel,
                         ass_name=None, cwd=None, vf_pre=None, vf_post=None, afilters=None,
                         tracking=None, diagnostics=None):
    encoding=choose_encoding({"quality":SHORT_CRF},cancel=cancel)
    if diagnostics is not None: diagnostics["encoding"]=encoding.diagnostic()
    if on_progress: report_encoding(on_progress,0,encoding,False)
    try:
        _render_tracked_crop_once(info,start,end,out_path,on_progress,cancel,ass_name,cwd,vf_pre,vf_post,afilters,tracking,diagnostics,encoding)
    except FfmpegError as error:
        if encoding.encoder=="libx264" or not is_hardware_failure(error) or cancel is not None and cancel.is_set(): raise
        encoding=cpu_encoding(SHORT_CRF,"Encoder GPU non disponibile durante la codifica; ripiego CPU.")
        if diagnostics is not None: diagnostics["encoding"]=encoding.diagnostic()
        if on_progress: report_encoding(on_progress,0,encoding,False)
        _render_tracked_crop_once(info,start,end,out_path,on_progress,cancel,ass_name,cwd,vf_pre,vf_post,afilters,tracking,diagnostics,encoding)


def _render_tracked_crop_once(info, start, end, out_path, on_progress, cancel,
                         ass_name=None, cwd=None, vf_pre=None, vf_post=None, afilters=None,
                         tracking=None, diagnostics=None, encoding=None):
    from .tracking import track_video, frame_for_view, _scene_cut
    duration = end - start
    plan = track_video(info, start, end, tracking, on_progress, cancel)
    if diagnostics is not None:
        diagnostics.update(plan.stats)

    fps = info.fps
    total_frames = max(1, int(round(duration * fps)))

    # Catena video sul frame ritagliato: flip+grade (vf_pre) → sottotitoli bruciati (non
    # specchiati) → micro-speed (vf_post). Stesso ordine del rendering blur.
    chain = []
    if vf_pre:
        chain.extend(vf_pre)
    if ass_name:
        chain.append(f"subtitles={ass_name}")
    if vf_post:
        chain.extend(vf_post)
    vf = ["-vf", ",".join(chain)] if chain else []
    af = ["-af", ",".join(afilters)] if afilters else []
    meta = ["-map_metadata", "-1"] if vf_pre else []
    encoder = subprocess.Popen(
        [FFMPEG_EXE, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", f"{SHORT_W}x{SHORT_H}", "-r", f"{fps:.6f}", "-i", "pipe:0",
         "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", info.path,
         "-map", "0:v", "-map", "1:a?", *vf, *af, *meta,
         *encoding.args,
         "-c:a", "aac",
         "-movflags", "+faststart",
         "-shortest",
         str(out_path)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=cwd,
        creationflags=CREATE_NO_WINDOW,
    )

    stderr_tail: list[bytes] = []
    drain = threading.Thread(
        target=lambda: stderr_tail.append(encoder.stderr.read()), daemon=True)
    drain.start()

    cap = cv2.VideoCapture(info.path)
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    written = 0
    previous_frame = None
    cut_override = None
    try:
        while written < total_frames:
            if cancel is not None and cancel.is_set():
                raise InterruptedError("Generazione annullata.")
            ok, frame = cap.read()
            if not ok:
                break
            center, view_width = plan.at(written / fps)
            # Refine the 8-fps analysis cut on the output frame. Hold the NEW
            # shot's camera immediately; never slide the old subject into it.
            moment = written / fps
            if previous_frame is not None and _scene_cut(previous_frame, frame):
                following = int(np.searchsorted(plan.times, moment, side="left"))
                if following < len(plan.times) and plan.cuts[following] and plan.times[following] - moment <= .2:
                    cut_override = (plan.times[following], plan.centers[following], plan.widths[following])
            if cut_override is not None:
                if moment < cut_override[0]:
                    center, view_width = cut_override[1:]
                else:
                    cut_override = None
            previous_frame = frame
            resized = frame_for_view(frame, center, view_width, SHORT_W, SHORT_H)
            try:
                encoder.stdin.write(memoryview(np.ascontiguousarray(resized)))
            except OSError:
                break  # ffmpeg è morto: l'errore esce dal returncode
            written += 1
            if on_progress and written % 10 == 0:
                on_progress(0.18 + 0.82 * written / total_frames)
    finally:
        cap.release()
        try:
            encoder.stdin.close()
        except OSError:
            pass
        encoder.wait()
        drain.join(timeout=2)
        encoder.stderr.close()

    if cancel is not None and cancel.is_set():
        raise InterruptedError("Generazione annullata.")
    if encoder.returncode != 0:
        detail = (stderr_tail[0].decode("utf-8", "replace")[-1500:]
                  if stderr_tail else "nessun dettaglio")
        raise FfmpegError(f"Codifica dello short fallita:\n{detail}")
    if written == 0:
        raise FfmpegError("Nessun frame letto dall'intervallo richiesto.")
    if on_progress:
        on_progress(1.0)
