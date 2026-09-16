"""Web 终端模块测试：manager PTY 生命周期 / REST 会话 CRUD / 目录浏览 / WebSocket。"""

import json
import os
import sys
import time

import pytest
from fastapi.testclient import TestClient

from llm_api_proxy_recorder.app import create_app
from llm_api_proxy_recorder.config import AppConfig, TerminalConfig, UpstreamConfig

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or os.environ.get("LLMPR_SKIP_TERMINAL_TESTS"),
    reason="终端模块依赖 Windows pywinpty",
)


def make_cfg(**terminal_overrides) -> AppConfig:
    return AppConfig(
        upstreams=[UpstreamConfig(name="main", base_url="http://127.0.0.1:9001")],
        default_upstream="main",
        terminal=TerminalConfig(**terminal_overrides),
    )


def make_client(cfg: AppConfig) -> TestClient:
    app = create_app(cfg, config_path="term-test-config.json")
    return TestClient(app)


# ------------------------------------------------------------------ 配置
class TestTerminalConfig:
    def test_defaults(self):
        t = TerminalConfig()
        assert t.enabled is True
        assert t.command == "opencode"
        assert t.max_sessions == 8
        assert t.route_through_proxy is True

    def test_app_config_has_terminal_section(self):
        assert make_cfg().terminal.scrollback_kb == 256


# ------------------------------------------------------------------ 命令解析
class TestResolve:
    def test_resolve_cmd_shim_wrapping(self):
        from llm_api_proxy_recorder.terminal.manager import _build_argv

        argv = _build_argv(r"C:\npm\opencode.CMD", ["--x"])
        assert argv[0] == "cmd.exe"
        assert argv[1] == "/c"
        assert argv[2] == r"C:\npm\opencode.CMD"
        assert argv[3] == "--x"

    def test_resolve_exe_direct(self):
        from llm_api_proxy_recorder.terminal.manager import _build_argv

        argv = _build_argv(r"C:\bin\opencode.exe", [])
        assert argv == [r"C:\bin\opencode.exe"]

    def test_resolve_executable(self):
        from llm_api_proxy_recorder.terminal.manager import resolve_executable

        assert resolve_executable("") is None
        assert resolve_executable("definitely-not-exist-xyz") is None
        # 完整路径探测
        assert resolve_executable(os.path.join(os.sep, "definitely", "not", "exist")) is None

    def test_build_env_proxy_injection(self):
        from llm_api_proxy_recorder.terminal.manager import _build_env

        cfg = make_cfg()
        env = _build_env(cfg, "opencode")
        assert env["OPENAI_BASE_URL"] == "http://127.0.0.1:8117"
        assert env["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:8117"
        # keep 策略不注入占位 key
        assert "OPENAI_API_KEY" not in env or env["OPENAI_API_KEY"] != "proxy-managed"

        # replace 策略注入占位 key
        cfg2 = AppConfig(
            upstreams=[
                UpstreamConfig(name="main", base_url="http://127.0.0.1:9001", key_strategy="replace")
            ],
            default_upstream="main",
        )
        env2 = _build_env(cfg2, "opencode")
        assert env2["OPENAI_API_KEY"] == "proxy-managed"

        # 命名上游走 /up/{name} 前缀
        cfg3 = make_cfg(proxy_upstream="main")
        env3 = _build_env(cfg3, "opencode")
        assert env3["OPENAI_BASE_URL"] == "http://127.0.0.1:8117/up/main"

        # 关闭联动不注入
        env4 = _build_env(make_cfg(route_through_proxy=False), "opencode")
        assert "OPENAI_BASE_URL" not in env4

        # shell 会话不注入代理变量
        env5 = _build_env(make_cfg(), "shell")
        assert "OPENAI_BASE_URL" not in env5

        # inject_env 优先级最高
        env6 = _build_env(make_cfg(inject_env={"OPENAI_BASE_URL": "http://override"}), "opencode")
        assert env6["OPENAI_BASE_URL"] == "http://override"


# ------------------------------------------------------------------ REST + WS
@pytest.fixture
def client(tmp_path):
    with make_client(make_cfg()) as c:
        c._tmp = str(tmp_path)
        yield c


class TestSessionsApi:
    def test_create_list_delete_shell_session(self, client):
        r = client.post(
            "/__recorder/api/terminal/sessions",
            json={"cwd": client._tmp, "kind": "shell"},
        )
        assert r.status_code == 201, r.text
        info = r.json()
        assert info["kind"] == "shell"
        assert info["alive"] is True

        lst = client.get("/__recorder/api/terminal/sessions").json()
        assert lst["total"] == 1

        assert client.delete(f"/__recorder/api/terminal/sessions/{info['id']}").status_code == 200
        assert client.get("/__recorder/api/terminal/sessions").json()["total"] == 0
        assert client.delete(f"/__recorder/api/terminal/sessions/{info['id']}").status_code == 404

    def test_create_invalid_cwd(self, client):
        r = client.post(
            "/__recorder/api/terminal/sessions",
            json={"cwd": r"D:\definitely\not\exist", "kind": "shell"},
        )
        assert r.status_code == 400
        assert "不存在" in r.json()["detail"]

    def test_create_relative_cwd_rejected(self, client):
        r = client.post(
            "/__recorder/api/terminal/sessions",
            json={"cwd": "relative/path", "kind": "shell"},
        )
        assert r.status_code == 400

    def test_create_unknown_kind_rejected(self, client):
        r = client.post(
            "/__recorder/api/terminal/sessions",
            json={"cwd": client._tmp, "kind": "vim"},
        )
        assert r.status_code == 422  # Literal 校验

    def test_disabled_terminal(self, tmp_path):
        with make_client(make_cfg(enabled=False)) as c:
            r = c.post(
                "/__recorder/api/terminal/sessions",
                json={"cwd": str(tmp_path), "kind": "shell"},
            )
            assert r.status_code == 400

    def test_max_sessions_limit(self, tmp_path):
        with make_client(make_cfg(max_sessions=2, shell_command="powershell.exe")) as c:
            for _ in range(2):
                r = c.post(
                    "/__recorder/api/terminal/sessions",
                    json={"cwd": str(tmp_path), "kind": "shell"},
                )
                assert r.status_code == 201
            r = c.post(
                "/__recorder/api/terminal/sessions",
                json={"cwd": str(tmp_path), "kind": "shell"},
            )
            assert r.status_code == 400
            assert "上限" in r.json()["detail"]


class TestWebSocket:
    def test_attach_input_output_exit(self, client):
        r = client.post(
            "/__recorder/api/terminal/sessions",
            json={"cwd": client._tmp, "kind": "shell", "cols": 100, "rows": 30},
        )
        sid = r.json()["id"]
        with client.websocket_connect(f"/__recorder/api/terminal/ws/{sid}") as ws:
            first = json.loads(ws.receive_text())
            assert first["type"] == "attached"
            assert first["alive"] is True

            ws.send_text(json.dumps({"type": "input", "data": "echo hello_ws\r"}))
            buf = b""
            deadline = time.time() + 20
            while time.time() < deadline and b"hello_ws" not in buf:
                buf += ws.receive_bytes()
            assert b"hello_ws" in buf  # 回显可见

        client.delete(f"/__recorder/api/terminal/sessions/{sid}")

    def test_unknown_session_close_code(self, client):
        with pytest.raises(Exception):
            with client.websocket_connect("/__recorder/api/terminal/ws/nope123"):
                pass


class TestFsApi:
    def test_roots(self, client):
        r = client.get("/__recorder/api/terminal/fs").json()
        assert r["entries"]
        assert all(e["path"] for e in r["entries"])

    def test_list_subdirs(self, client, tmp_path):
        (tmp_path / "alpha").mkdir()
        (tmp_path / "beta").mkdir()
        (tmp_path / "file.txt").write_text("x", encoding="utf-8")

        r = client.get("/__recorder/api/terminal/fs", params={"path": str(tmp_path)}).json()
        names = [e["name"] for e in r["entries"]]
        assert names == ["alpha", "beta"]  # 仅目录，排序，无文件
        assert r["parent"] is not None

    def test_invalid_path(self, client):
        r = client.get("/__recorder/api/terminal/fs", params={"path": r"D:\no\such\dir"})
        assert r.status_code == 400


class TestCheckApi:
    def test_check(self, client):
        r = client.get("/__recorder/api/terminal/check").json()
        assert "opencode_found" in r
        assert "shell_command" in r
        assert r["enabled"] is True
