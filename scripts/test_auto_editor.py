#!/usr/bin/env python3
"""Unit & integration tests for the automated talking-head AI video editor scripts."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import build_cut  # noqa: E402
import choose_cuts  # noqa: E402


class ChooseCutsTests(unittest.TestCase):
    def test_offline_strips_fillers_dead_air_and_false_starts(self) -> None:
        words = [
            {"word": "So", "start": 1.00, "end": 1.20},
            {"word": "today", "start": 1.22, "end": 1.50},
            # False start pause (> 0.20s) followed by clean retake with matching prefix
            {"word": "So", "start": 2.40, "end": 2.60},
            {"word": "today", "start": 2.62, "end": 2.95},
            {"word": "we", "start": 2.98, "end": 3.10},
            {"word": "build", "start": 3.12, "end": 3.45},
            {"word": "um", "start": 3.55, "end": 3.85},
            {"word": "fast.", "start": 3.95, "end": 4.30},
            # Dead air gap > 0.55s
            {"word": "Let's", "start": 6.10, "end": 6.40},
            {"word": "go!", "start": 6.42, "end": 6.75},
        ]
        spans = choose_cuts.choose_spans_offline(words, silence_threshold=0.55)
        segs = choose_cuts.build_padded_segments(words, spans, total_duration=8.0)

        # False start ("So today") and filler ("um") removed; 3 kept pieces (or 2 if tight)
        all_text = " ".join(s["text"] for s in segs)
        self.assertNotIn("um", all_text.lower().split())
        self.assertTrue(all_text.startswith("So today we build"))
        self.assertIn("Let's go!", all_text)

        # Strictly monotonic and non-overlapping
        for i in range(1, len(segs)):
            self.assertLessEqual(segs[i - 1]["end"], segs[i]["start"])
        for seg in segs:
            self.assertLess(seg["start"], seg["end"])
            self.assertGreaterEqual(seg["start"], 0.0)
            self.assertLessEqual(seg["end"], 8.0)

    def test_padding_clamps_to_cut_words_and_splits_close_gaps(self) -> None:
        words = [
            {"word": "Keep1", "start": 1.00, "end": 1.50},
            {"word": "um", "start": 1.55, "end": 1.65},
            {"word": "Keep2", "start": 1.70, "end": 2.20},
        ]
        # Keep indices 0 and 2, cutting index 1 ("um")
        segs = choose_cuts.build_padded_segments(
            words, [(0, 0), (2, 2)], total_duration=4.0, pre_pad=0.08, post_pad=0.12
        )
        self.assertEqual(len(segs), 2)
        # Segment 0 end must not enter cut word "um" (starts at 1.55)
        self.assertLess(segs[0]["end"], 1.55)
        # Segment 1 start must not enter cut word "um" (ends at 1.65)
        self.assertGreater(segs[1]["start"], 1.65)
        self.assertLessEqual(segs[0]["end"], segs[1]["start"])

    def test_close_adjacent_kept_spans_split_midpoint_no_overlap(self) -> None:
        words = [
            {"word": "One", "start": 1.00, "end": 1.50},
            {"word": "Two", "start": 1.80, "end": 2.30},
        ]
        # Force separate spans with gap 0.30s (>= 0.25 merge gap) and large pads (0.20 + 0.20 > 0.30)
        segs = choose_cuts.build_padded_segments(
            words, [(0, 0), (1, 1)], total_duration=5.0, pre_pad=0.20, post_pad=0.20
        )
        self.assertEqual(len(segs), 2)
        self.assertLessEqual(segs[0]["end"], segs[1]["start"])
        self.assertAlmostEqual(segs[0]["end"], 1.65, places=2)
        self.assertAlmostEqual(segs[1]["start"], 1.65, places=2)


class BuildCutIntegrationTests(unittest.TestCase):
    def test_render_mp4_frame_accurate_vertical_video(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            raw_mp4 = tmp_dir / "sample_vertical.mp4"
            cuts_json = tmp_dir / "cuts.json"
            out_mp4 = tmp_dir / "cut.mp4"

            # Generate a 4-second 30fps vertical (360x640) synthetic video with audio
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=4:size=360x640:rate=30",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=4:sample_rate=48000",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    str(raw_mp4),
                ],
                check=True,
                capture_output=True,
            )

            cuts_json.write_text(
                json.dumps(
                    {
                        "segments": [
                            {"start": 0.5, "end": 1.5, "text": "Part one"},
                            {"start": 2.5, "end": 3.5, "text": "Part two"},
                        ]
                    }
                ),
                encoding="utf-8",
            )

            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "build_cut.py"),
                    "render-mp4",
                    str(raw_mp4),
                    "--cuts",
                    str(cuts_json),
                    "--out",
                    str(out_mp4),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertTrue(out_mp4.is_file())

            # Extract JSON verification report printed by render-mp4
            json_start = proc.stdout.index("{")
            report = json.loads(proc.stdout[json_start:])
            self.assertEqual(report["clip_count"], 2)
            self.assertEqual(report["expected_frames"], 60)
            self.assertEqual(report["actual_frames"], 60)
            self.assertEqual(report["frame_diff"], 0)
            self.assertEqual(report["actual_dimensions"], "360x640 (vertical)")


if __name__ == "__main__":
    unittest.main()
