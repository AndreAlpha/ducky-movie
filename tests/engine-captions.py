"""Regression for word highlight gaps and explicit caption line wrapping."""
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from ducky.videomake import _write_ass
from renderer import _caption_events

explicit = [
    {"start": 0, "end": .2, "text": "Una.", "segmentId": "first"},
    {"start": .3, "end": .6, "text": "frase", "segmentId": "first"},
    {"start": .7, "end": 1, "text": "divisa", "segmentId": "second"},
]
grouped = _caption_events(explicit, 1)
assert [[word["text"] for word in event["words"]] for event in grouped] == [["Una.", "frase"], ["divisa"]]
linked = [{**word, "text": word["text"].rstrip("."), "segmentId": None, "source": {"kind": "audio", "id": f"audio-{index // 2}"}} for index, word in enumerate(explicit)]
assert len(_caption_events(linked, 10)) == 2
mixed = [{**explicit[0], "segmentId": "same"}, {**explicit[1], "segmentId": "same", "source": {"kind": "clip", "id": "video"}}]
assert len(_caption_events(mixed, 10)) == 1

with tempfile.TemporaryDirectory(prefix="ducky-captions-") as directory:
    output = Path(directory) / "captions.ass"
    events = [{"start": 0, "end": 1, "words": [
        {"t0": 0, "t1": .25, "text": "Ciao"},
        {"t0": .75, "t1": 1, "text": "DuckyMovie"}], "rows": [(0, 1), (1, 2)]}]
    _write_ass(events, {}, 1280, 720, 1, output)
    lines = [line for line in output.read_text(encoding="utf-8").splitlines() if line.startswith("Dialogue:")]
    assert len(lines) == 3
    gap = next(line for line in lines if ",0:00:00.25,0:00:00.75," in line)
    assert "\\1c" not in gap
    assert "Ciao\\NDuckyMovie" in gap
    assert all("\\1c" in line for line in lines if line != gap)
    print("Caption word gaps, explicit groups, source boundaries and rows passed")
