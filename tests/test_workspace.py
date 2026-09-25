"""Workspace project persistence and OpenCode API delegation."""

import base64

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
        if endpoint == "/agent":
            return [{"name": "build", "mode": "primary"}]
        if endpoint == "/command":
            return [{"name": "review", "description": "Review changes"}]
        if endpoint == "/config/providers":
            return {"providers": [{"id": "main", "models": {"model-x": {}}}], "default": {}}
        if endpoint == "/provider":
            return {"connected": ["main"]}
        if endpoint == "/question":
            return [{"id": "que_123", "sessionID": "ses_123", "questions": []}]
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
        assert client.get(f"{prefix}/projects/{project_id}/sessions/ses_123").status_code == 200
        assert client.patch(f"{prefix}/projects/{project_id}/sessions/ses_123", json={"title": "renamed"}).status_code == 200
        assert calls[-1][1:] == ("PATCH", "/session/ses_123", {"title": "renamed"})
        assert client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/fork", json={"message_id": "msg_1"}).status_code == 200
        assert calls[-1][1:] == ("POST", "/session/ses_123/fork", {"messageID": "msg_1"})
        assert client.get(f"{prefix}/projects/{project_id}/sessions/ses_123/todo").status_code == 200
        assert calls[-1][2] == "/session/ses_123/todo"
        assert client.get(f"{prefix}/projects/{project_id}/sessions/ses_123/children").status_code == 200
        assert calls[-1][2] == "/session/ses_123/children"
        assert client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/share").status_code == 200
        assert calls[-1][2] == "/session/ses_123/share"
        assert client.delete(f"{prefix}/projects/{project_id}/sessions/ses_123/share").status_code == 200
        assert calls[-1][1] == "DELETE"
        assert client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/revert",
                           json={"message_id": "msg_1"}).status_code == 200
        assert calls[-1][3] == {"messageID": "msg_1"}
        assert client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/unrevert").status_code == 200
        assert calls[-1][2] == "/session/ses_123/unrevert"
        assert client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/summarize",
                           json={"provider_id": "main", "model_id": "model-x"}).status_code == 200
        assert calls[-1][3] == {"providerID": "main", "modelID": "model-x"}
        assert client.get(f"{prefix}/projects/{project_id}/sessions/ses_123/messages").json()[0]["parts"][0]["text"] == "hello"
        models = client.get(f"{prefix}/projects/{project_id}/models").json()
        assert models["providers"][0]["id"] == "main"
        assert models["connected"] == ["main"]
        saved_key = client.post(f"{prefix}/projects/{project_id}/providers/main/api-key",
                                json={"key": "test-secret"})
        assert saved_key.json() == {"ok": True, "provider_id": "main", "configured": True}
        assert calls[-1][1:] == ("PUT", "/auth/main", {"type": "api", "key": "test-secret"})
        assert client.post(f"{prefix}/projects/{project_id}/providers/main/api-key",
                           json={"key": ""}).status_code == 422
        assert client.get(f"{prefix}/projects/{project_id}/agents").json()[0]["name"] == "build"
        assert client.get(f"{prefix}/projects/{project_id}/commands").json()[0]["name"] == "review"
        assert client.get(f"{prefix}/projects/{project_id}/questions").json()[0]["id"] == "que_123"
        assert client.post(f"{prefix}/projects/{project_id}/questions/que_123/reply",
                           json={"answers": [["Yes"]]}).status_code == 200
        assert calls[-1][1:] == ("POST", "/question/que_123/reply", {"answers": [["Yes"]]})
        assert client.post(f"{prefix}/projects/{project_id}/questions/que_123/reject").status_code == 200
        assert calls[-1][1:] == ("POST", "/question/que_123/reject", {})
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
        file_url = "data:image/png;base64," + base64.b64encode(b"fake-image").decode("ascii")
        attachment = {"filename": "image.png", "mime": "image/png", "url": file_url}
        attached = client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/prompt",
                               json={"text": "", "files": [attachment], "variant": "high"})
        assert attached.status_code == 200
        assert calls[-1][3] == {"parts": [{"type": "file", **attachment}], "variant": "high"}
        assert client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/prompt",
                           json={"text": ""}).status_code == 400
        assert client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/prompt",
                           json={"files": [{**attachment, "url": "https://example.com/image.png"}]}).status_code == 400
        assert client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/prompt",
                           json={"files": [{**attachment, "filename": "../image.png"}]}).status_code == 400
        client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/prompt",
                    json={"text": "plan it", "agent": "plan"})
        assert calls[-1][3]["agent"] == "plan"
        command = client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/command",
                              json={"command": "review", "arguments": "HEAD", "agent": "build",
                                    "provider_id": "main", "model_id": "model-x", "variant": "low"})
        assert command.status_code == 200
        assert calls[-1][1:] == (
            "POST", "/session/ses_123/command",
            {"command": "review", "arguments": "HEAD", "agent": "build", "variant": "low",
             "model": "main/model-x"},
        )
        shell = client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/shell",
                            json={"command": "pwd", "agent": "build"})
        assert shell.status_code == 200
        assert calls[-1][1:] == (
            "POST", "/session/ses_123/shell", {"command": "pwd", "agent": "build"},
        )
        assert client.post(f"{prefix}/projects/{project_id}/sessions/ses_123/command",
                           json={"command": "bad/name"}).status_code == 422
        assert client.get(f"{prefix}/projects/missing/sessions").status_code == 404
        assert client.get(f"{prefix}/projects/{project_id}/sessions/bad.id/messages").status_code == 400
        assert client.delete(f"{prefix}/projects/{project_id}/sessions/ses_123").status_code == 200
        assert calls[-1][1:3] == ("DELETE", "/session/ses_123")
        assert client.delete(f"{prefix}/projects/{project_id}").json() == {"ok": True}
        assert client.get(f"{prefix}/projects").json()["items"] == []
