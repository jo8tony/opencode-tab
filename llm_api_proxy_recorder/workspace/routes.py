"""Project and conversation API backed by headless OpenCode."""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from llm_api_proxy_recorder.terminal.manager import resolve_opencode
from llm_api_proxy_recorder.workspace.manager import WorkspaceError

router = APIRouter()


def _project_id(path: str) -> str:
    normalized = os.path.normcase(str(Path(path).expanduser().resolve()))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:20]


def _project_info(item: dict) -> dict:
    path = str(Path(item["path"]).expanduser().resolve())
    return {"id": _project_id(path), "path": path, "name": Path(path).name or path}


def _project_path(request: Request, project_id: str) -> str:
    for item in request.app.state.runtime.terminal_projects.list():
        if _project_id(item["path"]) == project_id:
            return str(Path(item["path"]).expanduser().resolve())
    raise HTTPException(status_code=404, detail="项目不存在")


def _safe_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise HTTPException(status_code=400, detail="无效的会话或权限 ID")
    return quote(value, safe="")


async def _opencode(request: Request, project: str, method: str, endpoint: str, body: dict | None = None):
    try:
        return await request.app.state.runtime.workspace.request(
            project, request.app.state.runtime.config, method, endpoint, body=body,
        )
    except WorkspaceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.get("/workspace/check")
def check(request: Request) -> dict:
    config = request.app.state.runtime.config
    resolution = resolve_opencode(config)
    terminal = config.terminal
    return {
        "found": bool(resolution.path), "source": resolution.source,
        "provider_hint": terminal.opencode_provider or terminal.proxy_upstream or config.default_upstream,
    }


@router.get("/workspace/projects")
def list_projects(request: Request) -> dict:
    items = [_project_info(item) for item in request.app.state.runtime.terminal_projects.list()]
    return {"items": items, "total": len(items)}


class AddProjectBody(BaseModel):
    path: str = Field(min_length=1)


@router.post("/workspace/projects", status_code=201)
def add_project(body: AddProjectBody, request: Request) -> dict:
    path = Path(body.path).expanduser().resolve()
    if not path.is_dir():
        raise HTTPException(status_code=400, detail="项目目录不存在")
    projects = request.app.state.runtime.terminal_projects
    existing = next((item for item in projects.list() if item["path"] == str(path)), None)
    kind = existing.get("kind", "opencode") if existing else "opencode"
    item = projects.add(str(path), kind)
    return _project_info(item)


@router.delete("/workspace/projects/{project_id}")
async def remove_project(project_id: str, request: Request) -> dict:
    path = _project_path(request, project_id)
    deleted = request.app.state.runtime.terminal_projects.delete(path)
    await request.app.state.runtime.workspace.stop(path)
    return {"ok": deleted}


@router.get("/workspace/projects/{project_id}/sessions")
async def list_sessions(project_id: str, request: Request):
    path = _project_path(request, project_id)
    data = await _opencode(request, path, "GET", "/session")
    return {"items": data if isinstance(data, list) else []}


class CreateSessionBody(BaseModel):
    title: str | None = Field(default=None, max_length=200)


@router.post("/workspace/projects/{project_id}/sessions", status_code=201)
async def create_session(project_id: str, body: CreateSessionBody, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "POST", "/session", {"title": body.title} if body.title else {})


@router.get("/workspace/projects/{project_id}/status")
async def project_status(project_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", "/session/status")


@router.get("/workspace/projects/{project_id}/models")
async def project_models(project_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", "/config/providers")


@router.get("/workspace/projects/{project_id}/sessions/{session_id}/messages")
async def list_messages(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", f"/session/{_safe_id(session_id)}/message")


class PromptBody(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    provider_id: str | None = None
    model_id: str | None = None


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/prompt")
async def send_prompt(project_id: str, session_id: str, body: PromptBody, request: Request):
    path = _project_path(request, project_id)
    prompt: dict = {"parts": [{"type": "text", "text": body.text}]}
    if body.provider_id and body.model_id:
        prompt["model"] = {"providerID": body.provider_id, "modelID": body.model_id}
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/prompt_async", prompt)


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/abort")
async def abort_session(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/abort", {})


@router.get("/workspace/projects/{project_id}/sessions/{session_id}/diff")
async def session_diff(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", f"/session/{_safe_id(session_id)}/diff")


@router.get("/workspace/projects/{project_id}/permissions")
async def list_permissions(project_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", "/permission")


class PermissionReplyBody(BaseModel):
    reply: str = Field(pattern="^(once|always|reject)$")


@router.post("/workspace/projects/{project_id}/permissions/{permission_id}/reply")
async def reply_permission(project_id: str, permission_id: str, body: PermissionReplyBody, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "POST", f"/permission/{_safe_id(permission_id)}/reply", {"reply": body.reply})


@router.get("/workspace/projects/{project_id}/events")
async def project_events(project_id: str, request: Request) -> StreamingResponse:
    path = _project_path(request, project_id)
    try:
        await request.app.state.runtime.workspace.ensure(path, request.app.state.runtime.config)
    except WorkspaceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return StreamingResponse(
        request.app.state.runtime.workspace.events(path, request.app.state.runtime.config),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
