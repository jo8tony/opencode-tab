"""读取及保存 OpenCode 全局 JSONC 配置，保留原始注释和排版。"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path


def global_config_path() -> Path:
    root = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "opencode"
    for name in ("opencode.jsonc", "opencode.json"):
        path = root / name
        if path.exists():
            return path
    return root / "opencode.jsonc"


def read_global_config() -> tuple[Path, str, str]:
    path = global_config_path()
    raw = path.read_bytes() if path.exists() else b""
    content = raw.decode("utf-8") if raw else '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
    return path, content, hashlib.sha256(raw).hexdigest()


def validate_jsonc(content: str) -> None:
    """JSONC 支持注释及末尾逗号；解析时仅剔除语法，保存时写原文。"""
    chars = list(content)
    i = 0
    quoted = False
    while i < len(chars):
        if quoted:
            if chars[i] == "\\":
                i += 2
                continue
            if chars[i] == '"':
                quoted = False
            i += 1
            continue
        if chars[i] == '"':
            quoted = True
            i += 1
            continue
        if chars[i] == "/" and i + 1 < len(chars) and chars[i + 1] == "/":
            while i < len(chars) and chars[i] not in "\r\n":
                chars[i] = " "
                i += 1
            continue
        if chars[i] == "/" and i + 1 < len(chars) and chars[i + 1] == "*":
            start = i
            i += 2
            while i + 1 < len(chars) and chars[i:i + 2] != ["*", "/"]:
                i += 1
            if i + 1 >= len(chars):
                raise ValueError("JSONC 块注释未结束")
            i += 2
            for j in range(start, i):
                if chars[j] not in "\r\n":
                    chars[j] = " "
            continue
        i += 1

    quoted = False
    i = 0
    while i < len(chars):
        char = chars[i]
        if quoted and char == "\\":
            i += 2
            continue
        if char == '"':
            quoted = not quoted
        elif char == "," and not quoted:
            j = i + 1
            while j < len(chars) and chars[j].isspace():
                j += 1
            if j < len(chars) and chars[j] in "}]":
                chars[i] = " "
        i += 1
    try:
        obj = json.loads("".join(chars))
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSONC 格式错误：第 {exc.lineno} 行，第 {exc.colno} 列：{exc.msg}") from exc
    if not isinstance(obj, dict):
        raise ValueError("OpenCode 配置必须是 JSON 对象")


def write_global_config(path: Path, content: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".opencode-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()
