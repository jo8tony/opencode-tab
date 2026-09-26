"""Skill copies, enablement, workspace refresh, and native command delegation."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from llm_api_proxy_recorder.admin.skills import SkillStore
from llm_api_proxy_recorder.app import create_app
from llm_api_proxy_recorder.config import default_config
from llm_api_proxy_recorder.workspace.manager import OpenCodeServer, WorkspaceError, WorkspaceManager


def make_skill(root: Path, name: str = "code-review") -> Path:
    source = root / name
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: >-\n  Review code and\n  explain findings.\n---\nUse references/checklist.md.\n",
        encoding="utf-8",
    )
    (source / "references").mkdir()
    (source / "references/checklist.md").write_text("checklist", encoding="utf-8")
    return source


def test_skill_copy_enable_disable_delete_and_restart(tmp_path):
    source = make_skill(tmp_path / "user")
    root = tmp_path / "app/opencode"
    store = SkillStore(root)
    added = store.add(str(source))
    assert added["description"] == "Review code and explain findings."
    installed = root / "skills/code-review"
    assert (installed / "references/checklist.md").read_text() == "checklist"
    (source / "references/checklist.md").write_text("source changed")
    assert (installed / "references/checklist.md").read_text() == "checklist"
    store.set_enabled("code-review", False)
    assert not installed.exists()
    disabled = root / "skills-disabled/code-review"
    assert (disabled / "SKILL.md").is_file()
    restarted = SkillStore(root)
    assert restarted.list()["items"][0]["enabled"] is False
    with pytest.raises(FileExistsError):
        restarted.add(str(source))
    restarted.set_enabled("code-review", True)
    assert installed.is_dir()
    restarted.delete("code-review")
    assert restarted.list()["items"] == []
    assert source.is_dir()
    with pytest.raises(FileNotFoundError):
        restarted.delete("code-review")


@pytest.mark.parametrize("name", ["../escape", "UPPER", "bad--name", "con", "a" * 65])
def test_invalid_skill_names_cannot_escape_storage(tmp_path, name):
    source = make_skill(tmp_path / "user")
    (source / "SKILL.md").write_text(f"---\nname: {name}\ndescription: test\n---\nbody")
    store = SkillStore(tmp_path / "app")
    with pytest.raises(ValueError):
        store.add(str(source))
    with pytest.raises(ValueError):
        store.delete(name)
    assert not list(store.enabled_dir.iterdir())


def test_invalid_frontmatter_and_nested_skills_are_not_partially_copied(tmp_path):
    source = make_skill(tmp_path / "user")
    store = SkillStore(tmp_path / "app")
    for content in ["no frontmatter", "---\nname: [invalid\n---\nbody", "---\nname: code-review\n---\nbody"]:
        (source / "SKILL.md").write_text(content)
        with pytest.raises(ValueError):
            store.add(str(source))
        assert store.list()["items"] == []
    nested = source / "nested"
    nested.mkdir()
    (nested / "SKILL.md").write_text("nested")
    with pytest.raises(ValueError, match="嵌套"):
        store.add(str(source))


def test_missing_skill_file_and_reserved_command_names(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    store = SkillStore(tmp_path / "app")
    with pytest.raises(ValueError, match="缺少 SKILL.md"):
        store.add(str(source))
    (source / "SKILL.md").write_text("---\nname: skills\ndescription: test\n---\nbody")
    with pytest.raises(ValueError, match="重名"):
        store.add(str(source))


def test_symlink_resources_are_not_followed(tmp_path):
    source = make_skill(tmp_path / "user")
    secret = tmp_path / "outside.txt"
    secret.write_text("outside")
    try:
        (source / "secret.txt").symlink_to(secret)
    except OSError:
        pytest.skip("symlinks are unavailable")
    store = SkillStore(tmp_path / "app")
    with pytest.raises(ValueError, match="符号链接"):
        store.add(str(source))
    assert store.list()["items"] == []


def test_copy_failure_keeps_existing_skill_and_cleans_staging(tmp_path, monkeypatch):
    import llm_api_proxy_recorder.admin.skills as skills

    source = make_skill(tmp_path / "user")
    store = SkillStore(tmp_path / "app")
    original = skills.shutil.copytree

    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise OSError("copy failure")

    monkeypatch.setattr(skills.shutil, "copytree", fail)
    with pytest.raises(OSError):
        store.add(str(source))
    assert store.list()["items"] == []
    assert not list(store.root.glob(".skill-import-*"))


@pytest.mark.asyncio
async def test_refresh_waits_for_idle_and_invalidates_native_cache(tmp_path):
    manager = WorkspaceManager()
    statuses = {"ses_1": {"type": "busy"}}
    requests = []

    def respond(request):
        requests.append((request.method, request.url.path))
        return httpx.Response(200, json=statuses if request.url.path == "/session/status" else True)

    client = httpx.AsyncClient(base_url="http://opencode", transport=httpx.MockTransport(respond))
    manager._servers[str(tmp_path)] = OpenCodeServer(SimpleNamespace(poll=lambda: None), client, 1234)
    changes = []
    try:
        with pytest.raises(WorkspaceError) as error:
            await manager.update_skills(lambda: changes.append("changed") or {"ok": True})
        assert error.value.status == 409
        assert not changes
        assert ("POST", "/instance/dispose") not in requests
        statuses.clear()
        assert await manager.update_skills(lambda: changes.append("changed") or {"ok": True}) == {"ok": True}
        assert changes == ["changed"]
        assert requests[-1] == ("POST", "/instance/dispose")
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_projects_run_commands_in_parallel_and_block_skill_mutations(monkeypatch):
    manager = WorkspaceManager()
    both_started = asyncio.Event()
    finish = asyncio.Event()
    started = []

    async def request(project, *_args, **_kwargs):
        started.append(project)
        if len(started) == 2:
            both_started.set()
        await finish.wait()
        return {"ok": True}

    monkeypatch.setattr(manager, "_request", request)
    tasks = [asyncio.create_task(manager.request(project, default_config(), "POST", "/session/ses_1/command"))
             for project in ("one", "two")]
    try:
        await asyncio.wait_for(both_started.wait(), timeout=1)
        with pytest.raises(WorkspaceError) as error:
            await manager.update_skills(lambda: pytest.fail("must not change skills during a command"))
        assert error.value.status == 409
    finally:
        finish.set()
        await asyncio.gather(*tasks)
    assert await manager.update_skills(lambda: {"ok": True}) == {"ok": True}


@pytest.mark.asyncio
async def test_idle_server_restart_fallback_when_dispose_is_unsupported(tmp_path, monkeypatch):
    manager = WorkspaceManager()
    process = SimpleNamespace(poll=lambda: None)
    client = httpx.AsyncClient(base_url="http://opencode", transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={}) if request.url.path == "/session/status" else httpx.Response(404)))
    manager._servers[str(tmp_path)] = OpenCodeServer(process, client, 1234)
    stopped = []

    async def stop(item):
        stopped.append(item)

    monkeypatch.setattr(manager, "_stop_process", stop)
    assert await manager.update_skills(lambda: {"ok": True}) == {"ok": True}
    assert stopped == [process]
    assert str(tmp_path) not in manager._servers
    assert client.is_closed


def test_management_api_and_native_skill_commands(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    app = create_app(default_config(), str(tmp_path / "proxy.json"))
    source = make_skill(tmp_path / "user")
    calls = []

    async def request(project, config, method, endpoint, *, body=None, params=None):
        calls.append((method, endpoint, body))
        if endpoint == "/command":
            return [{"name": item["name"], "source": "skill"} for item in app.state.runtime.skills.list()["items"] if item["enabled"]]
        if endpoint == "/skill":
            return [{"name": item["name"], "location": str(Path(item["path"]) / "SKILL.md")}
                    for item in app.state.runtime.skills.list()["items"] if item["enabled"]]
        return {"ok": True}

    app.state.runtime.workspace.request = request
    project = tmp_path / "project"
    project.mkdir()
    with TestClient(app) as client:
        prefix = "/__recorder/api"
        project_id = client.post(f"{prefix}/workspace/projects", json={"path": str(project)}).json()["id"]
        assert 'data-nav="skills"' in client.get("/__recorder/").text
        assert client.get("/__recorder/skills.js").status_code == 200
        assert client.post(f"{prefix}/skills", json={"path": str(source)}).status_code == 201
        assert client.post(f"{prefix}/skills", json={"path": str(source)}).status_code == 409
        assert client.get(f"{prefix}/skills").json()["total"] == 1
        popup = f"{prefix}/workspace/projects/{project_id}/skills"
        assert client.get(popup).json()["items"][0]["name"] == "code-review"
        command = f"{prefix}/workspace/projects/{project_id}/sessions/ses_1/command"
        payload = {"command": "code-review", "arguments": "review my changes", "agent": "plan",
                   "provider_id": "test", "model_id": "model", "variant": "high"}
        assert client.post(command, json=payload).status_code == 200
        assert calls[-1] == ("POST", "/session/ses_1/command", {
            "command": "code-review", "arguments": "review my changes", "agent": "plan", "model": "test/model", "variant": "high"})
        assert client.patch(f"{prefix}/skills/code-review", json={"enabled": False}).status_code == 200
        assert client.get(popup).json()["items"] == []
        before = len(calls)
        assert client.post(command, json=payload).status_code == 409
        assert len(calls) == before
        assert client.patch(f"{prefix}/skills/code-review", json={"enabled": True}).status_code == 200
        assert client.get(popup).json()["items"][0]["enabled"] is True
        assert client.delete(f"{prefix}/skills/code-review").status_code == 200
        assert client.delete(f"{prefix}/skills/code-review").status_code == 404
        assert source.is_dir()


def test_native_name_collisions_do_not_invoke_another_skill_or_command(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    app = create_app(default_config(), str(tmp_path / "proxy.json"))
    source = make_skill(tmp_path / "user")
    installed = app.state.runtime.skills.add(str(source))
    native = {"source": "skill", "location": str(tmp_path / "project/.opencode/skills/code-review/SKILL.md")}
    invoked = []

    async def request(project, config, method, endpoint, **kwargs):
        if endpoint == "/command":
            return [{"name": "code-review", "source": native["source"]}]
        if endpoint == "/skill":
            return [{"name": "code-review", "location": native["location"]}]
        invoked.append(endpoint)
        return {"ok": True}

    app.state.runtime.workspace.request = request
    project = tmp_path / "project"
    project.mkdir()
    with TestClient(app) as client:
        prefix = "/__recorder/api/workspace/projects"
        project_id = client.post(prefix, json={"path": str(project)}).json()["id"]
        popup = f"{prefix}/{project_id}/skills"
        command = f"{prefix}/{project_id}/sessions/ses_1/command"
        assert client.get(popup).json() == {"items": [], "unavailable": ["code-review"]}
        assert client.post(command, json={"command": "code-review"}).status_code == 409
        assert not invoked
        native["location"] = str(Path(installed["path"]) / "SKILL.md")
        native["source"] = "command"
        assert client.get(popup).json()["items"] == []
        assert client.post(command, json={"command": "code-review"}).status_code == 409
        assert not invoked
        native["source"] = "skill"
        assert client.get(popup).json()["items"][0]["name"] == "code-review"
        alias = tmp_path / "skills-alias"
        try:
            alias.symlink_to(Path(installed["path"]).parent, target_is_directory=True)
        except OSError:
            return  # Windows may not grant symlink creation privileges.
        native["location"] = str(alias / "code-review/SKILL.md")
        assert client.get(popup).json()["items"][0]["name"] == "code-review"
