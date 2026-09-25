"""Run authenticated OpenCode HTTP servers for saved projects."""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import signal
import socket
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator

import httpx

from llm_api_proxy_recorder.config import AppConfig
from llm_api_proxy_recorder.terminal.manager import (
    _build_argv,
    _build_env,
    resolve_executable,
    resolve_opencode,
)

logger = logging.getLogger("llm_api_proxy_recorder")


class WorkspaceError(Exception):
    def __init__(self, detail: str, status: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status = status


@dataclass
class OpenCodeServer:
    process: subprocess.Popen[bytes]
    client: httpx.AsyncClient
    port: int


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class WorkspaceManager:
    """One OpenCode service per project; sessions remain in OpenCode storage."""

    def __init__(self) -> None:
        self._servers: dict[str, OpenCodeServer] = {}
        self._lock = asyncio.Lock()

    async def ensure(self, project: str, config: AppConfig) -> OpenCodeServer:
        path = str(Path(project).expanduser().resolve())
        if not Path(path).is_dir():
            raise WorkspaceError(f"项目目录不存在：{path}", 404)
        async with self._lock:
            existing = self._servers.get(path)
            if existing and existing.process.poll() is None:
                return existing
            if existing:
                await existing.client.aclose()
                self._servers.pop(path, None)

            resolution = resolve_opencode(config)
            if not resolution.path:
                raise WorkspaceError("未找到 OpenCode 程序，请在设置中配置程序来源", 503)
            executable = resolve_executable(resolution.path)
            if not executable:
                raise WorkspaceError("OpenCode 程序路径无效", 503)

            env = _build_env(config, "opencode")
            password = secrets.token_urlsafe(32)
            env["OPENCODE_SERVER_USERNAME"] = "sona-code"
            env["OPENCODE_SERVER_PASSWORD"] = password
            creationflags = (
                getattr(subprocess, "CREATE_NO_WINDOW", 0)
                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            ) if os.name == "nt" else 0
            for attempt in range(3):
                port = _free_port()
                argv = [*_build_argv(executable, []), "serve", "--hostname", "127.0.0.1", "--port", str(port)]
                try:
                    process = subprocess.Popen(
                        argv, cwd=path, env=env, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, creationflags=creationflags,
                        start_new_session=os.name != "nt",
                    )
                except OSError as exc:
                    raise WorkspaceError(f"启动 OpenCode 失败：{exc}", 503) from exc
                client = httpx.AsyncClient(
                    base_url=f"http://127.0.0.1:{port}",
                    auth=("sona-code", password), trust_env=False, timeout=20,
                )
                for _ in range(50):
                    if process.poll() is not None:
                        break
                    try:
                        response = await client.get("/global/health", timeout=1)
                        if response.status_code == 200:
                            server = OpenCodeServer(process, client, port)
                            self._servers[path] = server
                            return server
                    except httpx.RequestError:
                        pass
                    await asyncio.sleep(.2)
                await client.aclose()
                await self._stop_process(process)
                logger.warning("OpenCode server did not become ready for %s (attempt %d)", path, attempt + 1)
            raise WorkspaceError("OpenCode 服务启动失败，请检查程序版本与应用日志", 503)

    async def request(
        self, project: str, config: AppConfig, method: str, endpoint: str,
        *, body: dict | None = None,
    ) -> object:
        server = await self.ensure(project, config)
        try:
            response = await server.client.request(
                method, endpoint, params={"directory": project}, json=body,
                timeout=180 if endpoint.endswith(("/command", "/shell", "/summarize")) else 20,
            )
        except httpx.RequestError as exc:
            raise WorkspaceError(f"连接 OpenCode 服务失败：{exc}", 502) from exc
        if response.is_error:
            detail = response.text[:500] or "OpenCode 请求失败"
            raise WorkspaceError(detail, response.status_code)
        if response.status_code == 204 or not response.content:
            return {"ok": True}
        try:
            return response.json()
        except ValueError as exc:
            raise WorkspaceError("OpenCode 返回了无法解析的数据", 502) from exc

    async def events(self, project: str, config: AppConfig) -> AsyncIterator[bytes]:
        server = await self.ensure(project, config)
        try:
            async with server.client.stream(
                "GET", "/event", params={"directory": project}, timeout=None,
            ) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    yield chunk
        except httpx.HTTPError:
            logger.warning("OpenCode event stream ended for %s", project, exc_info=True)

    async def stop(self, project: str) -> None:
        path = str(Path(project).expanduser().resolve())
        async with self._lock:
            server = self._servers.pop(path, None)
            if server:
                await server.client.aclose()
                await self._stop_process(server.process)

    async def shutdown(self) -> None:
        async with self._lock:
            servers = list(self._servers.values())
            self._servers.clear()
            for server in servers:
                await server.client.aclose()
                await self._stop_process(server.process)

    @staticmethod
    async def _stop_process(process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        if os.name == "nt":
            await asyncio.to_thread(
                subprocess.run, ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                capture_output=True, check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        else:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            await asyncio.to_thread(process.wait, 3)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                process.kill()
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await asyncio.to_thread(process.wait)
