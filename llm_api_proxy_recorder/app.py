"""应用工厂：RuntimeState + 管理 ping + 兜底透明代理路由。"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from llm_api_proxy_recorder.admin.api import router as admin_router
from llm_api_proxy_recorder.config import CONFIG_PATH, AppConfig, resolved_records_dir
from llm_api_proxy_recorder.proxy.client import UpstreamClient
from llm_api_proxy_recorder.proxy.handler import proxy_endpoint
from llm_api_proxy_recorder.recording.store import CallStore
from llm_api_proxy_recorder.terminal import TerminalManager
from llm_api_proxy_recorder.terminal.routes import router as terminal_router

logger = logging.getLogger("llm_api_proxy_recorder")

PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

# 保留策略自动清理间隔
RETENTION_SWEEP_SECONDS = 3600


async def _retention_sweep(runtime: "RuntimeState") -> None:
    """按 retention_days 清理过期日期记录；异常只记日志，绝不影响代理。"""
    days = runtime.config.recording.retention_days
    if days <= 0:
        return
    try:
        removed = await asyncio.to_thread(runtime.store.cleanup_older_than, days)
        if removed:
            logger.info("保留策略清理：retention=%d 天，删除日期 %s", days, ", ".join(removed))
    except Exception:
        logger.warning("保留策略清理失败", exc_info=True)


class NoCacheStaticFiles(StaticFiles):
    """Web UI 静态资源：允许缓存但每次强制重新验证（no-cache）。

    无此头时浏览器走启发式缓存，代码更新后页面可能长期停留在旧 JS。
    未变更文件仍可 304 快速返回，不影响性能。
    """

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


class RuntimeState:
    """运行时共享状态：配置、上游客户端、落盘存储。"""

    def __init__(self, config: AppConfig):
        self.config = config
        self.upstream_client = UpstreamClient(config.outbound.proxy_url)
        self.store = CallStore(resolved_records_dir(config))
        self.terminal = TerminalManager()

    async def apply_config(self, new_cfg: AppConfig) -> None:
        """热更新：换 config 引用；出站代理变化时重建客户端；记录目录变化时重建 store。"""
        old_proxy = self.config.outbound.proxy_url
        old_dir = resolved_records_dir(self.config)
        self.config = new_cfg
        if new_cfg.outbound.proxy_url != old_proxy:
            await self.upstream_client.rebuild(new_cfg.outbound.proxy_url)
        if resolved_records_dir(new_cfg) != old_dir:
            self.store = CallStore(resolved_records_dir(new_cfg))

    async def aclose(self) -> None:
        await self.upstream_client.aclose()


def create_app(cfg: AppConfig, config_path: str | None = None) -> FastAPI:
    runtime = RuntimeState(cfg)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # 启动即执行一次保留清理，此后每小时一次；失败不影响服务
        await _retention_sweep(runtime)

        async def _loop() -> None:
            while True:
                await asyncio.sleep(RETENTION_SWEEP_SECONDS)
                await _retention_sweep(runtime)

        sweeper = asyncio.create_task(_loop())
        try:
            yield
        finally:
            sweeper.cancel()
            # 终止全部终端会话进程，避免孤儿进程
            try:
                await runtime.terminal.shutdown()
            except Exception:
                logger.warning("终端会话清理失败", exc_info=True)
            await runtime.aclose()

    app = FastAPI(title="llm-api-proxy-recorder", lifespan=lifespan)
    app.state.runtime = runtime
    app.state.config = cfg  # 兼容旧引用
    app.state.config_path = config_path or CONFIG_PATH

    # 管理 API（必须先于兜底路由注册：Starlette 按注册顺序匹配）
    @app.get(f"{cfg.server.admin_prefix}/api/ping")
    def ping() -> dict:
        return {"ok": True}

    # 管理 API 路由集（ping 之后、兜底代理路由之前）
    app.include_router(admin_router, prefix=f"{cfg.server.admin_prefix}/api")

    # 终端 API（REST + WebSocket，同样先于兜底代理路由注册）
    app.include_router(terminal_router, prefix=f"{cfg.server.admin_prefix}/api")

    # 静态 Web UI：admin 路由已注册在前，不会被吞掉 {admin_prefix}/api/*
    static_dir = Path(__file__).parent / "web" / "static"
    # 裸访问 {admin_prefix}（无尾斜杠）重定向到 UI 首页，避免落入兜底代理
    @app.get(cfg.server.admin_prefix, include_in_schema=False)
    def admin_root() -> RedirectResponse:
        return RedirectResponse(url=f"{cfg.server.admin_prefix}/")

    app.mount(f"{cfg.server.admin_prefix}", NoCacheStaticFiles(directory=str(static_dir), html=True), name="ui")

    # 兜底透明代理路由；/{path:path} 不匹配根路径 "/"，需单独注册
    app.add_api_route("/", proxy_endpoint, methods=PROXY_METHODS)
    app.add_api_route("/{path:path}", proxy_endpoint, methods=PROXY_METHODS)
    return app
