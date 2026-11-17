"""DuckyMovie standalone engine. Request JSON in a file, newline JSON on stdout."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import sys
import threading
import traceback

sys.dont_write_bytecode = True
output = sys.stdout
if hasattr(output, "reconfigure"):
    output.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def emit(data):
    output.write(json.dumps(data, ensure_ascii=False, allow_nan=False) + "\n")
    output.flush()


def progress(value, message="Elaborazione in corso", **metadata):
    emit({"type": "progress", "progress": max(0, min(1, float(value))), "message": message, **metadata})


progress.encoding_metadata = True


def dispatch(action, payload):
    from ducky import highlights, semantic, shorts, videomake
    cancel = threading.Event()
    if action == "highlights":
        diagnostics = {}
        candidates = highlights.analyze_and_propose(
            payload["path"], count=int(payload.get("count", 4)),
            target_duration=float(payload.get("duration", 40)), on_progress=progress, cancel=cancel,
            diagnostics=diagnostics)
        return {"candidates": [candidate.to_dict() for candidate in candidates], "analysis": diagnostics}
    if action == "transcribe":
        paths = list(dict.fromkeys(payload["paths"]))
        language = payload.get("language", "it")
        if language == "auto": language = None
        words_by_path = {}
        for index, path in enumerate(paths):
            transcript = semantic.transcribe(path, language=language,
                on_progress=lambda value: progress((index+value)/len(paths), "Trascrizione audio"), cancel=cancel)
            words_by_path[path] = [{"start": word.start, "end": word.end, "text": word.text} for word in transcript.words]
        return {"words_by_path": words_by_path}
    if action == "match":
        from ducky.media_match import rematch_media
        words = payload.get("words") or []
        script = payload.get("script", "")
        if script and not words:
            sentences = semantic.split_sentences(script)
            total = float(payload["audio_duration"])
            words = [{"start": i * total / len(sentences), "end": (i + 1) * total / len(sentences), "text": text} for i, text in enumerate(sentences)]
        return rematch_media(payload["images"], words, float(payload["audio_duration"]),
            dedup=bool(payload.get("dedup", True)), offtopic=payload.get("offtopic"),
            img_min=payload.get("img_min"), img_max=payload.get("img_max"), on_progress=progress, cancel=cancel,
            script_text=script)
    if action == "short-base":
        destination = Path(payload["outputDir"])
        destination.mkdir(parents=True, exist_ok=True)
        diagnostics = {}
        file = shorts.render_short(payload["path"], float(payload["start"]), float(payload["end"]),
            style=payload.get("style", "blur"), original=payload.get("original"),
            dest_dir=str(destination), on_progress=progress, cancel=cancel,
            tracking=payload.get("tracking"), diagnostics=diagnostics)
        return {"path": str(file), "tracking": diagnostics}
    if action == "read-script":
        file = Path(payload["path"])
        text = semantic.read_docx(str(file)) if file.suffix.lower() == ".docx" else file.read_text(encoding="utf-8-sig")
        return {"text": text, "path": str(file)}
    if action == "render":
        from renderer import render_project
        return render_project(payload["project"], payload["settings"], payload["output"], progress, cancel, payload.get("encoding"))
    if action == "health":
        from ducky.config import FFMPEG_EXE, MODELS_DIR
        return {"ready": True, "ffmpeg": FFMPEG_EXE, "models": str(MODELS_DIR)}
    raise ValueError("Operazione sconosciuta.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    request_path = parser.parse_args().request
    try:
        request = json.loads(Path(request_path).read_text(encoding="utf-8-sig"))
        with contextlib.redirect_stdout(sys.stderr):
            result = dispatch(request["action"], request.get("payload") or {})
        emit({"type": "result", "result": result})
    except BaseException as error:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "error": str(error) or type(error).__name__})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
