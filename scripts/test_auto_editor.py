#!/usr/bin/env python3
"""Unit & integration tests for the Pro AI talking-head video editor pipeline."""

from __future__ import annotations

import array
import json
import math
import subprocess
import sys
import tempfile
import unittest
import wave
from fractions import Fraction
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import build_cut  # noqa: E402
import choose_cuts  # noqa: E402
import generate_broll  # noqa: E402
import generate_captions  # noqa: E402
import ingest_url  # noqa: E402
import plan_broll  # noqa: E402
import polish_audio  # noqa: E402
import refine_cuts  # noqa: E402
import render_motion  # noqa: E402
import setup_connectors  # noqa: E402
import verify_edit  # noqa: E402


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

        all_text = " ".join(s["text"] for s in segs)
        self.assertNotIn("um", all_text.lower().split())
        self.assertTrue(all_text.startswith("So today we build"))
        self.assertIn("Let's go!", all_text)

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
        segs = choose_cuts.build_padded_segments(
            words, [(0, 0), (2, 2)], total_duration=4.0, pre_pad=0.08, post_pad=0.12
        )
        self.assertEqual(len(segs), 2)
        self.assertLess(segs[0]["end"], 1.55)
        self.assertGreater(segs[1]["start"], 1.65)
        self.assertLessEqual(segs[0]["end"], segs[1]["start"])

    def test_close_adjacent_kept_spans_split_midpoint_no_overlap(self) -> None:
        words = [
            {"word": "One", "start": 1.00, "end": 1.50},
            {"word": "Two", "start": 1.80, "end": 2.30},
        ]
        segs = choose_cuts.build_padded_segments(
            words, [(0, 0), (1, 1)], total_duration=5.0, pre_pad=0.20, post_pad=0.20
        )
        self.assertEqual(len(segs), 2)
        self.assertLessEqual(segs[0]["end"], segs[1]["start"])
        self.assertAlmostEqual(segs[0]["end"], 1.65, places=2)
        self.assertAlmostEqual(segs[1]["start"], 1.65, places=2)

    def test_taglish_standalone_hesitation_trimmed_only_when_isolated(self) -> None:
        words = [
            {"word": "Gawa", "start": 0.50, "end": 0.70},
            {"word": "tayo", "start": 0.72, "end": 0.95},
            # Isolated hesitation surrounded by >= 0.22s pauses
            {"word": "ano", "start": 1.40, "end": 1.55},
            # Natural sentence where "ano" is connected to adjacent words
            {"word": "kung", "start": 2.10, "end": 2.25},
            {"word": "ano", "start": 2.27, "end": 2.40},
            {"word": "gusto", "start": 2.42, "end": 2.65},
        ]
        spans = choose_cuts.choose_spans_offline(words, silence_threshold=0.55)
        kept_idx = [i for s, e in spans for i in range(s, e + 1)]
        self.assertNotIn(2, kept_idx)
        self.assertIn(4, kept_idx)


class WaveformRefineTests(unittest.TestCase):
    def test_refine_snaps_boundaries_to_quiet_valleys_without_overlap(self) -> None:
        sr = 16000
        dur = 4.0
        n = int(sr * dur)
        samples = array.array("h", [0] * n)
        # Put loud 440Hz tone in [0.6..1.4] and [2.4..3.2], silence elsewhere
        for i in range(n):
            t = i / sr
            if (0.60 <= t <= 1.40) or (2.40 <= t <= 3.20):
                samples[i] = int(18000 * math.sin(2.0 * math.pi * 440.0 * t))

        # Rough word boundaries intentionally land slightly inside the tone
        raw_segs = [
            {"start": 0.62, "end": 1.38, "text": "First phrase"},
            {"start": 2.42, "end": 3.18, "text": "Second phrase"},
        ]
        refined, stats = refine_cuts.refine_segments(raw_segs, samples, sr, search_ms=120.0)
        self.assertEqual(len(refined), 2)
        self.assertEqual(stats["segments_refined"], 2)
        # Boundaries should move outward into the silent valley (< 0.60 and > 1.40)
        self.assertLess(refined[0]["start"], 0.60)
        self.assertGreater(refined[0]["end"], 1.40)
        self.assertLess(refined[1]["start"], 2.40)
        self.assertGreater(refined[1]["end"], 3.20)
        self.assertLess(refined[0]["qa"]["start_db"], -40.0)
        self.assertLess(refined[0]["qa"]["end_db"], -40.0)


class CaptionsAndIngestTests(unittest.TestCase):
    def test_remap_words_and_generate_srt_ass_overlays(self) -> None:
        words = [
            {"word": "Hello", "start": 0.55, "end": 0.85},
            {"word": "world", "start": 0.90, "end": 1.25},
            {"word": "cutme", "start": 1.80, "end": 2.00},
            {"word": "Ship", "start": 2.60, "end": 2.90},
            {"word": "fast!", "start": 2.95, "end": 3.30},
        ]
        snapped = build_cut.snap_segments(
            [
                {"start": 0.50, "end": 1.50, "text": "Hello world"},
                {"start": 2.50, "end": 3.50, "text": "Ship fast!"},
            ],
            Fraction(30, 1),
            120,
        )
        tl_words = generate_captions.remap_words_to_edited_timeline(words, snapped)
        self.assertEqual([w["word"] for w in tl_words], ["Hello", "world", "Ship", "fast!"])
        # Second segment starts at 1.0s on the edited timeline -> "Ship" at 2.60 raw == 1.10 edited
        self.assertAlmostEqual(tl_words[2]["start"], 1.10, places=2)

        chunks = generate_captions.chunk_words(tl_words, max_words=2)
        self.assertEqual(len(chunks), 2)
        srt = generate_captions.render_srt(chunks)
        ass = generate_captions.render_ass(chunks, width=1080, height=1920, style="karaoke")
        overlays = generate_captions.build_cutflow_overlays(chunks)
        self.assertIn("Hello world", srt)
        self.assertIn("SHIP", ass)
        self.assertEqual(len(overlays), 2)

    def test_ingest_url_validation_and_dry_run(self) -> None:
        with self.assertRaises(ValueError):
            ingest_url.validate_url("file:///etc/passwd")
        with tempfile.TemporaryDirectory() as tmp:
            cmd = ingest_url.build_ytdlp_command(
                ytdlp_bin="/usr/bin/yt-dlp",
                url="https://example.com/watch?v=abc",
                out_dir=Path(tmp),
                kind="video",
                section="00:05-00:20",
                filename_stem="test clip!",
            )
            self.assertIn("--download-sections", cmd)
            self.assertIn("*00:05-00:20", cmd)
            self.assertIn("--merge-output-format", cmd)

    def test_doctor_and_script_diff(self) -> None:
        doc = setup_connectors.check_doctor()
        self.assertIn("tools", doc)
        self.assertTrue(doc["tools"]["ffmpeg"])
        diff = verify_edit.compare_scripts("Hello world ship fast", "Hello world ship fast!")
        self.assertEqual(diff["similarity_pct"], 100.0)


class BuildPolishVerifyIntegrationTests(unittest.TestCase):
    def test_pro_pipeline_polish_render_finishing_edl_cutflow_motion_and_qa(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            raw_mp4 = tmp_dir / "sample_vertical.mp4"
            cuts_json = tmp_dir / "cuts.json"
            polished_wav = tmp_dir / "polished.wav"
            out_mp4 = tmp_dir / "cut.mp4"
            out_edl = tmp_dir / "cut.edl"
            out_cf = tmp_dir / "cut.cutflow.json"
            out_qa = tmp_dir / "qa.json"
            out_motion = tmp_dir / "hook.mp4"

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

            # 1. Audio polish (2-pass EBU R128 broadcast mastering)
            p_res = polish_audio.polish_media(raw_mp4, polished_wav, denoise="ffmpeg", target_lufs=-14.0)
            self.assertTrue(polished_wav.is_file())
            self.assertIsNotNone(p_res["output_lufs"])
            self.assertAlmostEqual(float(p_res["output_lufs"]), -14.0, delta=2.0)

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

            # 2. Frame-accurate MP4 render with polished audio, micro-fade, punch-in & look
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
                    "--polished-audio",
                    str(polished_wav),
                    "--audio-fade-ms",
                    "12",
                    "--punch-in",
                    "1.08",
                    "--look",
                    "natural",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertTrue(out_mp4.is_file())
            json_start = proc.stdout.index("{")
            report = json.loads(proc.stdout[json_start:])
            self.assertEqual(report["clip_count"], 2)
            self.assertEqual(report["expected_frames"], 60)
            self.assertEqual(report["actual_frames"], 60)
            self.assertEqual(report["frame_diff"], 0)
            self.assertEqual(report["actual_dimensions"], "360x640 (vertical)")

            # 3. Multi-NLE trimmable exports (CMX 3600 EDL & CutFlow JSON)
            subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "build_cut.py"), "edl", str(raw_mp4), "--cuts", str(cuts_json), "--out", str(out_edl)],
                check=True,
                capture_output=True,
            )
            self.assertIn("FCM: NON-DROP FRAME", out_edl.read_text(encoding="utf-8"))

            subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "build_cut.py"), "cutflow", str(raw_mp4), "--cuts", str(cuts_json), "--out", str(out_cf), "--punch-in", "1.08"],
                check=True,
                capture_output=True,
            )
            cf_data = json.loads(out_cf.read_text(encoding="utf-8"))
            self.assertEqual(len(cf_data["project"]["clips"]), 2)
            self.assertAlmostEqual(cf_data["project"]["clips"][1]["transform"]["scale"], 1.08)

            # 4. Automated Edit QA Verification
            qa = verify_edit.verify_rendered_edit(out_mp4, cuts_json, raw_clip=raw_mp4, out_report=out_qa)
            self.assertTrue(out_qa.is_file())
            self.assertEqual(qa["frame_diff"], 0)
            self.assertIn(qa["verdict"], ("PASS", "WARN"))

            # 5. HyperFrames HTML composition generation + fallback render
            html_path = render_motion.populate_template(
                "hook_card",
                title="Test Hook",
                subtitle="Pro Pipeline",
                badge="LIVE",
                accent="#fbbf24",
                width=360,
                height=640,
                fps=30,
                duration=1.0,
                out_html=out_motion.with_suffix(".html"),
            )
            self.assertIn("data-composition-id=\"hook-card\"", html_path.read_text(encoding="utf-8"))
            render_motion.render_ffmpeg_card_fallback(
                title="Test Hook",
                subtitle="Pro Pipeline",
                width=360,
                height=640,
                fps=30,
                duration=1.0,
                out_mp4=out_motion,
            )
            self.assertTrue(out_motion.is_file())


class HiggsfieldMcpAndBrollTests(unittest.TestCase):
    def test_setup_higgsfield_mcp_json_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mcp_path = Path(tmp) / ".mcp.json"
            res = setup_connectors.setup_higgsfield(mcp_path=mcp_path)
            self.assertEqual(res["url"], "https://mcp.higgsfield.ai/mcp")
            parsed = json.loads(mcp_path.read_text(encoding="utf-8"))
            self.assertEqual(parsed["mcpServers"]["higgsfield"]["type"], "http")
            self.assertEqual(parsed["mcpServers"]["higgsfield"]["url"], "https://mcp.higgsfield.ai/mcp")

    def test_broll_planner_avoids_hook_and_cta_and_non_overlapping(self) -> None:
        segs = [
            {"start": 0.0, "end": 4.0, "text": "Here is how I edit videos super fast"},
            {"start": 5.0, "end": 10.0, "text": "AI generates cinematic b-roll over my talking head"},
            {"start": 11.0, "end": 15.0, "text": "Follow for more creator tips!"},
        ]
        tl, total = plan_broll.build_timeline_segments(segs)
        cues = plan_broll.plan_cues_offline(tl, total, max_cues=3, aspect_ratio="9:16")
        self.assertGreaterEqual(len(cues), 1)
        prev_end = 0.0
        for cue in cues:
            self.assertGreaterEqual(cue["timeline_start_sec"], 1.5)
            self.assertLessEqual(cue["timeline_start_sec"] + cue["duration_sec"], total - 1.49)
            self.assertGreaterEqual(cue["timeline_start_sec"], prev_end)
            prev_end = cue["timeline_start_sec"] + cue["duration_sec"]

    def test_higgsfield_client_request_builder_and_polling(self) -> None:
        url, payload = generate_broll.build_generation_request(
            prompt="Neon skyline drone shot",
            kind="video",
            model="kling",
            aspect_ratio="9:16",
            duration=5,
        )
        self.assertIn("kling-video", url)
        self.assertEqual(payload["aspect_ratio"], "9:16")
        self.assertEqual(payload["duration"], 5)

        calls = {"n": 0}

        def fake_http(req_url, *, method="GET", headers=None, payload=None, timeout=30):
            calls["n"] += 1
            self.assertTrue(headers["Authorization"].startswith("Key test_id:test_sec"))
            if method == "POST":
                return {"request_id": "req-123", "status_url": "https://platform.higgsfield.ai/requests/req-123/status"}
            if calls["n"] == 2:
                return {"status": "in_progress"}
            return {"status": "completed", "video": {"url": "https://cdn.higgsfield.ai/out.mp4"}}

        res = generate_broll.submit_and_poll(
            url=url,
            payload=payload,
            credentials="test_id:test_sec",
            poll_interval_sec=0.01,
            http_fn=fake_http,
        )
        self.assertEqual(res["request_id"], "req-123")
        self.assertEqual(res["output_url"], "https://cdn.higgsfield.ai/out.mp4")

    def test_broll_cutaway_and_pip_compositing_frame_exact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            raw_mp4 = t / "talking.mp4"
            broll_mp4 = t / "broll_shot.mp4"
            cuts_json = t / "cuts.json"
            manifest_json = t / "broll_plan.json"
            out_cutaway = t / "out_cutaway.mp4"
            out_pip = t / "out_pip.mp4"

            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-f", "lavfi", "-i", "testsrc=duration=4:size=360x640:rate=30",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                    str(raw_mp4),
                ],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-f", "lavfi", "-i", "color=c=blue:duration=2:size=360x640:rate=30",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(broll_mp4),
                ],
                check=True,
                capture_output=True,
            )
            cuts_json.write_text(
                json.dumps({"segments": [{"start": 0.0, "end": 3.0, "text": "Main talking head line"}]}),
                encoding="utf-8",
            )
            manifest_json.write_text(
                json.dumps(
                    {
                        "cues": [
                            {
                                "id": "broll-01",
                                "timeline_start_sec": 0.8,
                                "duration_sec": 1.2,
                                "style": "cutaway",
                                "local_path": str(broll_mp4),
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            for style, out_target in (("cutaway", out_cutaway), ("pip", out_pip)):
                proc = subprocess.run(
                    [
                        sys.executable,
                        str(SCRIPTS_DIR / "build_cut.py"),
                        "render-mp4",
                        str(raw_mp4),
                        "--cuts",
                        str(cuts_json),
                        "--out",
                        str(out_target),
                        "--broll-manifest",
                        str(manifest_json),
                        "--broll-style",
                        style,
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                rep = json.loads(proc.stdout[proc.stdout.index("{"):])
                self.assertEqual(rep["expected_frames"], 90)
                self.assertEqual(rep["actual_frames"], 90)
                self.assertEqual(rep["frame_diff"], 0)
                self.assertEqual(rep["broll_cues_composited"], 1)


if __name__ == "__main__":
    unittest.main()
