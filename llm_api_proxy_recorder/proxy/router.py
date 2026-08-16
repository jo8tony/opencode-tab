"""上游路由：/up/{name}/ 前缀 → 命名上游；其余 → 默认上游。"""

from __future__ import annotations

from llm_api_proxy_recorder.config import AppConfig, UpstreamConfig


def resolve_upstream(path: str, cfg: AppConfig) -> tuple[UpstreamConfig, str]:
    """返回 (上游配置, 去除前缀后的上游路径)。

    - path 以 /up/{name}/ 开头且 name 在 cfg.upstreams → 该上游，路径去掉 /up/{name}
    - 否则（含 /up/未知名）→ 默认上游，路径原样
    """
    prefix = "/up/"
    if path.startswith(prefix):
        name, sep, sub = path[len(prefix):].partition("/")
        if sep:  # 必须形如 /up/{name}/xxx
            for u in cfg.upstreams:
                if u.name == name:
                    return u, "/" + sub
    default = next(u for u in cfg.upstreams if u.name == cfg.default_upstream)
    return default, path


def build_upstream_url(base_url: str, upstream_path: str, query: str) -> str:
    """拼接上游 URL；query 为原始 query string，原样透传不重编码。"""
    url = base_url.rstrip("/") + "/" + upstream_path.lstrip("/")
    if query:
        url += "?" + query
    return url
