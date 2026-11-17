"""Comprensione semantica per Video Make: trascrizione audio, embedding CLIP,
deduplica delle immagini e abbinamento frase↔immagine.

Tutto in locale e senza PyTorch:

- **faster-whisper** (CTranslate2) trascrive il WAV traducendolo in inglese con
  i tempi delle parole: ci dà sia *quando* si dice una cosa sia il *testo-query*
  in inglese da confrontare con le immagini (CLIP qui è in inglese).
- **fastembed** esegue CLIP ViT-B/32 (immagine + testo) in ONNX su CPU; gestisce
  da sé tokenizzazione, preprocessing e download dei modelli.

I modelli vengono scaricati al primo uso in ``config.MODELS_DIR`` e poi
riutilizzati offline. Le librerie pesanti sono importate in modo pigro così il
server parte normalmente anche prima del primo download.
"""

import re
import threading
from dataclasses import dataclass, field

import numpy as np

from .config import (CLIP_MODEL, CLIP_MODEL_FALLBACK_IMAGE,
                     CLIP_MODEL_FALLBACK_TEXT, DEDUP_SIMILARITY,
                     IMAGE_MAX_SECONDS, IMAGE_MIN_SECONDS, MODELS_DIR,
                     OFFTOPIC_SIMILARITY, USE_CLIP_FALLBACK, WHISPER_MODEL)

# Modelli CLIP (fastembed, ONNX). Default: jina-clip-v1, multilingue, immagine e
# testo nello stesso spazio (stesso nome modello per entrambi). Fallback: le due
# metà di CLIP ViT-B/32 (più leggere). Embedding L2-normalizzati a valle.
CLIP_IMAGE_MODEL = CLIP_MODEL_FALLBACK_IMAGE if USE_CLIP_FALLBACK else CLIP_MODEL
CLIP_TEXT_MODEL = CLIP_MODEL_FALLBACK_TEXT if USE_CLIP_FALLBACK else CLIP_MODEL

# Dimensione embedding di default (jina-clip-v1 = 768, CLIP B/32 = 512): usata
# solo per gli array vuoti/di fallback; con input reali la dimensione è dedotta.
DEFAULT_EMB_DIM = 512 if USE_CLIP_FALLBACK else 768

# ----------------------------------------------------------------- modelli (pigri)

_lock = threading.Lock()
_whisper = None
_clip_image = None
_clip_text = None


def _get_whisper():
    global _whisper
    with _lock:
        if _whisper is None:
            from faster_whisper import WhisperModel
            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            # int8 su CPU: leggero e veloce, qualità più che sufficiente.
            _whisper = WhisperModel(
                WHISPER_MODEL, device="cpu", compute_type="int8",
                download_root=str(MODELS_DIR))
        return _whisper


def _get_clip_image():
    global _clip_image
    with _lock:
        if _clip_image is None:
            from fastembed import ImageEmbedding
            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            _clip_image = ImageEmbedding(CLIP_IMAGE_MODEL, cache_dir=str(MODELS_DIR))
        return _clip_image


def _ensure_jina_text_onnx():
    """Aggira un bug di fastembed: dopo che ImageEmbedding ha creato lo snapshot
    di jina-clip-v1 con il solo ``vision_model.onnx``, TextEmbedding non scarica
    più ``text_model.onnx`` (e fallisce con "file doesn't exist"). Lo forziamo."""
    if CLIP_TEXT_MODEL != "jinaai/jina-clip-v1":
        return
    try:
        from huggingface_hub import hf_hub_download
        hf_hub_download("jinaai/jina-clip-v1", "onnx/text_model.onnx",
                        cache_dir=str(MODELS_DIR))
    except Exception:
        pass  # in caso di problemi ci prova TextEmbedding, con errore esplicito


def _get_clip_text():
    global _clip_text
    with _lock:
        if _clip_text is None:
            from fastembed import TextEmbedding
            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            _ensure_jina_text_onnx()
            _clip_text = TextEmbedding(CLIP_TEXT_MODEL, cache_dir=str(MODELS_DIR))
        return _clip_text


def _normalize(vectors: np.ndarray) -> np.ndarray:
    """Normalizza L2 ogni riga (il prodotto scalare diventa coseno)."""
    norms = np.linalg.norm(vectors, axis=-1, keepdims=True)
    return vectors / np.clip(norms, 1e-8, None)


# ----------------------------------------------------------------- trascrizione

@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Transcript:
    duration: float
    words: list[Word] = field(default_factory=list)

    @property
    def total_text(self) -> str:
        return " ".join(w.text for w in self.words).strip()


def transcribe(wav_path: str, language: str = "it",
               on_progress=None, cancel: threading.Event | None = None) -> Transcript:
    """Trascrive l'audio (lingua ``language``) con i tempi delle parole.

    Trascrizione, non traduzione: il modello CLIP è multilingue e abbina il
    testo italiano direttamente. Restituisce le parole con start/end (secondi).
    """
    model = _get_whisper()
    segments, info = model.transcribe(
        wav_path, task="transcribe", language=language,
        word_timestamps=True, vad_filter=True)
    duration = float(getattr(info, "duration", 0.0)) or 0.0

    words: list[Word] = []
    for seg in segments:                       # generatore: la decodifica è qui
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Trascrizione annullata.")
        seg_words = getattr(seg, "words", None)
        if seg_words:
            for w in seg_words:
                token = (w.word or "").strip()
                if token:
                    words.append(Word(float(w.start), float(w.end), token))
        elif (seg.text or "").strip():         # fallback senza tempi-parola
            words.append(Word(float(seg.start), float(seg.end), seg.text.strip()))
        if on_progress and duration:
            on_progress(min(float(seg.end) / duration, 1.0))

    if not duration and words:
        duration = words[-1].end
    return Transcript(duration=duration, words=words)


# ----------------------------------------------------------------- testo Word

def read_docx(path: str) -> str:
    """Testo completo del copione .docx (paragrafi non vuoti)."""
    from docx import Document
    doc = Document(path)
    return "\n".join(p.text for p in doc.paragraphs if p.text.strip())


def split_sentences(text: str) -> list[str]:
    """Frasi del copione (split su . ! ? e a capo)."""
    return [s.strip() for s in re.split(r"[.!?\n]+", text) if s.strip()]


def count_sentences(text: str) -> int:
    """Stima del numero di frasi (per il fallback delle finestre)."""
    return len(split_sentences(text))


def _tokens(text: str) -> set[str]:
    """Token significativi (parole di ≥3 lettere, minuscole)."""
    return {w for w in re.findall(r"[\wàèéìòùáíóú]+", text.lower()) if len(w) >= 3}


def refine_windows_with_script(windows: list["Window"], script_text: str) -> None:
    """Sostituisce il testo (ASR, rumoroso) di ogni finestra con la frase del
    copione più sovrapposta, quando l'aggancio è chiaro. Modifica in-place.

    Il copione Word è il testo "pulito": usarlo come query migliora l'abbinamento
    con le immagini. Si tiene l'ASR se nessuna frase combacia abbastanza.
    """
    sentences = split_sentences(script_text)
    if not sentences or not windows:
        return
    sent_tokens = [(_tokens(s), s) for s in sentences]
    for win in windows:
        wt = _tokens(win.text)
        if not wt:
            continue
        best_score, best_sentence = 0.0, None
        for toks, sentence in sent_tokens:
            if not toks:
                continue
            overlap = len(wt & toks) / len(wt)   # quota di parole della finestra coperte
            if overlap > best_score:
                best_score, best_sentence = overlap, sentence
        if best_sentence is not None and best_score >= 0.5:
            win.text = best_sentence


# ----------------------------------------------------------------- finestre

@dataclass
class Window:
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return self.end - self.start


def build_windows(transcript: Transcript, audio_duration: float,
                  fallback_sentences: int = 0,
                  img_min: float | None = None,
                  img_max: float | None = None) -> list[Window]:
    """Divide la linea temporale dell'audio in finestre consecutive di
    img_min..img_max secondi (default IMAGE_MIN..IMAGE_MAX), agganciate alla fine
    delle parole, ognuna con il testo pronunciato al suo interno.

    Se l'audio non ha parlato riconoscibile, ripiega su finestre regolari
    (numero stimato dal copione, altrimenti dalla durata)."""
    img_min = IMAGE_MIN_SECONDS if img_min is None else float(img_min)
    img_max = IMAGE_MAX_SECONDS if img_max is None else float(img_max)
    if img_max < img_min:
        img_min, img_max = img_max, img_min
    target = (img_min + img_max) / 2
    duration = max(audio_duration, transcript.duration)
    if duration <= 0:
        return []

    words = [w for w in transcript.words if w.end > w.start]
    if not words:
        return _regular_windows(duration, fallback_sentences)

    word_ends = np.array([w.end for w in words])

    # Punti di taglio agganciati alle fini-parola, distanti img_min..img_max s.
    cuts = [0.0]
    while cuts[-1] < duration - 0.05:
        lo, hi = cuts[-1] + img_min, cuts[-1] + img_max
        candidates = word_ends[(word_ends >= lo) & (word_ends <= hi)]
        if candidates.size:
            cut = float(candidates[np.argmin(np.abs(candidates - (cuts[-1] + target)))])
        else:
            cut = min(hi, duration)
        if cut <= cuts[-1] + 0.05:             # nessun progresso: forza avanti
            cut = min(cuts[-1] + IMAGE_MAX_SECONDS, duration)
        cuts.append(cut)
    cuts[-1] = duration

    windows: list[Window] = []
    for a, b in zip(cuts, cuts[1:]):
        mids = [w.text for w in words if a <= (w.start + w.end) / 2 < b]
        windows.append(Window(a, b, " ".join(mids).strip()))
    return windows


def _regular_windows(duration: float, sentences: int) -> list[Window]:
    target = (IMAGE_MIN_SECONDS + IMAGE_MAX_SECONDS) / 2
    n = sentences if sentences > 0 else max(1, round(duration / target))
    n = max(1, min(n, int(duration / IMAGE_MIN_SECONDS) or 1))
    step = duration / n
    return [Window(i * step, (i + 1) * step, "") for i in range(n)]


# ----------------------------------------------------------------- sottotitoli

_END_PUNCT = ".!?…"
_SOFT_PUNCT = ",;:"
_PAUSE_GAP = 0.45        # secondi di silenzio che giustificano uno stacco


def build_subtitle_events(words: list[Word], max_words: int = 5) -> list[dict]:
    """Raggruppa le parole in blocchi di AL MASSIMO ``max_words`` parole.

    Non riempie sempre il blocco: spezza prima su punteggiatura forte, oppure
    quando è già a metà e c'è una pausa o una virgola. Così i sottotitoli seguono
    le frasi invece di tagliare a un numero fisso. Ogni blocco porta le parole
    con i loro tempi: l'editor/il render evidenziano quella in pronuncia.
    """
    max_words = max(1, int(max_words))
    valid = [w for w in words if w.end > w.start and w.text.strip()]
    events: list[dict] = []
    cur: list[Word] = []
    half = max(2, (max_words + 1) // 2)
    for i, w in enumerate(valid):
        cur.append(w)
        tok = w.text.rstrip()
        last_char = tok[-1:] if tok else ""
        is_last = i == len(valid) - 1
        gap = (valid[i + 1].start - w.end) if not is_last else 1e9
        hard = last_char in _END_PUNCT
        soft = last_char in _SOFT_PUNCT or gap > _PAUSE_GAP
        if is_last or len(cur) >= max_words or hard or (len(cur) >= half and soft):
            events.append({
                "start": round(cur[0].start, 3),
                "end": round(cur[-1].end, 3),
                "words": [{"t0": round(x.start, 3), "t1": round(x.end, 3),
                           "text": x.text} for x in cur],
            })
            cur = []
    return events


# ----------------------------------------------------------------- embedding

def embed_images(paths: list[str], on_progress=None,
                 cancel: threading.Event | None = None,
                 batch_size: int = 16) -> np.ndarray:
    """Embedding CLIP normalizzati delle immagini, nell'ordine dato.

    Le immagini illeggibili ricevono un vettore nullo (resteranno "fuori tema").
    """
    model = _get_clip_image()
    out: list[np.ndarray] = []
    total = len(paths)
    for i in range(0, total, batch_size):
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Analisi immagini annullata.")
        chunk = paths[i:i + batch_size]
        try:
            vecs = list(model.embed(chunk, batch_size=len(chunk)))
        except Exception:
            vecs = _embed_images_one_by_one(model, chunk)
        out.extend(np.asarray(v, dtype=np.float32) for v in vecs)
        if on_progress and total:
            on_progress(min(len(out) / total, 1.0))
    return _normalize(np.vstack(out)) if out else np.zeros((0, DEFAULT_EMB_DIM), np.float32)


def _embed_images_one_by_one(model, paths: list[str]) -> list[np.ndarray]:
    dim = DEFAULT_EMB_DIM
    result = []
    for p in paths:
        try:
            v = next(iter(model.embed([p], batch_size=1)))
            result.append(np.asarray(v, dtype=np.float32))
            dim = result[-1].shape[-1]
        except Exception:
            result.append(np.zeros(dim, np.float32))
    return result


def embed_texts(texts: list[str], dim: int | None = None) -> np.ndarray:
    """Embedding CLIP normalizzati dei testi (le stringhe vuote → vettore nullo).

    ``dim`` (di solito quello degli embedding immagine) garantisce che gli array
    abbiano la stessa larghezza anche quando tutti i testi sono vuoti."""
    model = _get_clip_text()
    idx = [i for i, t in enumerate(texts) if t.strip()]
    out = np.zeros((len(texts), dim or DEFAULT_EMB_DIM), np.float32)
    if not idx:
        return out
    vecs = list(model.embed([texts[i] for i in idx]))
    real_dim = np.asarray(vecs[0]).shape[-1]
    if real_dim != out.shape[1]:
        out = np.zeros((len(texts), real_dim), np.float32)
    for k, i in enumerate(idx):
        out[i] = np.asarray(vecs[k], dtype=np.float32)
    return _normalize(out)


# ----------------------------------------------------------------- deduplica

def dedup(image_embeddings: np.ndarray,
          threshold: float = DEDUP_SIMILARITY) -> tuple[list[int], dict[int, int]]:
    """Tiene la prima immagine di ogni gruppo di quasi-duplicati.

    Restituisce (indici_tenuti_in_ordine, {indice_scartato: indice_tenuto})."""
    n = len(image_embeddings)
    kept: list[int] = []
    dup_of: dict[int, int] = {}
    if n == 0:
        return kept, dup_of
    kept_mat = np.zeros((0, image_embeddings.shape[1]), np.float32)
    for i in range(n):
        vec = image_embeddings[i]
        if kept and np.linalg.norm(vec) > 1e-6:
            sims = kept_mat @ vec
            j = int(np.argmax(sims))
            if sims[j] >= threshold:
                dup_of[i] = kept[j]
                continue
        kept.append(i)
        kept_mat = np.vstack([kept_mat, vec])
    return kept, dup_of


# ----------------------------------------------------------------- abbinamento

@dataclass
class Assignment:
    window_image: list[int]      # per ogni finestra, indice immagine (nel set tenuto)
    used: list[int]              # indici immagine effettivamente mostrati (ordinati)
    offtopic: list[int]          # indici immagine mai abbastanza pertinenti
    unused: list[int]            # indici immagine non usati ma pertinenti


def align(image_embeddings: np.ndarray, window_embeddings: np.ndarray,
          offtopic_threshold: float = OFFTOPIC_SIMILARITY) -> Assignment:
    """Assegna a ogni finestra (in ordine) un'immagine, con vincolo di
    monotonìa sull'indice immagine (l'ordine d'ingresso è preservato).

    DP: dp[i] = miglior punteggio se questa finestra usa l'immagine i, con le
    finestre precedenti che usano immagini ≤ i. Le immagini "fuori tema" (poco
    pertinenti ovunque) vengono naturalmente saltate quando esiste di meglio.
    """
    k = len(image_embeddings)        # immagini (dopo dedup)
    m = len(window_embeddings)       # finestre
    if k == 0 or m == 0:
        return Assignment([0] * m if k else [], [], [], list(range(k)))

    sims = image_embeddings @ window_embeddings.T      # (k, m), coseno
    NEG = -1e9
    dp = sims[:, 0].astype(np.float64).copy()
    back = np.full((m, k), -1, dtype=np.int64)
    for j in range(1, m):
        # prefix_max[i] = max(dp[0..i]) con relativo argmax: garantisce monotonìa.
        run_max, run_arg = NEG, -1
        prefix_arg = np.empty(k, dtype=np.int64)
        for i in range(k):
            if dp[i] > run_max:
                run_max, run_arg = dp[i], i
            prefix_arg[i] = run_arg
        back[j] = prefix_arg
        new_dp = sims[:, j].astype(np.float64) + dp[np.maximum(prefix_arg, 0)]
        # quando prefix_arg==-1 (impossibile) non capita: i parte da 0
        dp = new_dp

    # Backtrack dall'ultima finestra.
    window_image = [0] * m
    i = int(np.argmax(dp))
    for j in range(m - 1, -1, -1):
        window_image[j] = i
        i = int(back[j][i]) if j > 0 else i
        if i < 0:
            i = window_image[j]

    # Finestre senza testo (silenzio): tengono l'immagine precedente.
    for j in range(m):
        if not window_embeddings[j].any():
            window_image[j] = window_image[j - 1] if j > 0 else window_image[j]

    used = sorted(set(window_image))
    best_per_image = sims.max(axis=1)
    offtopic = [i for i in range(k) if i not in used and best_per_image[i] < offtopic_threshold]
    unused = [i for i in range(k) if i not in used and i not in offtopic]
    return Assignment(window_image, used, offtopic, unused)
