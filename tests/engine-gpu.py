"""Real offscreen GPU sampling/composition parity against OpenCV reference frames."""
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
os.environ.setdefault("DUCKY_FFMPEG_PATH", str(ROOT / "node_modules/ffmpeg-static/ffmpeg.exe"))
from gpu_compositor import GpuUnavailable, ImageCompositor, unsupported_reason
from renderer import _blend_layers


class EligibilityTests(unittest.TestCase):
    def test_supported_image_and_explicit_fallbacks(self):
        project = {"assets": [{"id": "a", "kind": "image"}], "clips": [{"assetId": "a", "zoom": "in"}]}
        self.assertIsNone(unsupported_reason(project, {}))
        for change in ({"filter": "warm"}, {"brightness": .1}, {"mirror": True},
                       {"title": {"text": "Text"}}, {"placement": {"scale": .5}},
                       {"transition": "blur"}):
            altered = {**project, "clips": [{**project["clips"][0], **change}]}
            self.assertIsNotNone(unsupported_reason(altered, {}), change)
        for settings in ({"acceleration": "cpu"}, {"framePng": "frame"}):
            self.assertIsNotNone(unsupported_reason(project, settings))
        self.assertIsNotNone(unsupported_reason({**project, "overlays": [{}]}, {}))
        self.assertIsNotNone(unsupported_reason({**project, "assets": [{"id": "a", "kind": "video"}]}, {}))


class CleanupTests(unittest.TestCase):
    def test_failed_initialization_remains_unavailable_when_cleanup_fails(self):
        import moderngl
        context = mock.Mock()
        context.info = {"GL_RENDERER": "Injected hardware device"}
        context.program.side_effect = moderngl.Error("Shader device lost")
        context.release.side_effect = moderngl.Error("Release device lost")
        with mock.patch("moderngl.create_standalone_context", return_value=context):
            with self.assertRaisesRegex(GpuUnavailable, "Shader device lost"):
                ImageCompositor(16, 16)
        context.release.assert_called_once()

    def test_close_attempts_every_resource_and_is_idempotent_after_errors(self):
        compositor = ImageCompositor.__new__(ImageCompositor)
        objects = [mock.Mock() for _ in range(8)]
        compositor.textures = {"first": tuple(objects[:2]), "second": tuple(objects[2:4])}
        compositor._resources = objects[4:7]
        compositor.context = objects[7]
        for index in (0, 2, 6, 7):
            objects[index].release.side_effect = RuntimeError("Device already lost")
        compositor.close()
        self.assertEqual(compositor.textures, {})
        self.assertEqual(compositor._resources, [])
        self.assertIsNone(compositor.context)
        compositor.close()
        for resource in objects:
            resource.release.assert_called_once()

    def test_eviction_releases_both_textures_before_reporting_driver_failure(self):
        compositor = ImageCompositor.__new__(ImageCompositor)
        pixels, mask = mock.Mock(), mock.Mock()
        compositor.textures = {"source": (pixels, mask)}
        pixels.release.side_effect = RuntimeError("Eviction device lost")
        with self.assertRaisesRegex(RuntimeError, "Eviction device lost"):
            compositor.release_unused(set())
        pixels.release.assert_called_once()
        mask.release.assert_called_once()
        self.assertFalse(compositor.textures)


class HardwareParityTests(unittest.TestCase):
    def setUp(self):
        self.w, self.h = 320, 180
        try:
            self.gpu = ImageCompositor(self.w, self.h)
        except GpuUnavailable as error:
            self.skipTest(str(error))
        y, x = np.mgrid[:self.h, :self.w]
        self.first = np.stack([x % 256, y % 256, (x + y) % 256], axis=2).astype(np.uint8)
        self.second = self.first[:, ::-1].copy()
        self.alpha = np.zeros((self.h, self.w), dtype=np.float32)
        self.alpha[10:-10, 22:-22] = np.linspace(.1, 1, self.w - 44)[None, :]
        self.opaque = np.ones((self.h, self.w), dtype=np.float32)
        self.gpu.add("first", self.first, self.alpha)
        self.gpu.add("second", self.second, self.opaque)

    def tearDown(self):
        if hasattr(self, "gpu"):
            self.gpu.close()

    def read(self, layers):
        return np.frombuffer(self.gpu.render(layers), dtype=np.uint8).reshape(self.h, self.w, 3)

    def source(self, key, scale=1, opacity=1):
        pixels, alpha = (self.first, self.alpha) if key == "first" else (self.second, self.opaque)
        if scale != 1:
            transform = cv2.getRotationMatrix2D((self.w / 2, self.h / 2), 0, scale)
            pixels = cv2.warpAffine(pixels, transform, (self.w, self.h), flags=cv2.INTER_LINEAR)
            alpha = cv2.warpAffine(alpha, transform, (self.w, self.h), flags=cv2.INTER_LINEAR)
        return pixels, alpha * opacity

    def assertPixels(self, actual, expected, mean=1.1, maximum=9):
        difference = np.abs(actual.astype(np.int16) - expected.astype(np.int16))
        self.assertLessEqual(float(difference.mean()), mean)
        self.assertLessEqual(int(difference.max()), maximum)

    def test_opaque_still_has_exact_colors_orientation_and_empty_frame(self):
        self.assertTrue(np.array_equal(self.read([{"key": "second"}]), self.second))
        self.assertTrue(np.all(self.read([]) == 0))

    def test_zoom_fade_and_transparent_image_borders(self):
        for key in ("first", "second"):
            for scale in (1, 1.015, 1.05, 1.12, 1.3):
                for opacity in (.2, .5, 1):
                    with self.subTest(key=key, scale=scale, opacity=opacity):
                        pixels, alpha = self.source(key, scale, opacity)
                        expected = (pixels.astype(np.float32) * alpha[:, :, None]).astype(np.uint8)
                        self.assertPixels(self.read([{"key": key, "scale": scale, "opacity": opacity}]), expected)

    def test_crossfades_and_black_white_transitions_preserve_alpha(self):
        background = {"key": "second", "opacity": .3}
        bg_pixels, bg_alpha = self.source("second", opacity=.3)
        bg = (bg_pixels * bg_alpha[:, :, None]).astype(np.uint8)
        current = self.source("first", 1.05, .7)
        incoming = self.source("second", 1.12, .8)
        for transition in ("fade", "black", "white"):
            for beta in (0, .13, .5, .85, 1):
                with self.subTest(transition=transition, beta=beta):
                    pixels, alpha = _blend_layers(transition, current, incoming, beta)
                    expected = (pixels.astype(np.float32) * alpha[:, :, None]
                                + bg.astype(np.float32) * (1 - alpha[:, :, None])).astype(np.uint8)
                    actual = self.read([background, {"key": "first", "scale": 1.05, "opacity": .7,
                        "incoming": {"key": "second", "scale": 1.12, "opacity": .8},
                        "transition": transition, "beta": beta}])
                    self.assertPixels(actual, expected, mean=1.4, maximum=10)

    def test_textures_are_released_when_the_source_leaves_the_timeline(self):
        self.assertEqual(len(self.gpu.textures), 2)
        self.gpu.release_unused({"second"})
        self.assertEqual(set(self.gpu.textures), {"second"})
        self.assertTrue(np.array_equal(self.read([{"key": "second"}]), self.second))
        self.gpu.release_unused(set())
        self.assertFalse(self.gpu.textures)


if __name__ == "__main__":
    unittest.main(verbosity=2)
