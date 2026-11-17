"""Pipeline regressions for scene reuse, GPU fallback and exported frame parity."""
import copy
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
os.environ.setdefault("DUCKY_FFMPEG_PATH", str(ROOT / "node_modules/ffmpeg-static/ffmpeg.exe"))
import renderer
from ducky.encoding import cpu_encoding
from gpu_compositor import GpuUnavailable, ImageCompositor


class CompositionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ducky-composition-")
        self.folder = Path(self.temporary.name)
        self.assets = []
        for index, color in enumerate(((220, 30, 40), (20, 60, 230))):
            pixels = np.full((180, 320, 3), color, dtype=np.uint8)
            pixels[:40, :50] = (20, 220, 50)
            photo = self.folder / f"photo-{index}.png"
            Image.fromarray(pixels).save(photo)
            self.assets.append({"id": f"asset-{index}", "kind": "image", "name": "Fixture",
                                "path": str(photo), "hasAudio": False})
        self.project = {"aspectRatio": "16:9", "assets": self.assets, "audioTracks": [],
                        "clips": [self.clip("first", "asset-0", 0, 1)]}

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def clip(identity, asset, start, duration, **changes):
        return {"id": identity, "assetId": asset, "start": start, "in": 0, "out": duration,
                "speed": 1, "fit": "contain", "volume": 1, "muted": True,
                "filter": "none", "brightness": 0, "contrast": 1, "saturation": 1,
                "fadeIn": 0, "fadeOut": 0, **changes}

    def render(self, project=None, dimensions=(320, 180), settings=None, suffix="video"):
        project = project or self.project
        settings = {"resolution": "720p", "fps": 24, "quality": "standard", "acceleration": "auto", **(settings or {})}
        positions, duration = renderer._positions(project)
        output = self.folder / f"{suffix}.mp4"
        events = []
        with mock.patch.object(renderer, "_dimensions", return_value=dimensions), \
             mock.patch.object(renderer, "choose_encoding", return_value=cpu_encoding()):
            choice = renderer._render_video(project, settings, {asset["id"]: asset for asset in project["assets"]},
                positions, duration, output, self.folder, lambda *event: events.append(event), threading.Event())
        frames = []
        cap = cv2.VideoCapture(str(output))
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(frame)
        cap.release()
        return choice, frames, events

    def test_static_scene_is_composited_once_and_recomputed_for_a_gap(self):
        project = copy.deepcopy(self.project)
        project["duration"] = 1.5
        with mock.patch.object(renderer, "_compose_layers", wraps=renderer._compose_layers) as compose:
            choice, frames, _ = self.render(project, settings={"acceleration": "cpu"})
        self.assertEqual(compose.call_count, 2)
        self.assertEqual(choice.composition, "cpu")
        self.assertEqual(len(frames), 36)
        self.assertLess(float(frames[-1].mean()), 2)
        self.assertGreater(float(frames[12].mean()), 30)

    def test_native_cpu_blend_matches_reference_with_transparency(self):
        rng = np.random.default_rng(712)
        layers = [(rng.integers(0, 256, (60, 80, 3), dtype=np.uint8), rng.random((60, 80), dtype=np.float32)) for _ in range(3)]
        expected = np.zeros((60, 80, 3), dtype=np.uint8)
        for pixels, alpha in layers:
            expected = (pixels.astype(np.float32) * alpha[:, :, None]
                        + expected.astype(np.float32) * (1 - alpha[:, :, None])).astype(np.uint8)
        actual = renderer._compose_layers(layers, 80, 60)
        delta = np.abs(actual.astype(np.int16) - expected.astype(np.int16))
        self.assertLessEqual(int(delta.max()), 3)
        self.assertLessEqual(float(delta.mean()), 1)

    def test_unavailable_gpu_falls_back_to_cpu_without_losing_frames(self):
        with mock.patch("gpu_compositor.ImageCompositor", side_effect=GpuUnavailable("No device")) as constructor:
            choice, frames, _ = self.render()
        self.assertEqual(constructor.call_count, 1)
        self.assertEqual(choice.composition, "cpu")
        self.assertEqual(len(frames), 24)
        self.assertGreater(int(frames[-1][90, 160, 2]), 200)

    def test_driver_failure_mid_render_restarts_whole_video_on_cpu(self):
        fake = mock.Mock()
        fake.label = "Injected test device"
        fake.render.side_effect = [bytes(320 * 180 * 3), RuntimeError("Graphics device lost")]
        with mock.patch("gpu_compositor.ImageCompositor", return_value=fake) as constructor:
            choice, frames, _ = self.render()
        self.assertEqual(constructor.call_count, 1)
        fake.close.assert_called_once()
        self.assertEqual(choice.composition, "cpu")
        self.assertEqual(len(frames), 24)
        self.assertGreater(int(frames[0][90, 160, 2]), 200)
        self.assertGreater(int(frames[-1][90, 160, 2]), 200)

    def test_cancelled_gpu_failure_is_not_retried_on_cpu(self):
        cancel = threading.Event()
        fake = mock.Mock()
        fake.label = "Injected test device"
        def lose_device(layers):
            cancel.set()
            raise RuntimeError("Device lost after cancellation")
        fake.render.side_effect = lose_device
        positions, duration = renderer._positions(self.project)
        with mock.patch("gpu_compositor.ImageCompositor", return_value=fake) as constructor, \
             mock.patch.object(renderer, "_dimensions", return_value=(320, 180)), \
             mock.patch.object(renderer, "choose_encoding", return_value=cpu_encoding()), \
             mock.patch.object(renderer, "_compose_layers", side_effect=AssertionError("CPU retry after cancel")):
            with self.assertRaises(InterruptedError):
                renderer._render_video(self.project, {"resolution": "720p", "fps": 24},
                    {asset["id"]: asset for asset in self.assets}, positions, duration,
                    self.folder / "cancelled.mp4", self.folder, lambda *event: None, cancel)
        constructor.assert_called_once()
        fake.close.assert_called_once()

    def test_encoder_start_failure_releases_the_graphics_context(self):
        fake = mock.Mock()
        fake.label = "Injected test device"
        positions, duration = renderer._positions(self.project)
        with mock.patch("gpu_compositor.ImageCompositor", return_value=fake), \
             mock.patch.object(renderer, "_dimensions", return_value=(320, 180)), \
             mock.patch.object(renderer.subprocess, "Popen", side_effect=OSError("Cannot start encoder")):
            with self.assertRaises(OSError):
                renderer._render_video_once(self.project, {"resolution": "720p", "fps": 24},
                    {asset["id"]: asset for asset in self.assets}, positions, duration,
                    self.folder / "unstarted.mp4", self.folder, lambda *event: None,
                    threading.Event(), cpu_encoding())
        fake.close.assert_called_once()

    def test_driver_failure_during_texture_eviction_retries_on_cpu(self):
        fake = mock.Mock()
        fake.label = "Injected test device"
        fake.render.return_value = bytes(320 * 180 * 3)
        fake.release_unused.side_effect = RuntimeError("Device lost during release")
        with mock.patch("gpu_compositor.ImageCompositor", return_value=fake):
            choice, frames, _ = self.render()
        fake.close.assert_called_once()
        self.assertEqual(choice.composition, "cpu")
        self.assertEqual(len(frames), 24)
        self.assertGreater(int(frames[0][90, 160, 2]), 200)

    def test_real_gpu_pipeline_matches_cpu_at_720p_with_gap_and_crossfade(self):
        try:
            check = ImageCompositor(32, 32)
            check.close()
        except GpuUnavailable as error:
            self.skipTest(str(error))
        project = copy.deepcopy(self.project)
        project["duration"] = 1.5
        project["clips"] = [self.clip("first", "asset-0", .125, .5, zoom="in", zoomAmount=1.05),
                            self.clip("second", "asset-1", .625, .5, zoom="out", zoomAmount=1.1,
                                      transition="fade", transitionDuration=.2)]
        cpu, reference, _ = self.render(project, (1280, 720), {"acceleration": "cpu"}, "cpu")
        gpu, actual, _ = self.render(project, (1280, 720), suffix="gpu")
        self.assertEqual(cpu.composition, "cpu")
        self.assertEqual(gpu.composition, "gpu")
        self.assertEqual(len(actual), len(reference))
        self.assertEqual(len(actual), 36)
        self.assertEqual(actual[0].shape, (720, 1280, 3))
        for index in (0, 3, 10, 12, 14, 15, 20, 26, 35):
            delta = np.abs(actual[index].astype(np.int16) - reference[index].astype(np.int16))
            self.assertLess(float(delta.mean()), 1.5, f"frame {index}")
        # RGB source marker must stay in the top-left of the BGR exported frame.
        self.assertGreater(int(actual[3][40, 40, 1]), 190)
        self.assertLess(float(actual[0].mean()), 2)
        self.assertLess(float(actual[-1].mean()), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
