"""Project and conversation API backed by headless OpenCode."""

from __future__ import annotations

import base64
import binascii
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


@router.get("/workspace/projects/{project_id}/sessions/{session_id}")
async def get_session(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", f"/session/{_safe_id(session_id)}")


class RenameSessionBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.patch("/workspace/projects/{project_id}/sessions/{session_id}")
async def rename_session(project_id: str, session_id: str, body: RenameSessionBody, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "PATCH", f"/session/{_safe_id(session_id)}", {"title": body.title})


@router.delete("/workspace/projects/{project_id}/sessions/{session_id}")
async def delete_session(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "DELETE", f"/session/{_safe_id(session_id)}")


class ForkSessionBody(BaseModel):
    message_id: str | None = None


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/fork")
async def fork_session(project_id: str, session_id: str, body: ForkSessionBody, request: Request):
    path = _project_path(request, project_id)
    payload = {"messageID": _safe_id(body.message_id)} if body.message_id else {}
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/fork", payload)


@router.get("/workspace/projects/{project_id}/sessions/{session_id}/children")
async def session_children(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", f"/session/{_safe_id(session_id)}/children")


@router.get("/workspace/projects/{project_id}/sessions/{session_id}/todo")
async def session_todo(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", f"/session/{_safe_id(session_id)}/todo")


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/share")
async def share_session(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/share", {})


@router.delete("/workspace/projects/{project_id}/sessions/{session_id}/share")
async def unshare_session(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "DELETE", f"/session/{_safe_id(session_id)}/share")


class RevertMessageBody(BaseModel):
    message_id: str = Field(min_length=1)
    part_id: str | None = None


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/revert")
async def revert_message(project_id: str, session_id: str, body: RevertMessageBody, request: Request):
    path = _project_path(request, project_id)
    payload = {"messageID": _safe_id(body.message_id)}
    if body.part_id:
        payload["partID"] = _safe_id(body.part_id)
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/revert", payload)


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/unrevert")
async def unrevert_session(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/unrevert", {})


class SummarizeSessionBody(BaseModel):
    provider_id: str = Field(min_length=1)
    model_id: str = Field(min_length=1)


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/summarize")
async def summarize_session(project_id: str, session_id: str, body: SummarizeSessionBody, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/summarize",
                           {"providerID": body.provider_id, "modelID": body.model_id})


@router.get("/workspace/projects/{project_id}/status")
async def project_status(project_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", "/session/status")


@router.get("/workspace/projects/{project_id}/models")
async def project_models(project_id: str, request: Request):
    path = _project_path(request, project_id)
    data = await _opencode(request, path, "GET", "/config/providers")
    auth = await _opencode(request, path, "GET", "/provider")
    return {
        **(data if isinstance(data, dict) else {}),
        "connected": auth.get("connected", []) if isinstance(auth, dict) else [],
    }


class ProviderApiKeyBody(BaseModel):
    key: str = Field(min_length=1, max_length=10_000)


@router.post("/workspace/projects/{project_id}/providers/{provider_id}/api-key")
async def save_provider_api_key(project_id: str, provider_id: str, body: ProviderApiKeyBody, request: Request):
    path = _project_path(request, project_id)
    await _opencode(request, path, "PUT", f"/auth/{_safe_id(provider_id)}", {"type": "api", "key": body.key})
    return {"ok": True, "provider_id": provider_id, "configured": True}


@router.get("/workspace/projects/{project_id}/agents")
async def project_agents(project_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", "/agent")


@router.get("/workspace/projects/{project_id}/commands")
async def project_commands(project_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", "/command")


@router.get("/workspace/projects/{project_id}/sessions/{session_id}/messages")
async def list_messages(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", f"/session/{_safe_id(session_id)}/message")


class PromptBody(BaseModel):
    text: str = Field(default="", max_length=100_000)
    files: list["PromptFile"] = Field(default_factory=list, max_length=8)
    provider_id: str | None = None
    model_id: str | None = None
    agent: str | None = None
    variant: str | None = Field(default=None, max_length=100)


class PromptFile(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    mime: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1, max_length=14_000_000)


def _prompt_file_part(file: PromptFile) -> tuple[dict, int]:
    # Data URLs come from the browser file picker. Accept only the media types
    # OpenCode can consume, and avoid passing arbitrary URLs to its server.
    if file.mime not in {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"}:
        raise HTTPException(status_code=400, detail="不支持的附件类型")
    if "/" in file.filename or "\\" in file.filename or file.filename in {".", ".."}:
        raise HTTPException(status_code=400, detail="无效的附件名称")
    prefix = f"data:{file.mime};base64,"
    if not file.url.startswith(prefix):
        raise HTTPException(status_code=400, detail="附件必须是匹配 MIME 类型的 base64 数据")
    try:
        decoded = base64.b64decode(file.url[len(prefix):], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=400, detail="附件内容无效") from exc
    if len(decoded) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="单个附件不能超过 8 MB")
    return {"type": "file", "filename": file.filename, "mime": file.mime, "url": file.url}, len(decoded)


def _model_choice(provider_id: str | None, model_id: str | None) -> dict | None:
    if provider_id and model_id:
        return {"providerID": provider_id, "modelID": model_id}
    return None


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/prompt")
async def send_prompt(project_id: str, session_id: str, body: PromptBody, request: Request):
    path = _project_path(request, project_id)
    if not body.text.strip() and not body.files:
        raise HTTPException(status_code=400, detail="请输入消息或添加附件")
    parts = [{"type": "text", "text": body.text}] if body.text.strip() else []
    file_parts = [_prompt_file_part(file) for file in body.files]
    if sum(size for _, size in file_parts) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="附件总大小不能超过 20 MB")
    parts.extend(part for part, _ in file_parts)
    prompt: dict = {"parts": parts}
    model = _model_choice(body.provider_id, body.model_id)
    if model:
        prompt["model"] = model
    if body.agent:
        prompt["agent"] = body.agent
    if body.variant:
        prompt["variant"] = body.variant
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/prompt_async", prompt)


class CommandBody(BaseModel):
    command: str = Field(min_length=1, pattern=r"^[A-Za-z0-9_-]+$")
    arguments: str = Field(default="", max_length=100_000)
    provider_id: str | None = None
    model_id: str | None = None
    agent: str | None = None
    variant: str | None = Field(default=None, max_length=100)


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/command")
async def run_command(project_id: str, session_id: str, body: CommandBody, request: Request):
    path = _project_path(request, project_id)
    payload: dict = {"command": body.command, "arguments": body.arguments}
    if body.provider_id and body.model_id:
        payload["model"] = f"{body.provider_id}/{body.model_id}"
    if body.agent:
        payload["agent"] = body.agent
    if body.variant:
        payload["variant"] = body.variant
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/command", payload)


class ShellBody(BaseModel):
    command: str = Field(min_length=1, max_length=100_000)
    agent: str = Field(default="build", min_length=1)
    provider_id: str | None = None
    model_id: str | None = None


@router.post("/workspace/projects/{project_id}/sessions/{session_id}/shell")
async def run_shell(project_id: str, session_id: str, body: ShellBody, request: Request):
    path = _project_path(request, project_id)
    payload: dict = {"command": body.command, "agent": body.agent}
    model = _model_choice(body.provider_id, body.model_id)
    if model:
        payload["model"] = model
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/shell", payload)


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


@router.get("/workspace/projects/{project_id}/questions")
async def list_questions(project_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", "/question")


class QuestionReplyBody(BaseModel):
    answers: list[list[str]] = Field(min_length=1, max_length=20)


@router.post("/workspace/projects/{project_id}/questions/{question_id}/reply")
async def reply_question(project_id: str, question_id: str, body: QuestionReplyBody, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "POST", f"/question/{_safe_id(question_id)}/reply", {"answers": body.answers})


@router.post("/workspace/projects/{project_id}/questions/{question_id}/reject")
async def reject_question(project_id: str, question_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "POST", f"/question/{_safe_id(question_id)}/reject", {})


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
