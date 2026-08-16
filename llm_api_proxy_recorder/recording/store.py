"""落盘存储：calls/{date}/{id}.json + index/{date}.jsonl。

写操作（write_partial/finalize）吞掉一切异常并 warning——记录失败
绝不影响代理转发；读操作异常正常抛出。
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

from llm_api_proxy_recorder.recording.models import date_from_call_id
from llm_api_proxy_recorder.recording.parse import first_user_preview

logger = logging.getLogger("llm_api_proxy_recorder")

_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _atomic_write(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class CallStore:
    def __init__(self, records_dir: Path):
        self.records_dir = Path(records_dir)
        self.calls_dir = self.records_dir / "calls"
        self.index_dir = self.records_dir / "index"
        self.calls_dir.mkdir(parents=True, exist_ok=True)
        self.index_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------- internal
    @staticmethod
    def _date_of(rec: dict) -> str:
        d = date_from_call_id(str(rec.get("id", "")))
        if d:
            return d
        started = rec.get("started_at")
        if started:
            try:
                return datetime.fromisoformat(started).astimezone().strftime("%Y-%m-%d")
            except ValueError:
                pass
        return datetime.now().astimezone().strftime("%Y-%m-%d")

    def _calls_date_dir(self, rec: dict) -> Path:
        d = self.calls_dir / self._date_of(rec)
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ----------------------------------------------------------------- write
    def write_partial(self, rec: dict) -> None:
        """请求已发出前的占位记录：calls/{date}/{id}.partial.json。"""
        try:
            p = self._calls_date_dir(rec) / f"{rec['id']}.partial.json"
            _atomic_write(p, json.dumps(rec, indent=2, ensure_ascii=False))
        except Exception:
            logger.warning("写 partial 记录失败 id=%s", rec.get("id"), exc_info=True)

    def finalize(self, rec: dict) -> None:
        """定稿：写最终 JSON（原子替换）、清理 .partial、追加当日索引行。"""
        try:
            d = self._calls_date_dir(rec)
            _atomic_write(d / f"{rec['id']}.json", json.dumps(rec, indent=2, ensure_ascii=False))
            partial = d / f"{rec['id']}.partial.json"
            if partial.exists():
                partial.unlink()
            usage = rec.get("usage") or {}
            req_parsed = ((rec.get("request") or {}).get("parsed")) or {}
            line = {
                "id": rec.get("id"),
                "started_at": rec.get("started_at"),
                "model": rec.get("model"),
                "path": (rec.get("request") or {}).get("path"),
                "status_code": (rec.get("response") or {}).get("status_code"),
                "duration_ms": rec.get("duration_ms"),
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens"),
                "upstream_name": rec.get("upstream_name"),
                "status": rec.get("status"),
                "session_key": rec.get("session_key"),
                "preview": first_user_preview(req_parsed.get("messages")),
            }
            date = self._date_of(rec)
            self.index_dir.mkdir(parents=True, exist_ok=True)
            with open(self.index_dir / f"{date}.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
        except Exception:
            logger.warning("finalize 记录失败 id=%s", rec.get("id"), exc_info=True)

    # ------------------------------------------------------------------ read
    def load_call(self, call_id: str, date: str | None = None) -> dict | None:
        """读取单条记录；无 date 时扫描所有日期目录。"""
        if date is not None:
            p = self.calls_dir / date / f"{call_id}.json"
            return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
        for d in self.available_dates():
            p = self.calls_dir / d / f"{call_id}.json"
            if p.exists():
                return json.loads(p.read_text(encoding="utf-8"))
        return None

    def read_index(self, date: str) -> list[dict]:
        """当日索引行列表（读异常正常抛）。"""
        p = self.index_dir / f"{date}.jsonl"
        out: list[dict] = []
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def available_dates(self) -> list[str]:
        """有 calls 文件的日期，降序。"""
        if not self.calls_dir.exists():
            return []
        dates = [
            d.name
            for d in self.calls_dir.iterdir()
            if d.is_dir() and _DATE_RE.fullmatch(d.name)
        ]
        return sorted(dates, reverse=True)
