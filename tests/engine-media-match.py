"""Original-path and video-source mapping regressions without model downloads."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from ducky import media_match


class MediaMatchTests(unittest.TestCase):
    def test_photo_and_three_video_samples_map_back_to_original_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            photo, video = str(Path(directory) / "foto.png"), str(Path(directory) / "film.mp4")
            Path(photo).touch()
            Path(video).touch()

            def fake_ffmpeg(args, **_):
                Path(args[-1]).touch()

            def match(samples, words, duration, **kwargs):
                self.assertEqual(len(samples), 4)
                return {"segments": [
                    {"source": samples[0], "start": 0, "end": 2},
                    {"source": samples[-1], "start": 2, "end": 5},
                ], "media": [{"path": source, "status": "used" if index in (0, 3) else "dup"} for index, source in enumerate(samples)]}

            with patch.object(media_match, "probe", return_value=SimpleNamespace(duration=10)), patch.object(media_match, "run_ffmpeg", side_effect=fake_ffmpeg), patch.object(media_match.videomake, "rematch", side_effect=match):
                result = media_match.rematch_media([photo, video], [], 5)
            self.assertEqual([item["source"] for item in result["segments"]], [photo, video])
            self.assertEqual(result["segments"][1]["sourceIn"], 7)
            self.assertEqual(result["segments"][1]["sourceDuration"], 10)
            self.assertEqual(result["media"], [{"path": photo, "type": "image", "status": "used"}, {"path": video, "type": "video", "status": "used"}])
            self.assertFalse(any("duckymovie-match-" in item["source"] for item in result["segments"]))

    def test_short_video_reports_finite_capacity_for_long_narration_window(self):
        with tempfile.TemporaryDirectory() as directory:
            video = str(Path(directory) / "breve.mp4")
            Path(video).touch()
            def match(samples, *_args, **_kwargs):
                self.assertEqual(len(samples), 1)
                return {"segments": [{"source": samples[0], "start": 0, "end": 8}], "media": []}
            with patch.object(media_match, "probe", return_value=SimpleNamespace(duration=1)), patch.object(media_match, "run_ffmpeg", side_effect=lambda args, **_: Path(args[-1]).touch()), patch.object(media_match.videomake, "rematch", side_effect=match):
                result = media_match.rematch_media([video], [], 8)
            self.assertEqual(result["segments"][0]["sourceIn"], 0)
            self.assertEqual(result["segments"][0]["sourceDuration"], 1)

    def test_extended_image_format_is_converted_and_never_probed_as_video(self):
        with tempfile.TemporaryDirectory() as directory:
            photo = str(Path(directory) / "foto.tiff")
            Path(photo).touch()
            def match(samples, *_args, **_kwargs):
                self.assertTrue(samples[0].endswith(".jpg"))
                return {"segments": [{"source": samples[0], "start": 0, "end": 2}], "media": [{"path": samples[0], "status": "used"}]}
            with patch.object(media_match, "probe") as probe, patch.object(media_match, "run_ffmpeg", side_effect=lambda args, **_: Path(args[-1]).touch()), patch.object(media_match.videomake, "rematch", side_effect=match):
                result = media_match.rematch_media([photo], [], 2)
            probe.assert_not_called()
            self.assertEqual(result["segments"][0]["source"], photo)
            self.assertEqual(result["media"][0]["type"], "image")


if __name__ == "__main__":
    unittest.main()
