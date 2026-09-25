"""Workspace project persistence and OpenCode API delegation."""

from fastapi.testclient import TestClient

from llm_api_proxy_recorder.app import create_app
from llm_api_proxy_recorder.config import AppConfig, TerminalConfig, UpstreamConfig


def test_workspace_projects_and_session_routes(tmp_path):
    config = AppConfig(
        upstreams=[UpstreamConfig(name="main", base_url="http://127.0.0.1:9001")],
        default_upstream="main",
        terminal=TerminalConfig(route_through_proxy=False),
    )
    app = create_app(config, config_path=str(tmp_path / "config.json"))
    calls = []

    async def fake_request(project, cfg, method, endpoint, *, body=None):
        calls.append((project, method, endpoint, body))
        if endpoint == "/session" and method == "GET":
            return [{"id": "ses_123", "title": "existing"}]
        if endpoint == "/session" and method == "POST":
            return {"id": "ses_new", "title": body.get("title")}
        if endpoint.endswith("/message"):
            return [{"info": {"role": "user"}, "parts": [{"type": "text", "text": "hello"}]}]
        return {"ok": True}

    app.state.runtime.workspace.request = fake_request
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    app.state.runtime.terminal_projects.add(str(project_dir), "shell")
    with TestClient(app) as client:
        prefix = "/__recorder/api/workspace"
        assert 'data-nav="workspace"' in client.get("/__recorder/").text
        assert client.get("/__recorder/workspace.js").status_code == 200
        assert client.get("/__recorder/workspace.css").status_code == 200
        added = client.post(f"{prefix}/projects", json={"path": str(project_dir)})
        assert added.status_code == 201
        project_id = added.json()["id"]
        assert app.state.runtime.terminal_projects.list()[0]["kind"] == "shell"
        assert client.get(f"{prefix}/projects").json()["items"][0]["id"] == project_id
        assert client.get(f"{prefix}/projects/{project_id}/sessions").json()["items"][0]["id"] == "ses_123"
        assert client.post(f"{prefix}/projects/{project_id}/sessions", json={"title": "new"}).json()["id"] == "ses_new"
        assert client.get(f"{prefix}/projects/{project_id}/sessions/ses_123/messages").json()[0]["parts"][0]["text"] == "hello"
        assert client.get(f"{prefix}/projects/{project_id}/models").status_code == 200
        assert client.get(f"{prefix}/projects/{project_id}/permissions").status_code == 200
        assert client.post(
            f"{prefix}/projects/{project_id}/permissions/per_123/reply",
            json={"reply": "once"},
        ).status_code == 200
        assert calls[-1][1:] == ("POST", "/permission/per_123/reply", {"reply": "once"})
        prompt = client.post(
            f"{prefix}/projects/{project_id}/sessions/ses_123/prompt",
            json={"text": "fix it", "provider_id": "main", "model_id": "model-x"},
        )
        assert prompt.status_code == 200
        assert calls[-1][1:] == (
            "POST", "/session/ses_123/prompt_async",
            {"parts": [{"type": "text", "text": "fix it"}],
             "model": {"providerID": "main", "modelID": "model-x"}},
        )
        assert client.get(f"{prefix}/projects/missing/sessions").status_code == 404
        assert client.get(f"{prefix}/projects/{project_id}/sessions/bad.id/messages").status_code == 400
        assert client.delete(f"{prefix}/projects/{project_id}").json() == {"ok": True}
        assert client.get(f"{prefix}/projects").json()["items"] == []
