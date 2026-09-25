"use strict";
/* Headless OpenCode workspace. The existing proxy record pages remain separate. */

let workspaceSelection = { projectId: null, sessionId: null };

function renderWorkspace(view) {
  let disposed = false;
  let events = null;
  let eventProjectId = null;
  let refreshTimer = null;
  let refreshing = false;
  let refreshRequested = false;
  let lastSessionListRefresh = 0;
  const state = {
    projects: [], sessions: new Map(), errors: new Map(),
    projectId: workspaceSelection.projectId, sessionId: workspaceSelection.sessionId,
    messages: [], permissions: [], diffs: [], statuses: {},
    check: null, tab: "chat", search: "", sending: false, chosenModels: new Map(),
  };

  view.innerHTML = `
    <section class="wsp" id="wsp">
      <aside class="wsp-side" aria-label="项目与对话">
        <div class="wsp-side-top">
          <div class="wsp-side-title"><span>项目与对话</span><span id="wsp-project-count"></span></div>
          <div class="wsp-side-actions"><button class="wsp-new" id="wsp-new" type="button">＋ 新建对话</button><button class="wsp-add" id="wsp-add" type="button" title="添加项目" aria-label="添加项目">＋</button></div>
          <input class="wsp-search" id="wsp-search" type="search" placeholder="搜索项目和对话" aria-label="搜索项目和对话">
        </div>
        <div class="wsp-side-list"><div class="wsp-side-label"><span>工作区</span><span>OpenCode</span></div><div id="wsp-projects"></div></div>
        <div class="wsp-side-bottom" id="wsp-connection">正在检查 OpenCode…</div>
      </aside>
      <div class="wsp-main">
        <header class="wsp-head"><button class="wsp-menu" id="wsp-menu" type="button" aria-label="打开项目栏">☰</button><div class="wsp-head-text"><div class="wsp-breadcrumb" id="wsp-breadcrumb">工作区</div><div class="wsp-title" id="wsp-title">选择项目</div></div><button class="wsp-abort" id="wsp-abort" type="button" hidden>停止任务</button><span class="wsp-status" id="wsp-status">准备中</span></header>
        <nav class="wsp-tabs" aria-label="对话视图"><button class="wsp-tab active" type="button" data-wsp-tab="chat">对话</button><button class="wsp-tab" type="button" data-wsp-tab="changes">文件改动</button><button class="wsp-tab" type="button" data-wsp-tab="activity">活动</button></nav>
        <div class="wsp-scroll" id="wsp-scroll"><div class="wsp-content" id="wsp-content"></div></div>
        <div class="wsp-composer-dock"><form class="wsp-composer" id="wsp-form"><textarea class="wsp-input" id="wsp-input" placeholder="描述你想完成的开发任务…" aria-label="输入消息" rows="2"></textarea><div class="wsp-composer-bottom"><select class="wsp-model" id="wsp-model" aria-label="选择模型"><option value="">OpenCode 默认模型</option></select><span class="wsp-composer-hint">Enter 发送 · Shift+Enter 换行</span><span class="wsp-composer-spacer"></span><button class="wsp-send" id="wsp-send" type="submit" title="发送消息" aria-label="发送消息">➜</button></div></form><div class="wsp-composer-note">OpenCode 可在项目目录中读写文件并执行命令；请核对权限请求。</div></div>
      </div>
    </section>`;

  const root = view.querySelector("#wsp");
  const sideList = view.querySelector("#wsp-projects");
  const content = view.querySelector("#wsp-content");
  const scroll = view.querySelector("#wsp-scroll");
  const input = view.querySelector("#wsp-input");
  const modelSelect = view.querySelector("#wsp-model");
  const sessionPath = (projectId, sessionId) =>
    `workspace/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
  const alive = () => !disposed && view.isConnected && (!location.hash || location.hash === "#/workspace");

  addCleanup(() => {
    disposed = true;
    if (events) events.close();
    if (refreshTimer) clearTimeout(refreshTimer);
    clearInterval(poll);
  });

  function activeProject() { return state.projects.find((item) => item.id === state.projectId); }
  function activeSession() {
    return (state.sessions.get(state.projectId) || []).find((item) => item.id === state.sessionId);
  }
  function stamp(session) {
    const value = session?.time?.updated || session?.time?.created;
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }
  function detail(error) { return error?.detail ? format422(error.detail) : error?.message || String(error); }

  function renderSidebar() {
    sideList.replaceChildren();
    view.querySelector("#wsp-project-count").textContent = `${state.projects.length} 个项目`;
    const query = state.search.trim().toLocaleLowerCase();
    for (const project of state.projects) {
      const all = state.sessions.get(project.id);
      const sessions = (all || []).filter((session) => !query || String(session.title || "新对话").toLocaleLowerCase().includes(query));
      if (query && !project.name.toLocaleLowerCase().includes(query) && !sessions.length) continue;
      const section = el("section", { class: "wsp-project" });
      const heading = el("button", { class: "wsp-project-head", type: "button", title: project.path,
        onclick: () => selectProject(project.id) },
        el("span", { class: "wsp-project-mark", text: (project.name || "P").slice(0, 2).toUpperCase() }),
        el("span", { class: "wsp-project-name", text: project.name }),
        el("span", { class: "wsp-project-count", text: all ? String(all.length) : "…" }),
        el("span", { class: "wsp-project-chevron", text: "⌄" }));
      section.append(heading);
      const threads = el("div", { class: "wsp-threads" });
      if (state.errors.has(project.id)) {
        threads.append(el("div", { class: "wsp-error", text: state.errors.get(project.id) }));
      } else if (!all) {
        threads.append(el("div", { class: "wsp-thread-time", text: "点击项目读取对话" }));
      } else if (all && !sessions.length) {
        threads.append(el("div", { class: "wsp-thread-time", text: query ? "无匹配对话" : "暂无对话" }));
      }
      for (const session of sessions) {
        threads.append(el("button", {
          class: "wsp-thread" + (project.id === state.projectId && session.id === state.sessionId ? " active" : ""),
          type: "button", title: session.title || "新对话",
          onclick: () => selectSession(project.id, session.id),
        }, el("span", { class: "wsp-thread-title", text: session.title || "新对话" }),
        el("span", { class: "wsp-thread-time", text: stamp(session) })));
      }
      section.append(threads);
      sideList.append(section);
    }
    if (!state.projects.length) sideList.append(el("div", { class: "wsp-empty", style: "min-height:200px" },
      el("p", { text: "还没有项目。点击上方 ＋ 添加项目目录。" })));
  }

  function renderHeader() {
    const project = activeProject();
    const session = activeSession();
    view.querySelector("#wsp-breadcrumb").textContent = project ? `${project.name} / 对话记录` : "工作区";
    view.querySelector("#wsp-title").textContent = session?.title || (project ? "新建或选择对话" : "选择项目");
    const status = state.statuses?.[state.sessionId];
    const pending = state.permissions.some((item) => item.sessionID === state.sessionId);
    const label = view.querySelector("#wsp-status");
    label.className = "wsp-status" + (pending ? " attention" : status?.type === "busy" ? " busy" : "");
    label.textContent = pending ? "等待确认" : status?.type === "busy" ? "正在处理" : state.check?.found ? "已就绪" : "未检测到 OpenCode";
    view.querySelector("#wsp-abort").hidden = status?.type !== "busy";
    view.querySelectorAll(".wsp-tab").forEach((button) => button.classList.toggle("active", button.dataset.wspTab === state.tab));
    view.querySelector("#wsp-send").disabled = state.sending || !project || !state.check?.found;
    view.querySelector("#wsp-new").disabled = !state.projects.length || !state.check?.found;
  }

  function empty(title, description, action) {
    const box = el("div", { class: "wsp-empty" }, el("div", { class: "wsp-empty-icon", text: "✦" }),
      el("h2", { text: title }), el("p", { text: description }));
    if (action) box.append(el("button", { class: "wsp-mini primary", style: "margin-top:14px", type: "button", text: action[0], onclick: action[1] }));
    return box;
  }

  function textPart(part) { return el("div", { class: "wsp-part wsp-text", text: part.text || "" }); }
  function toolPart(part) {
    const stateInfo = part.state || {};
    const title = `${part.tool || "工具"} · ${stateInfo.status || "运行中"}`;
    const card = el("div", { class: "wsp-tool" }, el("div", { class: "wsp-tool-head", text: title }));
    const rawOutput = stateInfo.output || stateInfo.error || "";
    const output = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2);
    const inputText = stateInfo.input ? JSON.stringify(stateInfo.input, null, 2) : "";
    card.append(el("div", { class: "wsp-tool-body", text: (output || inputText || "等待结果…").slice(0, 6000) }));
    return card;
  }

  function renderMessages() {
    if (!state.sessionId) {
      content.append(empty("开始一段新对话", "选择项目后新建对话，OpenCode 会在该项目目录中工作。",
        activeProject() ? ["新建对话", createSession] : ["添加项目", openAddProject]));
      return;
    }
    if (!state.messages.length && !state.permissions.length) {
      content.append(empty("输入你的开发需求", "发送第一条消息后，这里会实时显示回复和工具操作。"));
      return;
    }
    for (const message of state.messages) {
      const role = message?.info?.role || "assistant";
      const row = el("article", { class: "wsp-message " + (role === "user" ? "user" : "assistant") });
      if (role !== "user") row.append(el("div", { class: "wsp-avatar", text: "◇" }));
      const body = el("div", { class: "wsp-message-inner" });
      if (role !== "user") body.append(el("div", { class: "wsp-message-meta" }, el("strong", { text: "Sona" }), "OpenCode"));
      for (const part of message.parts || []) {
        if (part.type === "text") body.append(textPart(part));
        else if (part.type === "tool") body.append(toolPart(part));
        else if (part.type === "reasoning" && part.text) {
          const reasoning = el("details", { class: "wsp-reasoning" }, el("summary", { text: "思考过程" }), el("div", { text: part.text }));
          body.append(reasoning);
        } else if (part.type === "file") body.append(el("div", { class: "wsp-part", text: `附件：${part.filename || part.url || "文件"}` }));
      }
      row.append(body);
      content.append(row);
    }
    for (const permission of state.permissions.filter((item) => item.sessionID === state.sessionId)) {
      const card = el("div", { class: "wsp-permission" },
        el("strong", { text: `需要确认：${permission.permission || permission.action || "工具操作"}` }),
        el("p", { text: (permission.patterns || permission.resources || []).join("、") || "OpenCode 请求继续执行此操作。" }));
      const actions = el("div", { class: "wsp-permission-actions" });
      for (const [label, reply, cls] of [["允许一次", "once", "wsp-mini primary"], ["拒绝", "reject", "wsp-mini"]]) {
        actions.append(el("button", { class: cls, type: "button", text: label, onclick: () => replyPermission(permission.id, reply) }));
      }
      card.append(actions);
      content.append(card);
    }
  }

  function renderChanges() {
    content.append(el("h2", { class: "wsp-section-title", text: "文件改动" }),
      el("p", { class: "wsp-section-note", text: "由 OpenCode 会话提供的文件差异。" }));
    if (!state.sessionId || !state.diffs.length) {
      content.append(empty("暂无文件改动", "OpenCode 修改文件后，这里会显示改动摘要。"));
      return;
    }
    for (const diff of state.diffs) {
      const title = diff.file || diff.path || "文件";
      const count = `+${diff.additions || 0}  −${diff.deletions || 0}`;
      const card = el("div", { class: "wsp-diff-file" },
        el("div", { class: "wsp-diff-head" }, el("span", { text: title }), el("span", { text: count })));
      if (diff.patch) card.append(el("div", { class: "wsp-diff-content", text: String(diff.patch).slice(0, 12000) }));
      else if (diff.after) card.append(el("div", { class: "wsp-diff-content", text: String(diff.after).slice(0, 12000) }));
      content.append(card);
    }
  }

  function renderActivity() {
    content.append(el("h2", { class: "wsp-section-title", text: "对话活动" }),
      el("p", { class: "wsp-section-note", text: "当前对话的工具步骤。顶部“轨迹”菜单继续显示代理录制的模型调用轨迹。" }));
    let count = 0;
    for (const message of state.messages) {
      for (const part of message.parts || []) {
        if (part.type === "tool") { content.append(toolPart(part)); count++; }
      }
    }
    if (!count) content.append(empty("暂无工具活动", "OpenCode 调用工具时，这里会按顺序展示。"));
  }

  function renderMain() {
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
    content.replaceChildren();
    if (state.tab === "chat") renderMessages();
    if (state.tab === "changes") renderChanges();
    if (state.tab === "activity") renderActivity();
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  async function loadSessions(project) {
    try {
      const data = await api(`workspace/projects/${encodeURIComponent(project.id)}/sessions`, { silent: true });
      if (!alive()) return;
      const items = (data.items || []).filter((item) => !item.parentID && !item.time?.archived);
      items.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
      state.sessions.set(project.id, items);
      if (state.projectId === project.id) lastSessionListRefresh = Date.now();
      state.errors.delete(project.id);
      if (state.projectId === project.id && !items.some((item) => item.id === state.sessionId)) {
        state.sessionId = items[0]?.id || null;
        workspaceSelection.sessionId = state.sessionId;
        refreshSelected();
      }
      renderSidebar();
      renderHeader();
    } catch (error) {
      if (!alive()) return;
      state.errors.set(project.id, detail(error));
      renderSidebar();
      if (state.projectId === project.id) {
        content.replaceChildren(el("div", { class: "wsp-error", text: detail(error) }));
      }
    }
  }

  async function loadModels(projectId) {
    modelSelect.replaceChildren(el("option", { value: "", text: "OpenCode 默认模型" }));
    if (!projectId) return;
    try {
      const data = await api(`workspace/projects/${encodeURIComponent(projectId)}/models`, { silent: true });
      if (!alive() || state.projectId !== projectId) return;
      const providers = data.providers || [];
      const preferred = providers.filter((item) => item.id === state.check?.provider_hint);
      const candidates = preferred.length ? preferred : providers.filter((item) => data.default?.[item.id]);
      for (const provider of candidates.slice(0, 8)) {
        for (const modelId of Object.keys(provider.models || {}).slice(0, 100)) {
          const value = `${provider.id}\u0000${modelId}`;
          modelSelect.append(el("option", { value, text: `${provider.id} / ${modelId}` }));
        }
      }
      modelSelect.value = state.chosenModels.get(projectId) || "";
    } catch (_) { /* OpenCode 默认模型仍可使用 */ }
  }

  function connectEvents(projectId) {
    if (eventProjectId === projectId) return;
    if (events) events.close();
    events = null;
    eventProjectId = projectId;
    if (!projectId || typeof EventSource === "undefined") return;
    events = new EventSource(`api/workspace/projects/${encodeURIComponent(projectId)}/events`);
    events.onmessage = (event) => {
      scheduleRefresh();
      try {
        const update = JSON.parse(event.data);
        if (update.type === "session.updated" && Date.now() - lastSessionListRefresh > 700) {
          const project = activeProject();
          if (project) loadSessions(project);
        }
      } catch (_) { /* A malformed event should not interrupt updates. */ }
    };
    events.onerror = () => { /* EventSource reconnects; polling also remains active. */ };
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshSelected(); }, 120);
  }

  async function refreshSelected() {
    if (!alive() || !state.projectId || !state.sessionId) return;
    if (refreshing) { refreshRequested = true; return; }
    refreshing = true;
    const projectId = state.projectId;
    const sessionId = state.sessionId;
    const base = sessionPath(projectId, sessionId);
    try {
      const [messages, statuses, permissions, diffs] = await Promise.allSettled([
        api(`${base}/messages`, { silent: true }),
        api(`workspace/projects/${encodeURIComponent(projectId)}/status`, { silent: true }),
        api(`workspace/projects/${encodeURIComponent(projectId)}/permissions`, { silent: true }),
        state.tab === "changes" ? api(`${base}/diff`, { silent: true }) : Promise.resolve(state.diffs),
      ]);
      if (!alive() || state.projectId !== projectId || state.sessionId !== sessionId) return;
      if (messages.status === "fulfilled") state.messages = Array.isArray(messages.value) ? messages.value : [];
      if (statuses.status === "fulfilled") state.statuses = statuses.value || {};
      if (permissions.status === "fulfilled") state.permissions = Array.isArray(permissions.value) ? permissions.value : [];
      if (diffs.status === "fulfilled") state.diffs = Array.isArray(diffs.value) ? diffs.value : [];
      if (messages.status === "rejected") content.replaceChildren(el("div", { class: "wsp-error", text: detail(messages.reason) }));
      else renderMain();
      renderHeader();
    } finally {
      refreshing = false;
      if (refreshRequested) { refreshRequested = false; scheduleRefresh(); }
    }
  }

  function selectProject(projectId) {
    state.projectId = projectId;
    const remembered = workspaceSelection.projectId === projectId ? workspaceSelection.sessionId : null;
    state.sessionId = remembered || (state.sessions.get(projectId) || [])[0]?.id || null;
    state.messages = []; state.permissions = []; state.diffs = [];
    state.tab = "chat";
    workspaceSelection = { projectId, sessionId: state.sessionId };
    root.classList.remove("show-side");
    renderSidebar(); renderHeader(); renderMain();
    connectEvents(projectId);
    loadModels(projectId);
    if (!state.sessions.has(projectId)) {
      const project = activeProject();
      if (project) loadSessions(project);
    } else refreshSelected();
  }

  function selectSession(projectId, sessionId) {
    state.projectId = projectId;
    state.sessionId = sessionId;
    state.messages = []; state.permissions = []; state.diffs = [];
    state.tab = "chat";
    workspaceSelection = { projectId, sessionId };
    root.classList.remove("show-side");
    renderSidebar(); renderHeader(); renderMain();
    connectEvents(projectId);
    loadModels(projectId);
    refreshSelected();
  }

  async function createSession() {
    const projectId = state.projectId || state.projects[0]?.id;
    if (!projectId) { openAddProject(); return; }
    try {
      const session = await api(`workspace/projects/${encodeURIComponent(projectId)}/sessions`, {
        method: "POST", body: {}, silent: true,
      });
      if (!alive()) return;
      const items = state.sessions.get(projectId) || [];
      state.sessions.set(projectId, [session, ...items.filter((item) => item.id !== session.id)]);
      selectSession(projectId, session.id);
      input.focus();
    } catch (error) { toast("新建对话失败：" + detail(error), "error"); }
  }

  async function replyPermission(permissionId, reply) {
    try {
      await api(`workspace/projects/${encodeURIComponent(state.projectId)}/permissions/${encodeURIComponent(permissionId)}/reply`, {
        method: "POST", body: { reply }, silent: true,
      });
      await refreshSelected();
    } catch (error) { toast("权限处理失败：" + detail(error), "error"); }
  }

  function openAddProject() {
    const pathInput = el("input", { type: "text", placeholder: "项目目录的绝对路径", autocomplete: "off", spellcheck: "false" });
    const errorLine = el("div", { class: "wsp-error hidden" });
    const choose = el("button", { class: "wsp-mini", type: "button", text: "选择目录…", onclick: async () => {
      const dialog = window.__TAURI__?.dialog;
      if (!dialog?.open) { pathInput.focus(); return; }
      try {
        const selected = await dialog.open({ directory: true, multiple: false, title: "选择项目目录" });
        if (selected) pathInput.value = selected;
      } catch (error) { errorLine.textContent = detail(error); errorLine.classList.remove("hidden"); }
    } });
    if (!window.__TAURI__?.dialog?.open) choose.hidden = true;
    const mask = el("div", { class: "wsp-modal-mask" },
      el("div", { class: "wsp-modal" }, el("h2", { text: "添加项目" }),
        el("p", { text: "选择一个本地项目目录。OpenCode 会在该目录启动后台服务并读取会话。" }),
        el("div", { class: "wsp-modal-row" }, pathInput, choose), errorLine,
        el("div", { class: "wsp-modal-actions" },
          el("button", { class: "wsp-mini", type: "button", text: "取消", onclick: () => mask.remove() }),
          el("button", { class: "wsp-mini primary", type: "button", text: "添加项目", onclick: async () => {
            const path = pathInput.value.trim();
            if (!path) { errorLine.textContent = "请选择或填写项目目录"; errorLine.classList.remove("hidden"); return; }
            try {
              const project = await api("workspace/projects", { method: "POST", body: { path }, silent: true });
              if (!alive()) return;
              mask.remove();
              state.projects = [project, ...state.projects.filter((item) => item.id !== project.id)];
              selectProject(project.id);
              loadSessions(project);
            } catch (error) { errorLine.textContent = detail(error); errorLine.classList.remove("hidden"); }
          } }))));
    mask.addEventListener("click", (event) => { if (event.target === mask) mask.remove(); });
    document.body.append(mask);
    pathInput.focus();
  }

  view.querySelector("#wsp-add").addEventListener("click", openAddProject);
  view.querySelector("#wsp-new").addEventListener("click", createSession);
  view.querySelector("#wsp-abort").addEventListener("click", async () => {
    if (!state.projectId || !state.sessionId) return;
    try {
      await api(`${sessionPath(state.projectId, state.sessionId)}/abort`, { method: "POST", body: {}, silent: true });
      await refreshSelected();
    } catch (error) { toast("停止任务失败：" + detail(error), "error"); }
  });
  view.querySelector("#wsp-menu").addEventListener("click", () => root.classList.toggle("show-side"));
  view.querySelector("#wsp-search").addEventListener("input", (event) => { state.search = event.target.value; renderSidebar(); });
  modelSelect.addEventListener("change", () => {
    if (state.projectId) state.chosenModels.set(state.projectId, modelSelect.value);
  });
  view.querySelectorAll(".wsp-tab").forEach((button) => button.addEventListener("click", () => {
    state.tab = button.dataset.wspTab;
    renderHeader(); renderMain();
    if (state.tab === "changes") refreshSelected();
  }));
  view.querySelector("#wsp-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || state.sending) return;
    if (!state.projectId) { openAddProject(); return; }
    if (!state.check?.found) { toast("未找到 OpenCode，请在设置中配置程序路径", "error"); return; }
    state.sending = true; renderHeader();
    try {
      if (!state.sessionId) {
        const session = await api(`workspace/projects/${encodeURIComponent(state.projectId)}/sessions`, { method: "POST", body: {}, silent: true });
        const items = state.sessions.get(state.projectId) || [];
        state.sessions.set(state.projectId, [session, ...items]);
        state.sessionId = session.id;
        workspaceSelection.sessionId = session.id;
        connectEvents(state.projectId);
      }
      const model = modelSelect.value.split("\u0000");
      const body = { text };
      if (model.length === 2) { body.provider_id = model[0]; body.model_id = model[1]; }
      await api(`${sessionPath(state.projectId, state.sessionId)}/prompt`, { method: "POST", body, silent: true });
      if (!alive()) return;
      input.value = "";
      await loadSessions(activeProject());
      await refreshSelected();
    } catch (error) { toast("发送失败：" + detail(error), "error"); }
    finally { state.sending = false; if (alive()) renderHeader(); }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      view.querySelector("#wsp-form").requestSubmit();
    }
  });

  const poll = setInterval(() => {
    if (!alive() || !state.sessionId) return;
    refreshSelected();
    if (Date.now() - lastSessionListRefresh > 15000) {
      const project = activeProject();
      if (project) loadSessions(project);
    }
  }, 2500);
  (async () => {
    try {
      const [projects, check] = await Promise.all([
        api("workspace/projects", { silent: true }), api("workspace/check", { silent: true }),
      ]);
      if (!alive()) return;
      state.projects = projects.items || [];
      state.check = check;
      view.querySelector("#wsp-connection").replaceChildren(
        el("strong", { text: check.found ? "OpenCode 可用" : "未找到 OpenCode" }),
        document.createTextNode(check.found ? ` · ${check.source}` : " · 请在设置中配置程序路径"));
      const selected = state.projects.find((item) => item.id === state.projectId) || state.projects[0];
      renderSidebar();
      if (selected) selectProject(selected.id);
      else { renderHeader(); renderMain(); }
      state.projects.filter((project) => project.id !== selected?.id).slice(0, 3).forEach(loadSessions);
    } catch (error) {
      if (alive()) content.replaceChildren(el("div", { class: "wsp-error", text: "加载工作区失败：" + detail(error) }));
    }
  })();
}
