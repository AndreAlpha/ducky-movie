"""Utility condivise: nomi numerati, ordinamento naturale, formati tempo."""

import os
import re
import threading
from pathlib import Path


def sequenced_dir(base_name: str, parent: Path) -> Path:
    """Crea e restituisce la prima cartella libera ``{n} {base_name}`` in parent.

    Esempio: "1 DuckySF", poi "2 DuckySF", ecc. (stessa convenzione storica).

    La creazione è ATOMICA: ``mkdir`` alza ``FileExistsError`` se la cartella esiste
    già, quindi se più operazioni girano in parallelo nessuna ruba il numero a
    un'altra (e nessuna va in crash come faceva il vecchio check-poi-crea).
    """
    parent = Path(parent)
    parent.mkdir(parents=True, exist_ok=True)
    counter = 1
    while True:
        candidate = parent / f"{counter} {base_name}"
        try:
            candidate.mkdir()
            return candidate
        except FileExistsError:
            counter += 1


def sequenced_file(base_name: str, parent: Path, ext: str = ".mp4",
                   reserve: bool = True) -> Path:
    """Primo percorso file libero ``{n} {base_name}{ext}`` in parent.

    Con ``reserve=True`` (default) il nome viene RISERVATO atomicamente creando un
    segnaposto vuoto (``O_CREAT|O_EXCL``). Senza questo, più job che scrivono il file
    solo ALLA FINE (ffmpeg, download) vedono tutti lo stesso primo nome libero e
    scelgono tutti "1 ...", sovrascrivendosi a vicenda: lanciando 5 short in parallelo
    ne resta uno solo. Il segnaposto viene poi sovrascritto da ffmpeg (``-y``); se il
    render fallisce o viene annullato il chiamante DEVE rimuoverlo
    (``out_path.unlink(missing_ok=True)``), altrimenti resta un file vuoto che occupa
    il numero.

    Con ``reserve=False`` restituisce solo il nome candidato senza creare nulla
    (anteprima): non è sicuro contro le collisioni in parallelo.
    """
    parent = Path(parent)
    if reserve:
        parent.mkdir(parents=True, exist_ok=True)
    counter = 1
    while True:
        candidate = parent / f"{counter} {base_name}{ext}"
        if not reserve:
            if not candidate.exists():
                return candidate
            counter += 1
            continue
        try:
            # O_BINARY: no-op su POSIX (vale 0), corretto su Windows per file binari.
            fd = os.open(candidate,
                         os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0),
                         0o644)
            os.close(fd)
            return candidate
        except FileExistsError:
            counter += 1


# Percorsi di output di job ATTUALMENTE in scrittura. Per i flussi dove il nome lo
# sceglie l'utente (dialogo "Salva con nome": download, render Video Make) non si può
# rinumerare il file, ma si deve evitare che DUE job in parallelo scrivano lo stesso
# percorso e si sovrascrivano. Qui si disambigua SOLO contro gli altri job attivi: i
# file già esistenti su disco non si toccano (l'utente può voler sovrascrivere).
_inflight_lock = threading.Lock()
_inflight_paths: set[str] = set()


def reserve_inflight(path: Path) -> Path:
    """Riserva ``path`` per un job in corso; se un ALTRO job attivo sta già scrivendo
    quello stesso percorso, restituisce un nome libero ``nome (n).ext``. Liberare con
    :func:`release_inflight` al termine del job (anche in caso di errore)."""
    path = Path(path)
    with _inflight_lock:
        candidate = path
        n = 1
        while str(candidate) in _inflight_paths:
            candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
            n += 1
        _inflight_paths.add(str(candidate))
    return candidate


def release_inflight(path: Path) -> None:
    """Libera un percorso riservato da :func:`reserve_inflight`."""
    with _inflight_lock:
        _inflight_paths.discard(str(Path(path)))


def natural_key(name: str):
    """Chiave di ordinamento naturale: "frame2" < "frame10"."""
    return [int(part) if part.isdigit() else part.lower()
            for part in re.split(r"(\d+)", name)]


def format_time(seconds: float) -> str:
    """Formatta secondi come m:ss.mmm (stile timeline)."""
    seconds = max(0.0, float(seconds))
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis == 1000:  # arrotondamento al secondo successivo
        millis = 0
        secs += 1
        if secs == 60:
            secs = 0
            minutes += 1
    return f"{minutes}:{secs:02d}.{millis:03d}"
