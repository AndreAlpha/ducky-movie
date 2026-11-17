"""Deterministic tracking/highlight regressions; no network/model download."""
import sys
from pathlib import Path
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from ducky.tracking import Detection, analyze_frames, frame_for_view, TargetAssociation, SAMPLE_FPS
from ducky.highlights import propose_intervals, _inside_speech, _rank


def face(center, width=.09, identity=0):
    histogram = np.zeros((16, 8), np.float32)
    histogram[identity, 5] = 1
    return Detection(center - width / 2, .25, width, .16, 1, "face", histogram)


class TrackingTests(unittest.TestCase):
    def test_association_keeps_selected_subject_when_sizes_swap_and_people_cross(self):
        tracker = TargetAssociation({"focusX": .2, "focusY": .33})
        errors, largest_errors = [], []
        for index in range(64):
            x = .2 + .6 * index / 63
            target = face(x, .075 if index > 10 else .12, 1)
            distractor = face(1 - x, .16 if index > 10 else .08, 9)
            selected, _ = tracker.update([distractor, target], 1 / SAMPLE_FPS, initial=index == 0)
            errors.append(abs(selected.center[0] - x))
            largest_errors.append(abs(max([target, distractor], key=lambda item: item.w).center[0] - x))
        self.assertLess(max(errors), .015)
        self.assertGreater(np.mean(largest_errors), .15)
        print(f"Association MAE {np.mean(errors):.4f}; largest-face baseline {np.mean(largest_errors):.4f}")

    def test_occlusion_predicts_then_holds_without_recentering_or_switching(self):
        tracker = TargetAssociation({"focusX": .2})
        positions = []
        for index in range(42):
            target = face(.2 + .005 * index, identity=1)
            visible = not 14 <= index < 27
            selected, _ = tracker.update(([target] if visible else []) + [face(.82, .16, 9)], 1 / SAMPLE_FPS, initial=index == 0)
            positions.append(selected.center[0])
        self.assertLess(max(positions[14:27]), .4)
        self.assertLess(abs(positions[-1] - .405), .01)

    def test_manual_point_does_not_select_distant_recognized_person(self):
        tracker = TargetAssociation({"focusX": .15, "focusY": .5})
        selected, _ = tracker.update([face(.85)], 1 / SAMPLE_FPS, initial=True)
        self.assertEqual(selected.kind, "manual")
        self.assertLess(abs(selected.center[0] - .15), .01)

    def test_scene_cut_resets_immediately_and_never_interpolates_between_shots(self):
        frames = [np.full((180, 320, 3), (0, 0, 180) if index < 24 else (180, 0, 0), np.uint8) for index in range(48)]
        plan = analyze_frames(frames, 1920, 1080, detector=lambda frame, index: [face(.2 if index < 24 else .8)])
        self.assertEqual(plan.stats["sceneCuts"], 1)
        self.assertLess(plan.at(2.999)[0][0], .3)
        self.assertGreater(plan.at(3)[0][0], .7)

    def test_dead_zone_removes_detection_jitter_but_tracks_fast_motion_within_safe_area(self):
        frames = [np.zeros((180, 320, 3), np.uint8) for _ in range(64)]
        jitter = analyze_frames(frames, 1920, 1080, detector=lambda frame, index: [face(.5 + (.008 if index % 2 else -.008))])
        self.assertLess(np.ptp(jitter.centers[:, 0]), .002)
        truth = np.linspace(.18, .82, 64)
        moving = analyze_frames(frames, 1920, 1080, detector=lambda frame, index: [face(truth[index])])
        self.assertLess(np.max(np.abs(moving.centers[:, 0] - truth)), .4 * moving.widths[0] + .001)
        self.assertTrue(np.all(moving.centers[:, 0] >= moving.widths / 2 - 1e-6))
        self.assertTrue(np.all(moving.centers[:, 0] <= 1 - moving.widths / 2 + 1e-6))

    def test_group_widens_to_keep_separated_people_and_holds_brief_detector_dropouts(self):
        frame = np.zeros((180, 320, 3), np.uint8)
        frame[40:145, 32:64] = (0, 0, 255)
        frame[40:145, 240:272] = (255, 0, 0)
        def detections(image, index):
            return [face(.15)] + ([] if 8 <= index < 12 else [face(.8)])
        plan = analyze_frames([frame] * 24, 320, 180, {"mode": "group"}, detector=detections)
        self.assertGreater(float(plan.widths.min()), .8)
        output = frame_for_view(frame, *plan.at(1.2), 270, 480)
        self.assertEqual(output.shape, (480, 270, 3))
        self.assertGreater(np.count_nonzero((output[:, :, 2] > 200) & (output[:, :, 0] < 30)), 100)
        self.assertGreater(np.count_nonzero((output[:, :, 0] > 200) & (output[:, :, 2] < 30)), 100)

    def test_manual_focus_can_follow_unrecognized_textured_subject_by_optical_flow(self):
        rng = np.random.default_rng(37)
        texture = rng.integers(40, 255, (42, 38, 3), np.uint8)
        frames = []
        for index in range(32):
            frame = np.zeros((180, 320, 3), np.uint8)
            x = 30 + index * 4
            frame[65:107, x:x + 38] = texture
            frames.append(frame)
        plan = analyze_frames(frames, 320, 180, {"focusX": 49 / 320, "focusY": 86 / 180}, detector=lambda frame, index: [])
        self.assertGreater(plan.stats["flowSamples"] + plan.stats["motionSamples"], 20)
        self.assertGreater(plan.centers[-1, 0], .44)


class HighlightTests(unittest.TestCase):
    def test_equal_rank_values_are_equal(self):
        ranks = _rank(np.array([0, 0, 1, 1, 2], np.float32))
        self.assertEqual(ranks[0], ranks[1])
        self.assertEqual(ranks[2], ranks[3])

    def test_speech_edges_stay_in_pauses_and_final_intervals_do_not_overlap(self):
        duration = 150
        speech = [(2 + index * 10, 8 + index * 10) for index in range(15)]
        rms = np.zeros(300, np.float32)
        for start, end in speech:
            rms[int(start * 2):int(end * 2)] = .5
        candidates = propose_intervals(duration, 4, 24, rms, np.ones(300), np.zeros(300), speech)
        self.assertEqual(len(candidates), 4)
        for candidate in candidates:
            self.assertFalse(_inside_speech(candidate.start, speech))
            self.assertFalse(_inside_speech(candidate.end, speech))
            self.assertGreaterEqual(candidate.end - candidate.start, 16.8)
        ordered = sorted(candidates, key=lambda item: item.start)
        for first, second in zip(ordered, ordered[1:]):
            self.assertLessEqual(first.end, second.start)

    def test_flat_material_is_spread_out_and_short_duration_is_bounded(self):
        candidates = propose_intervals(300, 4, 30, np.zeros(600), np.zeros(600), np.zeros(600))
        self.assertEqual(len(candidates), 4)
        centers = [(item.start + item.end) / 2 for item in candidates]
        self.assertGreater(max(centers) - min(centers), 230)
        limited = propose_intervals(181, 2, 180, [], [], [])
        self.assertTrue(all(item.end - item.start <= 180 for item in limited))
        short = propose_intervals(3, 4, 30, [], [], [])
        self.assertEqual((short[0].start, short[0].end), (0, 3))

    def test_different_scene_is_preferred_over_repetitive_visuals_when_activity_ties(self):
        signatures = np.zeros((240, 2), np.float32)
        signatures[:, 0] = 1
        signatures[130:170] = (0, 1)
        candidates = propose_intervals(120, 2, 20, np.ones(240), np.ones(240), np.zeros(240), signatures=signatures)
        self.assertEqual(len(candidates), 2)
        self.assertTrue(any(item.start >= 60 and item.end <= 90 for item in candidates))


if __name__ == "__main__":
    unittest.main()
