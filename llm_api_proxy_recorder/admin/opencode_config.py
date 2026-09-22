"""读取及保存 OpenCode 全局 JSONC 配置，保留原始注释和排版。"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

ORIGINAL_XDG_PREFIX = "LLMPR_ORIGINAL_"
IMPORT_CONFIG_FILES = ("opencode.json", "opencode.jsonc", "tui.json")
IMPORT_CONFIG_DIRS = (
    "agent",
    "agents",
    "command",
    "commands",
    "plugin",
    "plugins",
    "skill",
    "skills",
    "tool",
    "tools",
    "theme",
    "themes",
)


def global_config_path() -> Path:
    root = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "opencode"
    for name in ("opencode.jsonc", "opencode.json"):
        path = root / name
        if path.exists():
            return path
    return root / "opencode.jsonc"


def _xdg_dir(key: str, fallback: Path) -> Path:
    value = os.environ.get(key, "").strip()
    return Path(value).expanduser() if value else fallback


def _original_xdg_dir(key: str, fallback: Path) -> Path:
    value = os.environ.get(f"{ORIGINAL_XDG_PREFIX}{key}", "").strip()
    return Path(value).expanduser() if value else fallback


def isolated_config_dir() -> Path:
    return _xdg_dir("XDG_CONFIG_HOME", Path.home() / ".config") / "opencode"


def isolated_data_dir() -> Path:
    return _xdg_dir("XDG_DATA_HOME", Path.home() / ".local" / "share") / "opencode"


def import_source_dirs() -> tuple[Path, Path]:
    config = _original_xdg_dir("XDG_CONFIG_HOME", Path.home() / ".config") / "opencode"
    data = (
        _original_xdg_dir("XDG_DATA_HOME", Path.home() / ".local" / "share")
        / "opencode"
    )
    return config, data


def _same_path(left: Path, right: Path) -> bool:
    try:
        return left.resolve(strict=False) == right.resolve(strict=False)
    except OSError:
        return os.path.abspath(left) == os.path.abspath(right)


def _tree_files(
    source: Path, destination: Path, prefix: str
) -> tuple[list[tuple[Path, Path, str]], int]:
    candidates: list[tuple[Path, Path, str]] = []
    ignored_symlinks = 0
    if not source.is_dir() or source.is_symlink():
        return candidates, int(source.is_symlink())
    for root, dirs, files in os.walk(source, followlinks=False):
        root_path = Path(root)
        kept_dirs = []
        for dirname in dirs:
            child = root_path / dirname
            if child.is_symlink():
                ignored_symlinks += 1
            else:
                kept_dirs.append(dirname)
        dirs[:] = kept_dirs
        for filename in files:
            item = root_path / filename
            if item.is_symlink() or not item.is_file():
                ignored_symlinks += int(item.is_symlink())
                continue
            relative = item.relative_to(source)
            candidates.append(
                (item, destination / relative, f"{prefix}/{relative.as_posix()}")
            )
    return candidates, ignored_symlinks


def _import_candidates() -> tuple[list[tuple[Path, Path, str]], int]:
    source_config, source_data = import_source_dirs()
    target_config, target_data = isolated_config_dir(), isolated_data_dir()
    if _same_path(source_config, target_config) and _same_path(source_data, target_data):
        return [], 0

    candidates: list[tuple[Path, Path, str]] = []
    ignored_symlinks = 0
    if not _same_path(source_config, target_config):
        for name in IMPORT_CONFIG_FILES:
            source = source_config / name
            if source.is_symlink():
                ignored_symlinks += 1
            elif source.is_file():
                candidates.append((source, target_config / name, f"config/{name}"))
        for name in IMPORT_CONFIG_DIRS:
            items, ignored = _tree_files(
                source_config / name, target_config / name, f"config/{name}"
            )
            candidates.extend(items)
            ignored_symlinks += ignored

    auth = source_data / "auth.json"
    if not _same_path(source_data, target_data):
        if auth.is_symlink():
            ignored_symlinks += 1
        elif auth.is_file():
            candidates.append((auth, target_data / "auth.json", "credentials/auth.json"))
    return candidates, ignored_symlinks


def preview_global_import() -> dict:
    source_config, source_data = import_source_dirs()
    target_config, target_data = isolated_config_dir(), isolated_data_dir()
    candidates, ignored_symlinks = _import_candidates()
    conflicts = [label for _, destination, label in candidates if destination.exists()]
    return {
        "available": bool(candidates),
        "source": {"config": str(source_config), "data": str(source_data)},
        "destination": {"config": str(target_config), "data": str(target_data)},
        "candidate_count": len(candidates),
        "copy_count": len(candidates) - len(conflicts),
        "conflicts": conflicts,
        "ignored_symlinks": ignored_symlinks,
    }


def _copy_without_overwrite(source: Path, destination: Path, *, private: bool) -> bool:
    if source.is_symlink() or not source.is_file():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return False
    fd, temporary = tempfile.mkstemp(prefix=".opencode-import-", dir=destination.parent)
    os.close(fd)
    try:
        shutil.copy2(source, temporary)
        if private and os.name != "nt":
            os.chmod(temporary, 0o600)
        try:
            os.link(temporary, destination)
        except FileExistsError:
            return False
        return True
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def import_global_config() -> dict:
    candidates, ignored_symlinks = _import_candidates()
    copied: list[str] = []
    skipped: list[str] = []
    for source, destination, label in candidates:
        if _copy_without_overwrite(
            source, destination, private=label == "credentials/auth.json"
        ):
            copied.append(label)
        else:
            skipped.append(label)
    return {
        "ok": True,
        "copied": copied,
        "skipped": skipped,
        "ignored_symlinks": ignored_symlinks,
    }


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
        # newline="" keeps the editor payload byte-for-byte identical on Windows.
        # Otherwise TextIOWrapper rewrites LF to CRLF, while the returned revision
        # is calculated from the original LF content and becomes stale immediately.
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()
