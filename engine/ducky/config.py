"""Percorsi e costanti del progetto.

Funziona sia in sviluppo sia da eseguibile PyInstaller (frozen): in quel caso
la radice è la cartella accanto all'eseguibile, dove il build script copia
``app/static``.
"""

import shutil
import sys
import os
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)

if FROZEN:
    PROJECT_ROOT = Path(sys.executable).resolve().parent
else:
    PROJECT_ROOT = Path(__file__).resolve().parents[1]

STATIC_DIR = PROJECT_ROOT / "app" / "static"

# Estensioni video accettate (selezione file e streaming verso il browser).
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".mpeg", ".mpg", ".webm", ".m4v"}

# Limiti operativi.
MAX_FRAME_COUNT = 99999          # numero massimo di screen estraibili
MAX_CLIP_SECONDS = 240           # durata massima di una Ducky CLIP (4 minuti)
MAX_SPLIT_PARTS = 500            # numero massimo di parti per lo split

# Parametri di codifica delle clip.
X264_PRESET = "fast"
X264_CRF = "23"

# Miglioramento immagini (valori storici di Ducky Bright).
BRIGHT_FACTOR = 1.3
CONTRAST_FACTOR = 1.1

# Nomi delle cartelle/file di output (numerati automaticamente).
FRAMES_DIR_NAME = "DuckySF"
MERGE_DIR_NAME = "DuckyORD"
SPLIT_DIR_NAME = "DuckySPLIT"
BRIGHT_DIR_NAME = "Ducky Bright"
CLIP_FILE_NAME = "Ducky CLIP"
DOWNLOAD_FILE_NAME = "Ducky VIDEO"
VIDEO_MAKE_FILE_NAME = "Ducky VIDEO MAKE"

# ----------------------------------------------------------------- Video Make
# Cache dei modelli IA (faster-whisper + CLIP ONNX). Scaricati al primo uso,
# poi tutto offline. Tenuti accanto all'app/eseguibile così sono persistenti.
MODELS_DIR = Path(os.environ.get("DUCKY_MODELS_DIR", str(Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "DuckyMovie" / "models")))

# Trascrizione: modello Whisper (CTranslate2). "small" = buon compromesso
# qualità/velocità su CPU; "base" più veloce, "medium" più accurato.
WHISPER_MODEL = "small"

# Abbinamento testo↔immagine (fastembed, ONNX, niente torch). jina-clip-v1 è
# MULTILINGUE: abbina l'italiano direttamente, senza tradurre in inglese, ed è
# più forte di CLIP B/32. Se troppo pesante/lento su CPU, mettere CLIP_FALLBACK.
CLIP_MODEL = "jinaai/jina-clip-v1"
CLIP_MODEL_FALLBACK_IMAGE = "Qdrant/clip-ViT-B-32-vision"
CLIP_MODEL_FALLBACK_TEXT = "Qdrant/clip-ViT-B-32-text"
USE_CLIP_FALLBACK = False        # True → torna a CLIP B/32 (più leggero)

# Estensioni accettate per gli input di Video Make.
IMAGE_INPUT_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
AUDIO_INPUT_EXTENSIONS = {".wav"}
DOCX_INPUT_EXTENSIONS = {".docx"}

# Durata di ogni immagine (secondi), agganciata alle frasi dell'audio.
IMAGE_MIN_SECONDS = 3.0
IMAGE_MAX_SECONDS = 4.0
# Quando le immagini non bastano a coprire l'audio, si può allungare fin qui.
IMAGE_STRETCH_SECONDS = 6.0

# Transizione (crossfade) tra un'immagine e l'altra.
CROSSFADE_SECONDS = 0.5

# Zoom Ken Burns: scala finale (1.0 = nessuno zoom). Non invadente.
ZOOM_MAX_SCALE = 1.07

# Logo: larghezza e margine come frazione della larghezza del video. Il margine
# vale sia a destra sia sotto: il logo sta in basso a destra ma staccato dai bordi.
LOGO_WIDTH_FRAC = 0.12
LOGO_MARGIN_FRAC = 0.045

# L'outro termina questi secondi dopo la fine dell'audio narrante.
OUTRO_TAIL_SECONDS = 3.0

# Soglie di abbinamento (coseno, embedding normalizzati). Tarate per jina-clip-v1.
# Sopra DEDUP_SIMILARITY due immagini sono considerate quasi-duplicate.
DEDUP_SIMILARITY = 0.92
# Sotto OFFTOPIC_SIMILARITY un'immagine è "fuori tema" rispetto a ogni finestra.
# Conservativo (scarta poco): tanto ora c'è la revisione manuale nell'editor.
OFFTOPIC_SIMILARITY = 0.12

# ----------------------------------------------------------------- Sottotitoli
# Sottotitoli: la parola PRONUNCIATA IN QUEL MOMENTO viene evidenziata (solo
# quella, non in modo cumulativo), mostrando un blocco di al massimo
# SUBTITLE_MAX_WORDS parole su al massimo SUBTITLE_MAX_LINES righe (il blocco può
# usarne meno, spezzando su pause/punteggiatura). Generati dalla trascrizione
# (parole+tempi), personalizzabili nell'editor e BRUCIATI nel video finale come
# ASS col filtro ffmpeg ``subtitles=``. L'anteprima li disegna su canvas in modo
# coerente. I valori sono il preset di default ("Pulito").
SUBTITLE_MAX_WORDS = 5           # parole MASSIME per blocco (può usarne meno)
SUBTITLE_MAX_LINES = 2           # righe MASSIME per blocco
SUBTITLE_DEFAULT_STYLE = {
    "font": "Segoe UI",
    "size_frac": 0.052,          # dimensione font come frazione dell'altezza
    "color": "#FFFFFF",          # testo (parola non ancora pronunciata)
    "active_color": "#F59E0B",   # parola in pronuncia (evidenziata)
    "outline": 0.006,            # spessore contorno (frazione altezza)
    "outline_color": "#000000",
    "shadow": 0.004,             # ombra (frazione altezza)
    "box": False,                # sfondo opaco dietro il testo
    "box_color": "#000000",
    "box_opacity": 0.55,
    "position": "bottom",        # bottom | center | top
    "margin_frac": 0.10,         # distanza dal bordo (frazione altezza)
    "uppercase": False,
    "bold": True,
    "anim": "fade",              # fade | none (comparsa morbida del blocco)
}

# ----------------------------------------------------------------- Musica
# Traccia musicale di sottofondo facoltativa, mixata sotto la narrazione con
# ducking automatico (la musica si abbassa quando si parla).
MUSIC_DEFAULT_VOLUME = 0.15      # 0..1, guadagno della musica nel mix
MUSIC_DEFAULT_DUCK = True        # abbassa la musica sotto la voce (sidechain)


def find_ffmpeg() -> str | None:
    """Percorso dell'eseguibile ffmpeg.

    Ordine: PATH di sistema, poi il binario statico di imageio-ffmpeg
    (incluso nel pacchetto, così l'app funziona anche senza ffmpeg installato).
    """
    configured = os.environ.get("DUCKY_FFMPEG_PATH")
    if configured and Path(configured).is_file():
        return configured
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG_EXE = find_ffmpeg()
