"""OpenCode 全局 JSONC 编辑接口：语法、冲突保护及原文保留。"""

from fastapi.testclient import TestClient

from llm_api_proxy_recorder.app import create_app
from llm_api_proxy_recorder.config import default_config


def test_opencode_jsonc_editor_preserves_comments_and_checks_revision(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    with TestClient(create_app(default_config(), config_path=str(tmp_path / "proxy.json"))) as client:
        url = "/__recorder/api/settings/opencode-config"
        original = client.get(url).json()
        assert original["path"] == str(tmp_path / "xdg/opencode/opencode.jsonc")

        content = '{\n  // 保留说明\n  "$schema": "https://opencode.ai/config.json",\n  "model": "deepseek/test",\n}\n'
        saved = client.put(url, json={"content": content, "revision": original["revision"]})
        assert saved.status_code == 200, saved.text
        assert (tmp_path / "xdg/opencode/opencode.jsonc").read_text() == content
        assert client.get(url).json()["content"] == content

        outdated = client.put(url, json={"content": "{}", "revision": original["revision"]})
        assert outdated.status_code == 409
        invalid = client.put(url, json={"content": '{"x":,}', "revision": saved.json()["revision"]})
        assert invalid.status_code == 422
        assert (tmp_path / "xdg/opencode/opencode.jsonc").read_text() == content
