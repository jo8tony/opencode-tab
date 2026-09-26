"""Import and manage local OpenCode skill directories."""

from __future__ import annotations

import re
import shutil
import tempfile
import threading
from pathlib import Path

import yaml

from llm_api_proxy_recorder.admin.opencode_config import isolated_config_dir

SKILL_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
WORKSPACE_COMMANDS = {
    "help", "new", "compact", "summarize", "models", "agents", "skills", "stop", "settings",
}
WINDOWS_RESERVED_NAMES = {"con", "prn", "aux", "nul"} | {
    f"{prefix}{number}" for prefix in ("com", "lpt") for number in range(1, 10)
}


def _safe_name(name: str) -> str:
    if len(name) > 64 or not SKILL_NAME.fullmatch(name):
        raise ValueError("技能名称须为 1–64 位小写字母、数字或单个连字符")
    # Windows reserves device names even when used as directory names.
    if name in WINDOWS_RESERVED_NAMES:
        raise ValueError("技能名称不能使用系统保留名称")
    return name


def read_skill(path: Path) -> dict:
    content = (path / "SKILL.md").read_text(encoding="utf-8-sig")
    match = re.match(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", content, re.S)
    if not match:
        raise ValueError("SKILL.md 必须包含 YAML frontmatter")
    try:
        metadata = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise ValueError("SKILL.md 的 YAML frontmatter 格式错误") from exc
    if not isinstance(metadata, dict) or not isinstance(metadata.get("name"), str):
        raise ValueError("SKILL.md 缺少 name 字段")
    name = _safe_name(metadata["name"])
    description = metadata.get("description")
    if not isinstance(description, str) or not 1 <= len(description.strip()) <= 1024:
        raise ValueError("SKILL.md 的 description 须为 1–1024 个字符")
    return {"name": name, "description": description.strip()}


class SkillStore:
    """Enabled skills are discoverable; disabled copies stay outside scan roots."""

    def __init__(self, root: Path | None = None):
        self.root = (root or isolated_config_dir()).expanduser().resolve()
        self.enabled_dir = self.root / "skills"
        self.disabled_dir = self.root / "skills-disabled"
        self._lock = threading.RLock()

    def _prepare(self) -> None:
        for directory in (self.enabled_dir, self.disabled_dir):
            if directory.is_symlink():
                raise ValueError("应用技能存放目录不能是符号链接")
            directory.mkdir(parents=True, exist_ok=True)

    def list(self) -> dict:
        with self._lock:
            self._prepare()
            items = []
            for directory, enabled in ((self.enabled_dir, True), (self.disabled_dir, False)):
                for path in sorted(directory.iterdir()):
                    if not path.is_dir() or path.is_symlink():
                        continue
                    try:
                        _safe_name(path.name)
                    except ValueError:
                        continue
                    item = {"id": path.name, "path": str(path), "enabled": enabled}
                    try:
                        item.update(read_skill(path))
                    except (OSError, ValueError) as exc:
                        item.update(name=path.name, description="", error=str(exc))
                    items.append(item)
            return {
                "items": sorted(items, key=lambda item: item["name"]),
                "directory": str(self.enabled_dir), "total": len(items),
            }

    def _find(self, name: str) -> tuple[Path, bool]:
        _safe_name(name)
        self._prepare()
        matches = [
            (directory / name, enabled)
            for directory, enabled in ((self.enabled_dir, True), (self.disabled_dir, False))
            if (directory / name).exists() or (directory / name).is_symlink()
        ]
        if len(matches) > 1:
            raise FileExistsError("启用和停用目录中存在同名技能，请先处理目录冲突")
        if not matches:
            raise FileNotFoundError("技能不存在")
        path, enabled = matches[0]
        if path.is_symlink() or not path.is_dir():
            raise ValueError("技能目录无效或是符号链接")
        return path, enabled

    def add(self, source: str) -> dict:
        with self._lock:
            self._prepare()
            path = Path(source).expanduser()
            if not path.is_absolute() or not path.is_dir() or path.is_symlink():
                raise ValueError("请指定包含 SKILL.md 的技能目录绝对路径")
            path = path.resolve()
            if not (path / "SKILL.md").is_file():
                raise ValueError("技能目录中缺少 SKILL.md")
            for directory in (self.enabled_dir, self.disabled_dir):
                if path == directory.resolve() or directory.resolve().is_relative_to(path):
                    raise ValueError("源目录不能包含应用技能存放目录")
            # Preserve all resources, but never follow links outside the selected tree.
            for child in path.rglob("*"):
                if child.is_symlink() or not (child.is_dir() or child.is_file()):
                    raise ValueError("技能目录不能包含符号链接或特殊文件")
                if child.name == "SKILL.md" and child.parent != path:
                    raise ValueError("请选择单个技能目录，不能包含嵌套的 SKILL.md")
            metadata = read_skill(path)
            name = metadata["name"]
            if name in WORKSPACE_COMMANDS:
                raise ValueError("技能名称与工作区快捷命令重名，请修改技能 name")
            if any(item["name"] == name or item["id"] == name for item in self.list()["items"]):
                raise FileExistsError("已存在同名技能，请先删除旧副本")
            destination = self.enabled_dir / name
            # Stage outside both scan roots so OpenCode never discovers a partial copy.
            with tempfile.TemporaryDirectory(prefix=".skill-import-", dir=self.root) as temporary:
                staging = Path(temporary) / name
                shutil.copytree(path, staging, symlinks=True)
                if any(child.is_symlink() for child in staging.rglob("*")):
                    raise ValueError("技能目录不能包含符号链接")
                if read_skill(staging) != metadata:
                    raise ValueError("复制时技能定义发生变化，请重试")
                if destination.exists() or (self.disabled_dir / name).exists():
                    raise FileExistsError("已存在同名技能")
                staging.rename(destination)
            return {"id": name, **metadata, "path": str(destination), "enabled": True}

    def set_enabled(self, name: str, enabled: bool) -> dict:
        with self._lock:
            path, current = self._find(name)
            if enabled:
                metadata = read_skill(path)
                if metadata["name"] != name:
                    raise ValueError("技能 name 必须与目录名称一致")
            if current != enabled:
                destination = (self.enabled_dir if enabled else self.disabled_dir) / name
                path.rename(destination)
            return {"ok": True, "id": name, "enabled": enabled}

    def delete(self, name: str) -> dict:
        with self._lock:
            path, _ = self._find(name)
            shutil.rmtree(path)
            return {"ok": True, "id": name}
