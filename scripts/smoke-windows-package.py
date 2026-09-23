"""Verify an installed Windows package without opening its desktop window."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import websockets


MARKER = "llmpr_packaged_pty_input_ok"


def _desktop_subsystem(path: Path) -> int:
    """Return the PE optional-header Subsystem value (2 means Windows GUI)."""
    with path.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise RuntimeError(f"not a PE executable: {path}")
        stream.seek(0x3C)
        pe_offset = struct.unpack("<I", stream.read(4))[0]
        stream.seek(pe_offset)
        if stream.read(4) != b"PE\0\0":
            raise RuntimeError(f"invalid PE signature: {path}")
        stream.seek(20, os.SEEK_CUR)  # COFF header
        optional_header = stream.read(70)
    if len(optional_header) < 70:
        raise RuntimeError(f"truncated PE optional header: {path}")
    return struct.unpack_from("<H", optional_header, 68)[0]


def _request_json(base_url: str, method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def _wait_until_ready(base_url: str, process: subprocess.Popen, timeout: float = 60) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"recorder sidecar exited early with code {process.returncode}")
        try:
            if _request_json(base_url, "GET", "/__recorder/api/ping").get("ok") is True:
                return
        except (OSError, urllib.error.URLError, ValueError):
            pass
        time.sleep(0.2)
    raise RuntimeError("recorder sidecar did not become ready")


async def _verify_terminal_input(base_url: str, session_id: str) -> None:
    ws_url = base_url.replace("http://", "ws://", 1)
    ws_url += f"/__recorder/api/terminal/ws/{session_id}"
    received = bytearray()
    try:
        async with websockets.connect(ws_url, open_timeout=10) as websocket:
            deadline = asyncio.get_running_loop().time() + 20
            attached = False
            while asyncio.get_running_loop().time() < deadline and not attached:
                message = await asyncio.wait_for(websocket.recv(), timeout=5)
                if isinstance(message, str):
                    payload = json.loads(message)
                    attached = payload.get("type") == "attached" and payload.get("alive") is True
                else:
                    received.extend(message)
            if not attached:
                raise RuntimeError("terminal websocket never reported attached")

            await websocket.send(json.dumps({"type": "input", "data": f"Write-Output {MARKER}\r"}))
            while asyncio.get_running_loop().time() < deadline:
                message = await asyncio.wait_for(websocket.recv(), timeout=5)
                if isinstance(message, bytes):
                    received.extend(message)
                    if MARKER.encode() in received:
                        return
                else:
                    payload = json.loads(message)
                    if payload.get("type") == "input_error":
                        raise RuntimeError(payload.get("detail") or "terminal input failed")
                    if payload.get("type") == "exit":
                        raise RuntimeError(f"terminal exited with code {payload.get('code')}")
        raise RuntimeError("terminal input marker was not returned by ConPTY")
    except BaseException:
        print(
            "pty output before failure: "
            f"{received.decode('utf-8', errors='replace')!r}",
            file=sys.stderr,
        )
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--desktop", required=True, type=Path)
    parser.add_argument("--recorder", required=True, type=Path)
    parser.add_argument("--opencode", required=True, type=Path)
    args = parser.parse_args()

    subsystem = _desktop_subsystem(args.desktop)
    if subsystem != 2:
        raise RuntimeError(f"desktop executable is not Windows GUI subsystem: {subsystem}")

    with tempfile.TemporaryDirectory(
        prefix="llmpr-package-smoke-", ignore_cleanup_errors=True
    ) as temp_value:
        temp = Path(temp_value)
        env = os.environ.copy()
        env.update(
            {
                "LLMPR_BUNDLED_OPENCODE": str(args.opencode),
                "XDG_CONFIG_HOME": str(temp / "config"),
                "XDG_DATA_HOME": str(temp / "data"),
                "XDG_CACHE_HOME": str(temp / "cache"),
                "XDG_STATE_HOME": str(temp / "state"),
            }
        )
        log_path = temp / "sidecar.log"
        base_url = "http://127.0.0.1:18117"
        command = [
            str(args.recorder),
            "--host",
            "127.0.0.1",
            "--port",
            "18117",
            "--config",
            str(temp / "config" / "config.json"),
            "--records-dir",
            str(temp / "records"),
        ]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        session_id: str | None = None
        with log_path.open("wb") as log_file:
            process = subprocess.Popen(
                command,
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
            try:
                _wait_until_ready(base_url, process)
                check = _request_json(base_url, "GET", "/__recorder/api/terminal/check")
                if check.get("opencode_source") != "bundled" or not check.get("opencode_version"):
                    raise RuntimeError(f"bundled OpenCode check failed: {check}")
                session = _request_json(
                    base_url,
                    "POST",
                    "/__recorder/api/terminal/sessions",
                    {"cwd": str(temp), "kind": "shell", "cols": 100, "rows": 30},
                )
                session_id = session["id"]
                asyncio.run(_verify_terminal_input(base_url, session_id))
                _request_json(
                    base_url, "DELETE", f"/__recorder/api/terminal/sessions/{session_id}"
                )
                session_id = None
            except BaseException:
                log_file.flush()
                print(log_path.read_text(encoding="utf-8", errors="replace")[-12000:], file=sys.stderr)
                raise
            finally:
                if session_id is not None:
                    try:
                        _request_json(
                            base_url, "DELETE", f"/__recorder/api/terminal/sessions/{session_id}"
                        )
                    except Exception:
                        pass
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()

    print("Windows GUI subsystem and packaged ConPTY input smoke test passed")


if __name__ == "__main__":
    main()
