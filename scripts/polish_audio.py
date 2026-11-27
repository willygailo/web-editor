#!/usr/bin/env python3
"""Studio voice polish: optional ClearerVoice-Studio AI denoise + 2-pass EBU R128 broadcast mastering."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parent.parent
TRANSCRIPT_DIR = ROOT / "transcript"
CLEARVOICE_VENV = Path.home() / ".cache" / "video-editor" / "clearvoice-venv"

DENOISE_MODELS = {
    "studio": ("speech_enhancement", "MossFormer2_SE_48K", 48000),
    "fast": ("speech_enhancement", "FRCRN_SE_16K", 16000),
    "separate": ("speech_separation", "MossFormer2_SS_16K", 16000),
}


def resolve_clearvoice_python() -> Path | None:
    candidates = [
        CLEARVOICE_VENV / "bin" / "python",
        CLEARVOICE_VENV / "Scripts" / "python.exe",
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


def install_clearvoice_venv() -> Path:
    existing = resolve_clearvoice_python()
    if existing:
        print(f"[clearvoice] Reusing existing venv: {CLEARVOICE_VENV}")
        return existing

    uv_bin = shutil.which("uv")
    if not uv_bin:
        raise RuntimeError("uv is required to install ClearerVoice-Studio venv cleanly.")

    print(f"[clearvoice] Creating isolated Python 3.11 venv at {CLEARVOICE_VENV}...")
    subprocess.run([uv_bin, "venv", str(CLEARVOICE_VENV), "--python", "3.11"], check=True)
    py = resolve_clearvoice_python()
    if not py:
        raise RuntimeError(f"Failed creating venv at {CLEARVOICE_VENV}")

    print("[clearvoice] Installing clearvoice (modelscope/ClearerVoice-Studio)...")
    subprocess.run([uv_bin, "pip", "install", "--python", str(py), "clearvoice"], check=True)
    return py


def source_sig(path: Path) -> dict:
    st = path.stat()
    return {"filename": path.name, "size_bytes": st.st_size, "mtime_ns": st.st_mtime_ns}


def extract_pcm_wav(input_media: Path, wav_out: Path, sample_rate: int = 48000) -> None:
    wav_out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_media),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            str(wav_out),
        ],
        check=True,
        capture_output=True,
    )


def run_clearvoice_denoise(
    input_wav: Path,
    output_wav: Path,
    *,
    preset: str,
    auto_install: bool = False,
) -> tuple[bool, str]:
    py = resolve_clearvoice_python()
    if not py and auto_install:
        py = install_clearvoice_venv()
    if not py:
        return (
            False,
            f"ClearerVoice-Studio venv not found at {CLEARVOICE_VENV}; falling back to FFmpeg spectral denoise.",
        )

    task, model_name, sr = DENOISE_MODELS[preset]
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        src_sr_wav = tmp_dir / "in.wav"
        out_dir = tmp_dir / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        extract_pcm_wav(input_wav, src_sr_wav, sample_rate=sr)

        helper = (
            "import sys\n"
            "from pathlib import Path\n"
            "from clearvoice import ClearVoice\n"
            "task, model_name, inp, out_dir = sys.argv[1:5]\n"
            "cv = ClearVoice(task=task, model_names=[model_name])\n"
            "res = cv(input_path=inp, online_write=False)\n"
            "cv.write(res, output_path=str(Path(out_dir) / 'enhanced.wav'))\n"
        )
        proc = subprocess.run(
            [str(py), "-c", helper, task, model_name, str(src_sr_wav), str(out_dir)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout).strip().splitlines()[-3:]
            return False, f"ClearerVoice ({model_name}) error: {' | '.join(err)}; falling back to FFmpeg denoise."

        candidates = sorted(out_dir.rglob("*.wav"))
        if not candidates:
            return False, f"ClearerVoice ({model_name}) produced no WAV output; falling back to FFmpeg denoise."
        # Upsample cleanly back to 48 kHz mono WAV if needed
        extract_pcm_wav(candidates[0], output_wav, sample_rate=48000)
        return True, f"clearvoice:{model_name}"


def parse_loudnorm_json(stderr: str) -> dict | None:
    matches = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.DOTALL)
    if not matches:
        return None
    try:
        return json.loads(matches[-1])
    except Exception:
        return None


def measure_loudness(audio_path: Path, target_i: float = -14.0, target_tp: float = -1.5, target_lra: float = 7.0) -> dict | None:
    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-i",
            str(audio_path),
            "-af",
            f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:print_format=json",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
    )
    return parse_loudnorm_json(proc.stderr)


def apply_broadcast_master(
    input_wav: Path,
    output_wav: Path,
    *,
    ffmpeg_denoise: bool = False,
    target_lufs: float = -14.0,
    target_tp: float = -1.5,
    target_lra: float = 7.0,
) -> dict:
    """Apply clean broadcast voice chain + 2-pass EBU R128 loudness normalization."""
    pre_filters = ["highpass=f=80"]
    if ffmpeg_denoise:
        pre_filters.append("afftdn=nf=-25:tn=1")
    pre_filters += [
        "equalizer=f=220:t=q:w=1.2:g=1.5",
        "equalizer=f=3400:t=q:w=1.4:g=2.0",
        "acompressor=threshold=-20dB:ratio=3:attack=8:release=110:makeup=2",
    ]
    pre_chain = ",".join(pre_filters)

    # Pass 1: measure loudness after voice EQ/compression
    pass1 = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-i",
            str(input_wav),
            "-af",
            f"{pre_chain},loudnorm=I={target_lufs}:TP={target_tp}:LRA={target_lra}:print_format=json",
            "-f",
            "null",
            "-",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    measured = parse_loudnorm_json(pass1.stderr)

    if measured and measured.get("input_i") not in ("-inf", None):
        ln_filter = (
            f"loudnorm=I={target_lufs}:TP={target_tp}:LRA={target_lra}"
            f":measured_I={measured['input_i']}"
            f":measured_LRA={measured['input_lra']}"
            f":measured_TP={measured['input_tp']}"
            f":measured_thresh={measured['input_thresh']}"
            f":offset={measured['target_offset']}"
            f":linear=true"
        )
    else:
        ln_filter = f"loudnorm=I={target_lufs}:TP={target_tp}:LRA={target_lra}"

    output_wav.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_wav),
            "-af",
            f"{pre_chain},{ln_filter}",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-c:a",
            "pcm_s16le",
            str(output_wav),
        ],
        check=True,
        capture_output=True,
    )

    final_stats = measure_loudness(output_wav, target_lufs, target_tp, target_lra) or {}
    return {
        "input_lufs": measured.get("input_i") if measured else None,
        "output_lufs": final_stats.get("input_i"),
        "output_tp_db": final_stats.get("input_tp"),
        "output_lra": final_stats.get("input_lra"),
        "target_lufs": target_lufs,
    }


def mux_audio_with_video(video_path: Path, polished_wav: Path, output_video: Path) -> None:
    output_video.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-i",
            str(polished_wav),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-shortest",
            "-movflags",
            "+faststart",
            str(output_video),
        ],
        check=True,
        capture_output=True,
    )


def polish_media(
    input_media: Path,
    output_wav: Path,
    *,
    denoise: str = "ffmpeg",
    target_lufs: float = -14.0,
    auto_install: bool = False,
    mux_video_out: Path | None = None,
    force: bool = False,
) -> dict:
    input_media = input_media.expanduser().resolve()
    output_wav = output_wav.expanduser().resolve()
    if not input_media.is_file():
        raise FileNotFoundError(f"Input media not found: {input_media}")

    meta_path = output_wav.with_suffix(".polish.json")
    sig = source_sig(input_media)
    if not force and output_wav.is_file() and meta_path.is_file() and not mux_video_out:
        try:
            prev = json.loads(meta_path.read_text(encoding="utf-8"))
            if (
                prev.get("source") == sig
                and prev.get("denoise_requested") == denoise
                and prev.get("target_lufs") == target_lufs
            ):
                prev["cached"] = True
                return prev
        except Exception:
            pass

    warnings: list[str] = []
    engine_used = "ffmpeg-broadcast"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        raw_wav = tmp_dir / "raw_48k.wav"
        extract_pcm_wav(input_media, raw_wav, sample_rate=48000)

        stage_wav = raw_wav
        use_ffmpeg_denoise = denoise == "ffmpeg"

        if denoise in DENOISE_MODELS:
            cv_wav = tmp_dir / "clearvoice_48k.wav"
            ok, msg = run_clearvoice_denoise(
                raw_wav, cv_wav, preset=denoise, auto_install=auto_install
            )
            if ok:
                stage_wav = cv_wav
                engine_used = msg
                use_ffmpeg_denoise = False
            else:
                warnings.append(msg)
                use_ffmpeg_denoise = True

        master_stats = apply_broadcast_master(
            stage_wav,
            output_wav,
            ffmpeg_denoise=use_ffmpeg_denoise,
            target_lufs=target_lufs,
        )

    if mux_video_out:
        mux_video_out = mux_video_out.expanduser().resolve()
        mux_audio_with_video(input_media, output_wav, mux_video_out)

    result = {
        "source": sig,
        "output_wav": str(output_wav),
        "muxed_video": str(mux_video_out) if mux_video_out else None,
        "denoise_requested": denoise,
        "engine_used": engine_used,
        "warnings": warnings,
        "cached": False,
        **master_stats,
    }
    meta_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Polish talking-head audio with ClearerVoice-Studio + 2-pass EBU R128 broadcast mastering."
    )
    parser.add_argument("input_media", nargs="?", help="Input video or audio file.")
    parser.add_argument("--out", default=None, help="Output polished 48 kHz mono WAV path.")
    parser.add_argument(
        "--denoise",
        choices=["none", "ffmpeg", "fast", "studio", "separate"],
        default="ffmpeg",
        help="Denoise backend: none, ffmpeg (afftdn), fast (FRCRN_SE_16K), studio (MossFormer2_SE_48K), separate (MossFormer2_SS_16K).",
    )
    parser.add_argument("--lufs", type=float, default=-14.0, help="Target integrated loudness in LUFS (default: -14.0).")
    parser.add_argument("--mux-video", default=None, help="Optional output MP4 path with polished audio muxed into original video.")
    parser.add_argument("--install-clearvoice", action="store_true", help="Create ~/.cache/video-editor/clearvoice-venv and install clearvoice.")
    parser.add_argument("--force", action="store_true", help="Ignore cached polished WAV.")
    args = parser.parse_args()

    try:
        if args.install_clearvoice and not args.input_media:
            py = install_clearvoice_venv()
            print(json.dumps({"installed": True, "python": str(py)}, indent=2))
            return

        if not args.input_media:
            sys.exit("ERROR: Provide an input_media file or pass --install-clearvoice.")

        inp = Path(args.input_media).expanduser().resolve()
        out_wav = Path(args.out).expanduser().resolve() if args.out else (TRANSCRIPT_DIR / f"{inp.stem}.polished.wav")
        mux_out = Path(args.mux_video).expanduser().resolve() if args.mux_video else None

        res = polish_media(
            inp,
            out_wav,
            denoise=args.denoise,
            target_lufs=args.lufs,
            auto_install=args.install_clearvoice,
            mux_video_out=mux_out,
            force=args.force,
        )
        print(json.dumps(res, indent=2))
    except Exception as exc:
        sys.exit(f"ERROR: {exc}")


if __name__ == "__main__":
    main()
