#!/usr/bin/env python3
"""Cross-platform environment doctor & NLE MCP connector setup (Premiere MCP v1.2.3, SpliceKit FCP, ClearerVoice, HyperFrames)."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parent.parent
VENDOR_DIR = ROOT / "vendor"
MCP_JSON = ROOT / ".mcp.json"

PREMIERE_REPO = "https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP.git"
PREMIERE_COMMIT = "12684e3"  # v1.2.3 (avoids broken npm republish)
SPLICEKIT_REPO = "https://github.com/elliotttate/SpliceKit.git"
HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp"


def _load_dotenv_keys() -> dict[str, str]:
    env_path = ROOT / ".env"
    values: dict[str, str] = {}
    if not env_path.is_file():
        return values
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k:
            values[k] = v
    return values


def _has_higgsfield_mcp(mcp_path: Path = MCP_JSON) -> bool:
    if not mcp_path.is_file():
        return False
    try:
        data = json.loads(mcp_path.read_text(encoding="utf-8"))
        srv = (data.get("mcpServers") or {}).get("higgsfield")
        return isinstance(srv, dict) and srv.get("url") == HIGGSFIELD_MCP_URL
    except Exception:
        return False


def _has_higgsfield_api_key() -> bool:
    dotenv = _load_dotenv_keys()
    hf_key = (os.environ.get("HF_KEY") or dotenv.get("HF_KEY") or "").strip()
    if ":" in hf_key:
        return True
    kid = (os.environ.get("HF_API_KEY_ID") or dotenv.get("HF_API_KEY_ID") or "").strip()
    ksec = (os.environ.get("HF_API_KEY_SECRET") or dotenv.get("HF_API_KEY_SECRET") or "").strip()
    return bool(kid and ksec)


def run_version(cmd: list[str]) -> str | None:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if proc.returncode == 0:
            line = (proc.stdout or proc.stderr).strip().splitlines()
            return line[0].strip() if line else "ok"
    except Exception:
        pass
    return None


def check_doctor() -> dict:
    sys_os = platform.system()
    arch = platform.machine()
    whisperx_base = Path.home() / ".cache" / "video-editor" / "whisperx-venv"
    clearvoice_base = Path.home() / ".cache" / "video-editor" / "clearvoice-venv"
    py_sub = Path("Scripts/python.exe") if sys_os == "Windows" else Path("bin/python")

    whisperx_py = whisperx_base / py_sub
    clearvoice_py = clearvoice_base / py_sub

    node_ver = run_version(["node", "--version"])
    node_major = 0
    if node_ver and node_ver.startswith("v"):
        try:
            node_major = int(node_ver.lstrip("v").split(".")[0])
        except ValueError:
            node_major = 0

    uv_py311 = run_version(["uv", "python", "find", "3.11"])
    nvidia_gpu = run_version(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"])

    report = {
        "os": sys_os,
        "arch": arch,
        "apple_silicon_warning": sys_os == "Darwin" and arch != "arm64",
        "gpu": nvidia_gpu or "CPU only (int8)",
        "tools": {
            "ffmpeg": run_version(["ffmpeg", "-version"]),
            "ffprobe": run_version(["ffprobe", "-version"]),
            "uv": run_version(["uv", "--version"]),
            "git": run_version(["git", "--version"]),
            "node": node_ver,
            "node_ge_22": node_major >= 22,
            "python_3_11_uv": uv_py311,
            "yt_dlp": run_version(["yt-dlp", "--version"]),
        },
        "venvs": {
            "whisperx": str(whisperx_py) if whisperx_py.is_file() else None,
            "clearvoice": str(clearvoice_py) if clearvoice_py.is_file() else None,
        },
        "connectors": {
            "premiere_mcp_cloned": (VENDOR_DIR / "premiere-mcp" / "dist" / "index.js").is_file(),
            "splicekit_cloned": (VENDOR_DIR / "splicekit").is_dir(),
            "higgsfield_mcp_registered": _has_higgsfield_mcp(),
            "higgsfield_api_configured": _has_higgsfield_api_key(),
            "mcp_json_exists": MCP_JSON.is_file(),
            "hyperframes_local": (ROOT / "node_modules" / ".bin" / "hyperframes").is_file()
            or bool(shutil.which("hyperframes")),
        },
        "native_workflows_supported_here": (
            ["CutFlow AI Web Studio", "MP4 Pro Render", "FCPXML", "CMX 3600 EDL", "DaVinci Resolve Studio (if installed)"]
            + (["Final Cut Pro (SpliceKit MCP)", "Adobe Premiere Pro MCP"] if sys_os == "Darwin" else [])
            + (["Adobe Premiere Pro MCP"] if sys_os == "Windows" else [])
        ),
    }
    return report


def merge_mcp_server(name: str, server_config: dict, mcp_path: Path = MCP_JSON) -> Path:
    data: dict = {"mcpServers": {}}
    if mcp_path.is_file():
        try:
            loaded = json.loads(mcp_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
                data.setdefault("mcpServers", {})
        except Exception:
            pass
    data["mcpServers"][name] = server_config
    mcp_path.parent.mkdir(parents=True, exist_ok=True)
    mcp_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return mcp_path


def setup_higgsfield(*, mcp_path: Path = MCP_JSON) -> dict:
    """Register Higgsfield's managed remote Streamable HTTP MCP server in .mcp.json."""
    written = merge_mcp_server(
        "higgsfield",
        {
            "type": "http",
            "url": HIGGSFIELD_MCP_URL,
        },
        mcp_path=mcp_path,
    )
    return {
        "connector": "higgsfield",
        "transport": "http",
        "url": HIGGSFIELD_MCP_URL,
        "mcp_json": str(written),
        "api_key_configured": _has_higgsfield_api_key(),
        "claude_code_cli_command": f"claude mcp add --transport http higgsfield {HIGGSFIELD_MCP_URL}",
        "next_steps": [
            "Restart Claude Code (or your MCP client) in this folder and approve the 'higgsfield' connector.",
            "Complete the Higgsfield OAuth sign-in popup to use your higgsfield.ai credits with zero API keys.",
            "Optional: set HF_API_KEY_ID & HF_API_KEY_SECRET (or HF_KEY) in .env for headless CLI / CutFlow Web UI generation.",
        ],
    }


def setup_premiere(*, register_only: bool = False) -> dict:
    sys_os = platform.system()
    target = VENDOR_DIR / "premiere-mcp"
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)

    if not register_only:
        if not (target / ".git").is_dir():
            print(f"[premiere] Cloning {PREMIERE_REPO} -> {target}")
            subprocess.run(["git", "clone", PREMIERE_REPO, str(target)], check=True)
        print(f"[premiere] Checking out pinned v1.2.3 commit ({PREMIERE_COMMIT})...")
        subprocess.run(["git", "-C", str(target), "checkout", PREMIERE_COMMIT], check=True)
        print("[premiere] Running npm install && npm run build...")
        subprocess.run(["npm", "install"], cwd=str(target), check=True)
        subprocess.run(["npm", "run", "build"], cwd=str(target), check=True)

        if sys_os == "Darwin":
            subprocess.run(["npm", "run", "setup:mac"], cwd=str(target), check=True)
            for v in range(9, 16):
                subprocess.run(
                    ["defaults", "write", f"com.adobe.CSXS.{v}", "PlayerDebugMode", "1"],
                    check=False,
                )
            subprocess.run(["npm", "run", "setup:doctor"], cwd=str(target), check=False)
        elif sys_os == "Windows":
            subprocess.run(["npm", "run", "setup:win"], cwd=str(target), check=True)
            subprocess.run(["npm", "run", "setup:doctor"], cwd=str(target), check=False)
        else:
            print("[premiere] Note: Linux host detected — built MCP server & generated .mcp.json; CEP panel install runs on macOS/Windows.")

    temp_dir = str((Path(tempfile.gettempdir()) / "premiere-mcp-bridge").resolve())
    Path(temp_dir).mkdir(parents=True, exist_ok=True)
    entry_js = str((target / "dist" / "index.js").resolve())

    mcp_path = merge_mcp_server(
        "premiere-pro",
        {
            "command": "node",
            "args": [entry_js],
            "timeout": 600000,
            "env": {
                "PREMIERE_TEMP_DIR": temp_dir,
                "PREMIERE_MCP_TELEMETRY": "0",
            },
        },
    )
    return {
        "connector": "premiere-pro",
        "repo_dir": str(target),
        "pinned_commit": PREMIERE_COMMIT,
        "temp_dir": temp_dir,
        "mcp_json": str(mcp_path),
        "next_steps": [
            "Open a NEW empty Premiere Pro project saved to disk.",
            "In Premiere: Window > Extensions > MCP Bridge (CEP) > Start Bridge.",
            "Restart Claude Code in this folder and approve the premiere-pro MCP server.",
        ],
    }


def setup_splicekit(*, clone: bool = True) -> dict:
    sys_os = platform.system()
    target = VENDOR_DIR / "splicekit"
    if sys_os != "Darwin":
        return {
            "connector": "splicekit",
            "supported_on_this_os": False,
            "os": sys_os,
            "message": (
                "elliotttate/SpliceKit drives Final Cut Pro live on macOS only. "
                "On Linux/Windows, use `scripts/build_cut.py fcpxml`, `edl`, or `cutflow` for trimmable timelines."
            ),
        }

    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    if clone and not (target / ".git").is_dir():
        print(f"[splicekit] Cloning {SPLICEKIT_REPO} -> {target}")
        subprocess.run(["git", "clone", SPLICEKIT_REPO, str(target)], check=True)

    return {
        "connector": "splicekit",
        "supported_on_this_os": True,
        "repo_dir": str(target),
        "next_steps": [
            f"Follow {target}/README.md to patch a sandboxed copy of Final Cut Pro and enable the SpliceKit MCP bridge.",
            "Keep `scripts/build_cut.py fcpxml` available as a zero-risk fallback for clean Final Cut libraries.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Environment doctor & NLE connector bootstrapper.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="Check all local tools, venvs, GPU, and connectors.")

    p_prem = sub.add_parser("premiere", help="Clone pinned Adobe_Premiere_Pro_MCP v1.2.3 & register .mcp.json.")
    p_prem.add_argument("--register-only", action="store_true", help="Only write .mcp.json without cloning/building.")

    p_sk = sub.add_parser("splicekit", help="Clone & guide Final Cut Pro live MCP via elliotttate/SpliceKit (macOS).")
    p_sk.add_argument("--no-clone", action="store_true")

    p_hf = sub.add_parser("higgsfield", help="Register Higgsfield remote MCP (https://mcp.higgsfield.ai/mcp) in .mcp.json.")
    p_hf.add_argument("--mcp-path", default=str(MCP_JSON), help="Optional target .mcp.json path.")

    sub.add_parser("clearvoice", help="Install ClearerVoice-Studio into ~/.cache/video-editor/clearvoice-venv.")

    args = parser.parse_args()
    if args.cmd == "doctor":
        print(json.dumps(check_doctor(), indent=2))
    elif args.cmd == "premiere":
        print(json.dumps(setup_premiere(register_only=args.register_only), indent=2))
    elif args.cmd == "splicekit":
        print(json.dumps(setup_splicekit(clone=not args.no_clone), indent=2))
    elif args.cmd == "higgsfield":
        print(json.dumps(setup_higgsfield(mcp_path=Path(args.mcp_path).expanduser().resolve()), indent=2))
    elif args.cmd == "clearvoice":
        sys.path.insert(0, str(ROOT / "scripts"))
        import polish_audio  # noqa: E402

        py = polish_audio.install_clearvoice_venv()
        print(json.dumps({"installed": True, "python": str(py)}, indent=2))


if __name__ == "__main__":
    main()
