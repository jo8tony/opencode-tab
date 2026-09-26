"""Project and conversation API backed by headless OpenCode."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request
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
    return {"id": _project_id(path), "path": path, "name": item.get("name") or Path(path).name or path}


def _project_path(request: Request, project_id: str) -> str:
    for item in request.app.state.runtime.terminal_projects.list():
        if _project_id(item["path"]) == project_id:
            return str(Path(item["path"]).expanduser().resolve())
    raise HTTPException(status_code=404, detail="项目不存在")


def _safe_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise HTTPException(status_code=400, detail="无效的会话或权限 ID")
    return quote(value, safe="")


async def _opencode(
    request: Request, project: str, method: str, endpoint: str,
    body: dict | None = None, params: dict[str, str | int] | None = None,
):
    try:
        return await request.app.state.runtime.workspace.request(
            project, request.app.state.runtime.config, method, endpoint, body=body, params=params,
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


class RenameProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@router.patch("/workspace/projects/{project_id}")
def rename_project(project_id: str, body: RenameProjectBody, request: Request) -> dict:
    path = _project_path(request, project_id)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="请输入工作区名称")
    item = request.app.state.runtime.terminal_projects.rename(path, name)
    if item is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    return _project_info(item)


@router.post("/workspace/projects/{project_id}/open")
def open_project_directory(project_id: str, request: Request) -> dict:
    path = _project_path(request, project_id)
    if not Path(path).is_dir():
        raise HTTPException(status_code=404, detail="项目目录不存在")
    command = ["open", path] if sys.platform == "darwin" else (
        ["explorer", path] if os.name == "nt" else ["xdg-open", path]
    )
    try:
        subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"无法打开目录：{exc.strerror or exc}") from exc
    return {"ok": True}


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
    session = _safe_id(session_id)
    payload = {}
    if body.message_id:
        message_id = _safe_id(body.message_id)
        messages = await _opencode(request, path, "GET", f"/session/{session}/message")
        index = next((i for i, message in enumerate(messages)
                      if message.get("info", {}).get("id") == message_id), None)
        if index is None:
            raise HTTPException(status_code=404, detail="分支消息不存在")
        # OpenCode excludes the boundary message. Use the next message to retain
        # the selected reply; omitting the boundary retains the final reply.
        if index + 1 < len(messages):
            payload["messageID"] = _safe_id(messages[index + 1]["info"]["id"])
    return await _opencode(request, path, "POST", f"/session/{session}/fork", payload)


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


@router.get("/workspace/projects/{project_id}/files")
async def search_project_files(
    project_id: str, request: Request, query: str = Query(default="", max_length=200),
):
    root = Path(_project_path(request, project_id)).resolve()
    matches = await _opencode(
        request, str(root), "GET", "/find/file",
        params={"query": query, "type": "file", "limit": 30},
    )
    if not isinstance(matches, list):
        return {"items": []}

    items = []
    for match in matches:
        if not isinstance(match, str) or not match or "\x00" in match:
            continue
        normalized = match.replace("\\", "/")
        segments = normalized.split("/")
        if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized) or any(
            part in {"", ".", ".."} for part in segments
        ):
            continue
        try:
            candidate = root.joinpath(*segments).resolve(strict=True)
            candidate.relative_to(root)
        except (OSError, ValueError):
            continue
        if candidate.is_file():
            items.append("/".join(segments))
    return {"items": list(dict.fromkeys(items))}


@router.get("/workspace/projects/{project_id}/sessions/{session_id}/messages")
async def list_messages(project_id: str, session_id: str, request: Request):
    path = _project_path(request, project_id)
    return await _opencode(request, path, "GET", f"/session/{_safe_id(session_id)}/message")


class PromptBody(BaseModel):
    text: str = Field(default="", max_length=100_000)
    files: list["PromptFile"] = Field(default_factory=list, max_length=8)
    references: list["PromptReference"] = Field(default_factory=list, max_length=8)
    provider_id: str | None = None
    model_id: str | None = None
    agent: str | None = None
    variant: str | None = Field(default=None, max_length=100)


class PromptFile(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    mime: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1, max_length=14_000_000)


class PromptReference(BaseModel):
    path: str = Field(min_length=1, max_length=1_000)


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
    if len(body.files) + len(body.references) > 8:
        raise HTTPException(status_code=400, detail="一条消息最多添加 8 个附件或文件引用")
    if not body.text.strip() and not body.files and not body.references:
        raise HTTPException(status_code=400, detail="请输入消息或添加附件")
    parts = [{"type": "text", "text": body.text}] if body.text.strip() else []
    file_parts = [_prompt_file_part(file) for file in body.files]
    if sum(size for _, size in file_parts) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="附件总大小不能超过 20 MB")
    parts.extend(part for part, _ in file_parts)
    project_root = Path(path).resolve()
    references = set()
    for reference in body.references:
        if "\\" in reference.path or "\x00" in reference.path or re.match(r"^[A-Za-z]:", reference.path):
            raise HTTPException(status_code=400, detail="无效的项目文件路径")
        relative = Path(reference.path)
        if relative.is_absolute() or any(part in {".", ".."} for part in relative.parts):
            raise HTTPException(status_code=400, detail="无效的项目文件路径")
        try:
            candidate = (project_root / relative).resolve(strict=True)
            candidate.relative_to(project_root)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="文件不存在或不在当前项目内") from exc
        if not candidate.is_file():
            raise HTTPException(status_code=400, detail="引用路径不是文件")
        relative_name = candidate.relative_to(project_root).as_posix()
        if relative_name in references:
            continue
        references.add(relative_name)
        parts.append({
            "type": "file", "filename": relative_name, "mime": "text/plain",
            "url": candidate.as_uri(),
        })
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
    installed = await asyncio.to_thread(request.app.state.runtime.skills.list)
    managed = next((item for item in installed["items"]
                    if item["name"] == body.command), None)
    if managed:
        if not managed["enabled"] or managed.get("error"):
            raise HTTPException(status_code=409, detail="该技能已停用或格式无效，请重新选择技能")
        available = await _native_managed_skill_names(request, path, [managed])
        if body.command not in available:
            raise HTTPException(status_code=409, detail="OpenCode 未加载该技能或存在同名技能/命令，请检查配置")
    payload: dict = {"command": body.command, "arguments": body.arguments}
    if body.provider_id and body.model_id:
        payload["model"] = f"{body.provider_id}/{body.model_id}"
    if body.agent:
        payload["agent"] = body.agent
    if body.variant:
        payload["variant"] = body.variant
    return await _opencode(request, path, "POST", f"/session/{_safe_id(session_id)}/command", payload)


async def _native_managed_skill_names(request: Request, path: str, installed: list[dict]) -> set[str]:
    commands, skills = await asyncio.gather(
        _opencode(request, path, "GET", "/command"),
        _opencode(request, path, "GET", "/skill"),
    )
    names = {item.get("name") for item in commands
             if isinstance(item, dict) and item.get("source") == "skill"}
    def matching_locations() -> set[str]:
        def canonical(value: str | Path) -> str:
            return os.path.normcase(str(Path(value).resolve()))

        locations = {item.get("name"): canonical(item["location"])
                     for item in skills if isinstance(item, dict) and isinstance(item.get("location"), str)}
        return {item["name"] for item in installed if item["name"] in names and
                locations.get(item["name"]) == canonical(Path(item["path"]) / "SKILL.md")}

    return await asyncio.to_thread(matching_locations)


@router.get("/workspace/projects/{project_id}/skills")
async def project_skills(project_id: str, request: Request) -> dict:
    path = _project_path(request, project_id)
    installed = await asyncio.to_thread(request.app.state.runtime.skills.list)
    enabled = [item for item in installed["items"]
               if item["enabled"] and not item.get("error")]
    names = await _native_managed_skill_names(request, path, enabled)
    return {"items": [item for item in enabled if item["name"] in names],
            "unavailable": [item["name"] for item in enabled if item["name"] not in names]}


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
