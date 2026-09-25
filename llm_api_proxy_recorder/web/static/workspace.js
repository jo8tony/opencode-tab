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
    messages: [], permissions: [], questions: [], questionDrafts: new Map(), diffs: [], statuses: {},
    check: null, tab: "chat", search: "", sending: false, chosenModels: new Map(),
    chosenAgents: new Map(), providers: [], connectedProviders: new Set(), agents: [], commands: [], modelLoadError: "",
    collapsedProjects: new Set(), expandedTools: new Map(), pendingAction: "", actionError: "",
  };

  view.innerHTML = `
    <section class="wsp" id="wsp">
      <aside class="wsp-side" aria-label="项目与对话">
        <div class="wsp-brand"><img class="wsp-brand-mark" src="sona-code-icon.png" alt="" width="34" height="34"><span class="wsp-brand-copy"><strong>Sona Code</strong><small>桌面工作区</small></span></div>
        <div class="wsp-side-top">
          <div class="wsp-side-actions"><button class="wsp-new" id="wsp-new" type="button">＋ 新建对话</button><button class="wsp-add" id="wsp-add" type="button" title="添加项目" aria-label="添加项目">＋</button></div>
          <label class="wsp-search-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></svg><input class="wsp-search" id="wsp-search" type="search" placeholder="搜索项目和对话" aria-label="搜索项目和对话"><kbd>⌘K</kbd></label>
        </div>
        <div class="wsp-side-list"><div class="wsp-side-label"><span>项目与对话</span><span id="wsp-project-count"></span></div><div id="wsp-projects"></div></div>
        <div class="wsp-side-bottom" id="wsp-connection">正在检查 OpenCode…</div>
      </aside>
      <div class="wsp-main">
        <nav class="wsp-global-nav" aria-label="主导航"><a class="active" href="#/workspace">工作区</a><a href="#/trajectory">轨迹</a><a href="#/calls">调用列表</a><a href="#/dashboard">仪表盘</a><a href="#/settings">设置</a><span class="wsp-nav-spacer"></span><span class="wsp-nav-note">代理观测与开发对话</span></nav>
        <header class="wsp-head"><button class="wsp-menu" id="wsp-menu" type="button" aria-label="打开项目栏"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button><div class="wsp-head-text"><div class="wsp-breadcrumb" id="wsp-breadcrumb">工作区</div><div class="wsp-title" id="wsp-title">选择项目</div></div><button class="wsp-abort" id="wsp-abort" type="button" hidden>停止任务</button><span class="wsp-status" id="wsp-status">准备中</span></header>
        <nav class="wsp-tabs" aria-label="对话视图"><button class="wsp-tab active" type="button" data-wsp-tab="chat">对话</button><button class="wsp-tab" type="button" data-wsp-tab="changes">文件改动</button><button class="wsp-tab" type="button" data-wsp-tab="activity">活动</button></nav>
        <div class="wsp-scroll" id="wsp-scroll"><div class="wsp-content" id="wsp-content"></div></div>
        <div class="wsp-composer-dock"><form class="wsp-composer" id="wsp-form"><div class="wsp-command-menu" id="wsp-command-menu" hidden></div><div class="wsp-model-picker" id="wsp-model-picker" role="dialog" aria-label="选择模型" hidden><div class="wsp-picker-head"><strong>选择模型</strong><button type="button" id="wsp-model-close" aria-label="关闭模型选择">×</button></div><input id="wsp-model-search" type="search" placeholder="搜索 Provider 或模型" aria-label="搜索 Provider 或模型"><div class="wsp-model-list" id="wsp-model-list"></div></div><textarea class="wsp-input" id="wsp-input" placeholder="向 Sona Code 描述你的需求…" aria-label="输入消息" rows="2"></textarea><div class="wsp-composer-bottom"><button class="wsp-model-trigger" id="wsp-model-trigger" type="button" aria-haspopup="dialog" aria-expanded="false">模型 · 自动选择</button><select class="wsp-agent" id="wsp-agent" aria-label="选择 Agent"><option value="">Build</option></select><span class="wsp-composer-hint">Enter 发送 · Shift+Enter 换行</span><span class="wsp-composer-spacer"></span><button class="wsp-send" id="wsp-send" type="submit" title="发送消息" aria-label="发送消息"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-7-7 7 7-7 7"/></svg></button></div></form><div class="wsp-composer-note">输入 / 查看命令；输入 ! 在项目目录运行命令。OpenCode 可读写文件，请核对权限请求。</div></div>
      </div>
    </section>`;

  const root = view.querySelector("#wsp");
  const sideList = view.querySelector("#wsp-projects");
  const content = view.querySelector("#wsp-content");
  const scroll = view.querySelector("#wsp-scroll");
  const input = view.querySelector("#wsp-input");
  const modelButton = view.querySelector("#wsp-model-trigger");
  const modelPicker = view.querySelector("#wsp-model-picker");
  const modelSearch = view.querySelector("#wsp-model-search");
  const modelList = view.querySelector("#wsp-model-list");
  const agentSelect = view.querySelector("#wsp-agent");
  const commandMenu = view.querySelector("#wsp-command-menu");
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
  function sessionTitle(session) {
    const title = session?.title || "";
    return !title || /^New session - \d{4}-\d\d-\d\dT/.test(title) ? "新对话" : title;
  }
  function stamp(session) {
    const value = session?.time?.updated || session?.time?.created;
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const today = new Date();
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const day = sameDay(date, today) ? "今天" : sameDay(date, yesterday) ? "昨天" : date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
    return `更新于${day} ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  }
  function detail(error) { return error?.detail ? format422(error.detail) : error?.message || String(error); }

  function renderSidebar() {
    sideList.replaceChildren();
    view.querySelector("#wsp-project-count").textContent = `${state.projects.length} 个项目`;
    const query = state.search.trim().toLocaleLowerCase();
    for (const project of state.projects) {
      const all = state.sessions.get(project.id);
      const sessions = (all || []).filter((session) => !query || sessionTitle(session).toLocaleLowerCase().includes(query));
      if (query && !project.name.toLocaleLowerCase().includes(query) && !sessions.length) continue;
      const collapsed = state.collapsedProjects.has(project.id) && !query;
      const section = el("section", { class: "wsp-project" + (collapsed ? " collapsed" : "") });
      const heading = el("button", { class: "wsp-project-head", type: "button", title: project.path,
        onclick: () => selectProject(project.id) },
        el("span", { class: "wsp-project-mark", text: (project.name || "P").slice(0, 2).toUpperCase() }),
        el("span", { class: "wsp-project-name", text: project.name }),
        el("span", { class: "wsp-project-count", text: all ? String(all.length) : "…" }));
      const chevron = el("button", { class: "wsp-project-toggle", type: "button", title: collapsed ? "展开对话" : "收起对话", "aria-label": `${collapsed ? "展开" : "收起"}${project.name}的对话`, "aria-expanded": String(!collapsed), onclick: () => {
        if (collapsed) state.collapsedProjects.delete(project.id);
        else state.collapsedProjects.add(project.id);
        renderSidebar();
      } }, el("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, el("path", { d: "m6 9 6 6 6-6" })));
      section.append(el("div", { class: "wsp-project-row" }, heading, chevron));
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
          type: "button", title: sessionTitle(session),
          onclick: () => selectSession(project.id, session.id),
        }, el("span", { class: "wsp-thread-title", text: sessionTitle(session) }),
        el("span", { class: "wsp-thread-time", title: "对话最后更新时间", text: stamp(session) })));
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
    view.querySelector("#wsp-title").textContent = session ? sessionTitle(session) : (project ? "新建或选择对话" : "选择项目");
    const status = state.statuses?.[state.sessionId];
    const pending = state.permissions.some((item) => item.sessionID === state.sessionId) ||
      state.questions.some((item) => item.sessionID === state.sessionId);
    const label = view.querySelector("#wsp-status");
    const last = state.messages.at(-1);
    const failed = last?.info?.role === "assistant" && last.info.error;
    label.className = "wsp-status" + (failed ? " error" : state.sending || status?.type === "busy" ? " busy" : pending ? " attention" : "");
    label.textContent = failed ? "请求失败" : state.sending || status?.type === "busy" ? "正在处理" : pending ? "等待确认" : state.check?.found ? "已就绪" : "未检测到 OpenCode";
    view.querySelector("#wsp-abort").hidden = status?.type !== "busy";
    view.querySelectorAll(".wsp-tab").forEach((button) => button.classList.toggle("active", button.dataset.wspTab === state.tab));
    view.querySelector("#wsp-send").disabled = state.sending || !project || !state.check?.found;
    view.querySelector("#wsp-new").disabled = !state.projects.length || !state.check?.found;
    modelButton.disabled = !project;
  }

  function empty(title, description, action) {
    const box = el("div", { class: "wsp-empty" }, el("div", { class: "wsp-empty-icon", text: "✦" }),
      el("h2", { text: title }), el("p", { text: description }));
    if (action) box.append(el("button", { class: "wsp-mini primary", style: "margin-top:14px", type: "button", text: action[0], onclick: action[1] }));
    return box;
  }

  function textPart(part) { return el("div", { class: "wsp-part wsp-text", text: part.text || "" }); }
  function messageError(info) {
    const error = info?.error;
    if (!error) return null;
    const data = error.data || {};
    const code = Number(data.statusCode || data.status || 0);
    const raw = String(data.message || error.message || error.name || "OpenCode 请求失败");
    const title = code === 401 || code === 403 ? "模型服务认证失败" : "OpenCode 请求失败";
    const message = code === 401 || code === 403
      ? "当前模型的服务商拒绝了认证。请检查密钥，或切换到已配置的 Provider。"
      : raw.slice(0, 600);
    const card = el("div", { class: "wsp-message-error" },
      el("strong", { text: title }),
      el("p", { text: message }),
      el("small", { text: `${info.providerID || "未知 Provider"} / ${info.modelID || "未知模型"}${code ? ` · HTTP ${code}` : ""}` }));
    if (raw && raw !== message) card.append(el("details", {}, el("summary", { text: "查看错误详情" }), el("pre", { text: raw.slice(0, 800) })));
    card.append(el("div", { class: "wsp-error-actions" },
      el("button", { type: "button", class: "wsp-mini primary", text: "切换模型", onclick: openModelPicker }),
      el("button", { type: "button", class: "wsp-mini", text: "填回提问", onclick: () => {
        const index = state.messages.findIndex((message) => message.info === info);
        const earlier = state.messages.slice(0, index < 0 ? undefined : index).reverse().find((message) => message.info?.role === "user");
        input.value = (earlier?.parts || []).filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
        input.focus();
      } }),
      el("a", { href: "#/settings", text: "检查设置" })));
    return card;
  }
  function toolPart(part) {
    const stateInfo = part.state || {};
    const toolName = String(part.tool || "工具");
    const toolLabels = { read: "读取文件", write: "写入文件", edit: "编辑文件", bash: "运行命令", glob: "查找文件", grep: "搜索内容", list: "列出目录", task: "执行任务" };
    const status = stateInfo.status || "running";
    const statusLabels = { completed: "已完成", running: "运行中", pending: "等待中", error: "失败" };
    const key = part.id || part.callID || `${toolName}:${JSON.stringify(stateInfo.input || {})}`;
    const card = el("details", { class: `wsp-tool ${status}` });
    if (state.expandedTools.get(key) ?? (status === "error" || status === "running")) card.open = true;
    card.addEventListener("toggle", () => state.expandedTools.set(key, card.open));
    const input = stateInfo.input || {};
    const subject = input.filePath || input.path || input.command || input.pattern || input.description || "";
    card.append(el("summary", { class: "wsp-tool-head" },
      el("span", { class: "wsp-tool-symbol", text: { read: "↳", write: "+", edit: "±", bash: ">", grep: "⌕", glob: "⌕" }[toolName] || "·" }),
      el("span", { class: "wsp-tool-title", text: toolLabels[toolName] || toolName }),
      el("span", { class: "wsp-tool-subject", title: String(subject), text: String(subject) }),
      el("span", { class: "wsp-tool-status", text: statusLabels[status] || status }),
      el("svg", { class: "wsp-tool-chevron", viewBox: "0 0 24 24", "aria-hidden": "true" }, el("path", { d: "m6 9 6 6 6-6" }))));
    const rawOutput = stateInfo.output || stateInfo.error || "";
    const output = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2);
    const inputText = stateInfo.input ? JSON.stringify(stateInfo.input, null, 2) : "";
    const body = el("div", { class: "wsp-tool-body" });
    if (inputText) body.append(el("div", { class: "wsp-tool-label", text: "输入" }), el("pre", { text: inputText.slice(0, 4000) }));
    body.append(el("div", { class: "wsp-tool-label", text: stateInfo.error ? "错误" : "结果" }),
      el("pre", { text: (output || "等待结果…").slice(0, 12000) }));
    card.append(body);
    return card;
  }

  function questionCard(request) {
    const drafts = state.questionDrafts.get(request.id) || [];
    state.questionDrafts.set(request.id, drafts);
    const card = el("div", { class: "wsp-question" },
      el("strong", { text: "OpenCode 需要你的回答" }));
    (request.questions || []).forEach((question, index) => {
      const draft = drafts[index] || { selected: [], custom: "" };
      drafts[index] = draft;
      const group = el("fieldset", { class: "wsp-question-group" },
        el("legend", { text: question.question || question.header || `问题 ${index + 1}` }));
      if (question.multiple) group.append(el("p", { text: "可多选" }));
      for (const option of question.options || []) {
        const inputOption = el("input", {
          type: question.multiple ? "checkbox" : "radio", name: `wsp-question-${request.id}-${index}`,
          value: option.label, checked: draft.selected.includes(option.label),
          onchange: (event) => {
            if (question.multiple) {
              draft.selected = event.target.checked
                ? [...draft.selected, option.label]
                : draft.selected.filter((label) => label !== option.label);
            } else draft.selected = [option.label];
          },
        });
        group.append(el("label", { class: "wsp-question-option" }, inputOption,
          el("span", {}, el("strong", { text: option.label }),
            option.description ? el("small", { text: option.description }) : null)));
      }
      if (question.custom !== false) group.append(el("input", {
        class: "wsp-question-custom", type: "text", placeholder: "或输入自己的回答",
        "data-request-id": request.id, "data-question-index": index,
        value: draft.custom, oninput: (event) => { draft.custom = event.target.value; },
      }));
      card.append(group);
    });
    const errorLine = el("p", { class: "wsp-question-error" });
    card.append(errorLine, el("div", { class: "wsp-permission-actions" },
      el("button", { class: "wsp-mini primary", type: "button", text: "提交回答", onclick: async () => {
        const answers = drafts.map((draft, index) => {
          const values = request.questions[index]?.multiple ? draft.selected.slice() : draft.selected.slice(0, 1);
          if (draft.custom.trim()) {
            if (!request.questions[index]?.multiple) return [draft.custom.trim()];
            values.push(draft.custom.trim());
          }
          return values;
        });
        if (answers.some((answer) => !answer.length)) { errorLine.textContent = "请回答所有问题"; return; }
        try {
          await api(`workspace/projects/${encodeURIComponent(state.projectId)}/questions/${encodeURIComponent(request.id)}/reply`, {
            method: "POST", body: { answers }, silent: true,
          });
          state.questionDrafts.delete(request.id);
          await refreshSelected();
        } catch (error) { errorLine.textContent = `提交失败：${detail(error)}`; }
      } }),
      el("button", { class: "wsp-mini", type: "button", text: "跳过", onclick: async () => {
        try {
          await api(`workspace/projects/${encodeURIComponent(state.projectId)}/questions/${encodeURIComponent(request.id)}/reject`, {
            method: "POST", body: {}, silent: true,
          });
          state.questionDrafts.delete(request.id);
          await refreshSelected();
        } catch (error) { errorLine.textContent = `操作失败：${detail(error)}`; }
      } })));
    return card;
  }

  function renderMessages() {
    if (!state.sessionId) {
      content.append(empty("开始一段新对话", "选择项目后新建对话，OpenCode 会在该项目目录中工作。",
        activeProject() ? ["新建对话", createSession] : ["添加项目", openAddProject]));
      return;
    }
    if (!state.messages.length && !state.permissions.some((item) => item.sessionID === state.sessionId) &&
      !state.questions.some((item) => item.sessionID === state.sessionId)) {
      content.append(empty("输入你的开发需求", "发送第一条消息后，这里会实时显示回复和工具操作。"));
      if (state.pendingAction) content.append(el("div", { class: "wsp-action-progress", text: `正在执行 ${state.pendingAction}…` }));
      if (state.actionError) content.append(el("div", { class: "wsp-error", text: state.actionError }));
      return;
    }
    for (const message of state.messages) {
      const role = message?.info?.role || "assistant";
      const row = el("article", { class: "wsp-message " + (role === "user" ? "user" : "assistant") });
      if (role !== "user") row.append(el("div", { class: "wsp-avatar" }, el("img", { src: "sona-code-icon.png", alt: "", width: "22", height: "22" })));
      const body = el("div", { class: "wsp-message-inner" });
      if (role !== "user") body.append(el("div", { class: "wsp-message-meta" },
        el("strong", { text: "Sona" }),
        `OpenCode${message.info?.providerID && message.info?.modelID ? ` · ${message.info.providerID} / ${message.info.modelID}` : ""}`));
      const parts = message.parts || [];
      const error = role !== "user" ? messageError(message.info) : null;
      if (error) body.append(error);
      else if (role !== "user" && !parts.length) {
        const busy = state.statuses?.[state.sessionId]?.type === "busy";
        body.append(el("div", { class: busy ? "wsp-thinking" : "wsp-no-response", text: busy ? "正在思考…" : "本轮未收到回复" }));
      }
      for (const part of parts) {
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
    for (const question of state.questions.filter((item) => item.sessionID === state.sessionId)) {
      content.append(questionCard(question));
    }
    if (state.pendingAction) content.append(el("div", { class: "wsp-action-progress", text: `正在执行 ${state.pendingAction}…` }));
    if (state.actionError) content.append(el("div", { class: "wsp-error", text: state.actionError }));
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
    const active = document.activeElement;
    const editingQuestion = active?.classList?.contains("wsp-question-custom")
      ? { id: active.dataset.requestId, index: active.dataset.questionIndex,
          start: active.selectionStart, end: active.selectionEnd } : null;
    content.replaceChildren();
    if (state.tab === "chat") renderMessages();
    if (state.tab === "changes") renderChanges();
    if (state.tab === "activity") renderActivity();
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
    if (editingQuestion) {
      const restored = Array.from(content.querySelectorAll(".wsp-question-custom")).find((field) =>
        field.dataset.requestId === editingQuestion.id && field.dataset.questionIndex === editingQuestion.index);
      if (restored) {
        restored.focus();
        restored.setSelectionRange(editingQuestion.start, editingQuestion.end);
      }
    }
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

  function selectedModel() {
    const [providerID, modelID] = (state.chosenModels.get(state.projectId) || "").split("\u0000");
    return providerID && modelID ? { provider_id: providerID, model_id: modelID } : {};
  }

  function updateModelButton() {
    const choice = selectedModel();
    const provider = state.providers.find((item) => item.id === choice.provider_id);
    const model = provider?.models?.[choice.model_id];
    modelButton.textContent = model ? `${provider.name || provider.id} / ${model.name || choice.model_id}` : "模型 · 自动选择";
    modelButton.title = model ? `${provider.id} / ${choice.model_id}` : "由 OpenCode 选择默认模型";
  }

  function closeModelPicker() {
    modelPicker.hidden = true;
    modelButton.setAttribute("aria-expanded", "false");
  }

  function openProviderKeyDialog(provider) {
    const keyInput = el("input", { type: "password", autocomplete: "new-password", placeholder: "粘贴 Provider API Key" });
    const message = el("p", { class: "wsp-question-error" });
    const mask = el("div", { class: "wsp-modal-mask" },
      el("div", { class: "wsp-modal", role: "dialog", "aria-modal": "true", "aria-label": `设置 ${provider.name || provider.id} API Key` },
        el("h2", { text: `设置 ${provider.name || provider.id} API Key` }),
        el("p", { text: state.connectedProviders.has(provider.id)
          ? "OpenCode 已保存此 Provider 的凭据。新 Key 保存后会替换旧凭据；认证是否有效，以实际请求结果为准。"
          : "保存到 OpenCode 的本地凭据存储。该 Provider 后续请求会使用这个 Key。" }),
        keyInput, message,
        el("div", { class: "wsp-modal-actions" },
          el("button", { class: "wsp-mini", type: "button", text: "取消", onclick: () => mask.remove() }),
          el("button", { class: "wsp-mini primary", type: "button", text: "保存到 OpenCode", onclick: async (event) => {
            const button = event.currentTarget;
            const key = keyInput.value.trim();
            if (!key) { message.textContent = "请先输入 API Key"; keyInput.focus(); return; }
            button.disabled = true;
            message.textContent = "正在保存到本机 OpenCode 凭据存储…";
            try {
              await api(`workspace/projects/${encodeURIComponent(state.projectId)}/providers/${encodeURIComponent(provider.id)}/api-key`, {
                method: "POST", body: { key }, silent: true,
              });
              keyInput.value = "";
              state.connectedProviders.add(provider.id);
              mask.remove();
              renderModelPicker();
              toast(`${provider.name || provider.id} 凭据已保存到 OpenCode`, "ok");
            } catch (error) {
              message.textContent = `保存失败：${detail(error)}`;
              button.disabled = false;
            }
          } }))));
    mask.addEventListener("click", (event) => { if (event.target === mask) mask.remove(); });
    document.body.append(mask);
    keyInput.focus();
  }

  function chooseModel(value) {
    if (state.projectId) {
      state.chosenModels.set(state.projectId, value);
      try { localStorage.setItem(`sona-code:model:${state.projectId}`, value); } catch (_) { /* Storage may be unavailable. */ }
    }
    updateModelButton();
    closeModelPicker();
    input.focus();
  }

  function renderModelPicker() {
    modelList.replaceChildren();
    if (state.modelLoadError) {
      modelList.append(el("p", { class: "wsp-picker-empty", text: `模型加载失败：${state.modelLoadError}` }));
      return;
    }
    const query = modelSearch.value.trim().toLocaleLowerCase();
    const selected = state.chosenModels.get(state.projectId) || "";
    if (!query) modelList.append(el("button", { type: "button", class: "wsp-model-option" + (!selected ? " selected" : ""),
      onclick: () => chooseModel("") },
      el("span", { text: "自动选择" }), el("small", { text: "使用 OpenCode 当前默认模型" })));
    let count = 0;
    for (const provider of state.providers) {
      const items = Object.entries(provider.models || {}).filter(([id, model]) =>
        `${provider.id} ${provider.name || ""} ${id} ${model.name || ""}`.toLocaleLowerCase().includes(query));
      if (!items.length) continue;
      const group = el("section", { class: "wsp-model-group" },
        el("div", { class: "wsp-model-group-title" },
          el("strong", { text: provider.name || provider.id }),
          el("span", { text: `${provider.id} · ${items.length} 个模型 · ${state.connectedProviders.has(provider.id) ? "已保存凭据" : "未配置凭据"}` })),
        el("button", { type: "button", class: "wsp-provider-key", text: "设置 API Key", onclick: () => openProviderKeyDialog(provider) }));
      for (const [id, model] of items) {
        const value = `${provider.id}\u0000${id}`;
        group.append(el("button", { type: "button", class: "wsp-model-option" + (value === selected ? " selected" : ""),
          title: `${provider.id} / ${id}`, onclick: () => chooseModel(value) },
          el("span", { text: model.name || id }),
          el("small", { text: id })));
        count++;
      }
      modelList.append(group);
    }
    if (!count && query) modelList.append(el("p", { class: "wsp-picker-empty", text: "没有匹配的模型" }));
    else if (!state.providers.length) modelList.append(el("p", { class: "wsp-picker-empty", text: "暂无可用 Provider；请检查 OpenCode 配置。" }));
  }

  function openModelPicker() {
    if (!state.projectId) return;
    commandMenu.hidden = true;
    modelPicker.hidden = false;
    modelButton.setAttribute("aria-expanded", "true");
    modelSearch.value = "";
    renderModelPicker();
    modelSearch.focus();
  }

  async function loadModels(projectId) {
    state.providers = [];
    state.modelLoadError = "";
    updateModelButton();
    try {
      const data = await api(`workspace/projects/${encodeURIComponent(projectId)}/models`, { silent: true });
      if (!alive() || state.projectId !== projectId) return;
      state.providers = Array.isArray(data.providers) ? data.providers.slice().sort((a, b) =>
        (a.id === "opencode" ? -1 : b.id === "opencode" ? 1 : (a.name || a.id).localeCompare(b.name || b.id))) : [];
      state.connectedProviders = new Set(Array.isArray(data.connected) ? data.connected : []);
      const value = state.chosenModels.get(projectId) || "";
      if (value) {
        const [providerID, modelID] = value.split("\u0000");
        if (!state.providers.some((provider) => provider.id === providerID && provider.models?.[modelID])) {
          state.chosenModels.set(projectId, "");
        }
      }
      updateModelButton();
      if (!modelPicker.hidden) renderModelPicker();
    } catch (error) {
      if (alive() && state.projectId === projectId) {
        state.modelLoadError = detail(error);
        if (!modelPicker.hidden) renderModelPicker();
      }
    }
  }

  async function loadAgents(projectId) {
    try {
      const data = await api(`workspace/projects/${encodeURIComponent(projectId)}/agents`, { silent: true });
      if (!alive() || state.projectId !== projectId) return;
      state.agents = Array.isArray(data) ? data.filter((item) => item.mode === "primary" && !item.hidden) : [];
      agentSelect.replaceChildren(...state.agents.map((item) =>
        el("option", { value: item.name, text: item.name === "build" ? "Build · 执行" : item.name === "plan" ? "Plan · 规划" : item.name })));
      if (!state.agents.length) agentSelect.append(el("option", { value: "build", text: "Build" }));
      agentSelect.value = state.chosenAgents.get(projectId) || "build";
      if (!agentSelect.value) agentSelect.selectedIndex = 0;
    } catch (_) { /* The default Build agent remains usable. */ }
  }

  async function loadCommands(projectId) {
    try {
      const data = await api(`workspace/projects/${encodeURIComponent(projectId)}/commands`, { silent: true });
      if (alive() && state.projectId === projectId) {
        state.commands = Array.isArray(data) ? data : [];
        if (!commandMenu.hidden) renderCommandMenu();
      }
    } catch (_) { state.commands = []; }
  }

  const builtInCommands = [
    { name: "help", description: "查看可用命令" },
    { name: "new", description: "新建对话" },
    { name: "models", description: "选择 Provider 和模型" },
    { name: "agents", description: "选择 Agent" },
    { name: "stop", description: "停止当前任务" },
    { name: "settings", description: "打开设置" },
  ];

  function renderCommandMenu() {
    const draft = input.value.trimStart();
    if (!draft.startsWith("/") || draft.includes("\n") || draft.includes(" ")) {
      commandMenu.hidden = true;
      return;
    }
    const query = draft.slice(1).toLocaleLowerCase();
    commandMenu.replaceChildren(el("div", { class: "wsp-command-heading", text: "命令 · Enter 执行" }));
    const commands = [...builtInCommands, ...state.commands.filter((item) =>
      !builtInCommands.some((builtIn) => builtIn.name === item.name))];
    for (const command of commands.filter((item) => item.name.toLocaleLowerCase().includes(query)).slice(0, 12)) {
      commandMenu.append(el("button", { type: "button", class: "wsp-command-option", onclick: () => {
        input.value = `/${command.name} `;
        commandMenu.hidden = true;
        input.focus();
      } }, el("strong", { text: `/${command.name}` }), el("span", { text: command.description || "OpenCode 命令" })));
    }
    commandMenu.hidden = commandMenu.children.length === 1;
  }

  async function executeBuiltIn(name) {
    if (name === "help") { input.value = "/"; renderCommandMenu(); return true; }
    if (name === "new") { input.value = ""; await createSession(); return true; }
    if (name === "models") { input.value = ""; openModelPicker(); return true; }
    if (name === "agents") { input.value = ""; agentSelect.focus(); return true; }
    if (name === "settings") { location.hash = "#/settings"; return true; }
    if (name === "stop") {
      if (state.sessionId) await api(`${sessionPath(state.projectId, state.sessionId)}/abort`, { method: "POST", body: {}, silent: true });
      input.value = "";
      await refreshSelected();
      return true;
    }
    return false;
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
      const [messages, statuses, permissions, questions, diffs] = await Promise.allSettled([
        api(`${base}/messages`, { silent: true }),
        api(`workspace/projects/${encodeURIComponent(projectId)}/status`, { silent: true }),
        api(`workspace/projects/${encodeURIComponent(projectId)}/permissions`, { silent: true }),
        api(`workspace/projects/${encodeURIComponent(projectId)}/questions`, { silent: true }),
        state.tab === "changes" ? api(`${base}/diff`, { silent: true }) : Promise.resolve(state.diffs),
      ]);
      if (!alive() || state.projectId !== projectId || state.sessionId !== sessionId) return;
      if (messages.status === "fulfilled") state.messages = Array.isArray(messages.value) ? messages.value : [];
      if (statuses.status === "fulfilled") state.statuses = statuses.value || {};
      if (permissions.status === "fulfilled") state.permissions = Array.isArray(permissions.value) ? permissions.value : [];
      if (questions.status === "fulfilled") state.questions = Array.isArray(questions.value) ? questions.value : [];
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
    if (!state.chosenModels.has(projectId)) {
      try { state.chosenModels.set(projectId, localStorage.getItem(`sona-code:model:${projectId}`) || ""); }
      catch (_) { state.chosenModels.set(projectId, ""); }
    }
    const remembered = workspaceSelection.projectId === projectId ? workspaceSelection.sessionId : null;
    state.sessionId = remembered || (state.sessions.get(projectId) || [])[0]?.id || null;
    state.messages = []; state.permissions = []; state.questions = []; state.questionDrafts.clear(); state.diffs = [];
    state.tab = "chat";
    workspaceSelection = { projectId, sessionId: state.sessionId };
    root.classList.remove("show-side");
    renderSidebar(); renderHeader(); renderMain();
    connectEvents(projectId);
    loadModels(projectId);
    loadAgents(projectId);
    loadCommands(projectId);
    if (!state.sessions.has(projectId)) {
      const project = activeProject();
      if (project) loadSessions(project);
    } else refreshSelected();
  }

  function selectSession(projectId, sessionId) {
    state.projectId = projectId;
    if (!state.chosenModels.has(projectId)) {
      try { state.chosenModels.set(projectId, localStorage.getItem(`sona-code:model:${projectId}`) || ""); }
      catch (_) { state.chosenModels.set(projectId, ""); }
    }
    state.sessionId = sessionId;
    state.messages = []; state.permissions = []; state.questions = []; state.questionDrafts.clear(); state.diffs = [];
    state.tab = "chat";
    workspaceSelection = { projectId, sessionId };
    root.classList.remove("show-side");
    renderSidebar(); renderHeader(); renderMain();
    connectEvents(projectId);
    loadModels(projectId);
    loadAgents(projectId);
    loadCommands(projectId);
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

  async function ensureSessionForSend() {
    if (state.sessionId) return;
    const session = await api(`workspace/projects/${encodeURIComponent(state.projectId)}/sessions`, {
      method: "POST", body: {}, silent: true,
    });
    const items = state.sessions.get(state.projectId) || [];
    state.sessions.set(state.projectId, [session, ...items.filter((item) => item.id !== session.id)]);
    state.sessionId = session.id;
    workspaceSelection = { projectId: state.projectId, sessionId: session.id };
    connectEvents(state.projectId);
    renderSidebar(); renderHeader();
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
  const searchShortcut = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && location.hash === "#/workspace") {
      event.preventDefault();
      view.querySelector("#wsp-search").focus();
    }
  };
  document.addEventListener("keydown", searchShortcut);
  addCleanup(() => document.removeEventListener("keydown", searchShortcut));
  modelButton.addEventListener("click", () => modelPicker.hidden ? openModelPicker() : closeModelPicker());
  view.querySelector("#wsp-model-close").addEventListener("click", closeModelPicker);
  modelSearch.addEventListener("input", renderModelPicker);
  modelSearch.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeModelPicker(); modelButton.focus(); }
  });
  const outsidePicker = (event) => {
    if (!modelPicker.hidden && !modelPicker.contains(event.target) && event.target !== modelButton) closeModelPicker();
  };
  document.addEventListener("pointerdown", outsidePicker);
  addCleanup(() => document.removeEventListener("pointerdown", outsidePicker));
  agentSelect.addEventListener("change", () => {
    if (state.projectId) state.chosenAgents.set(state.projectId, agentSelect.value);
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
    const slash = text.match(/^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
    const shell = text.startsWith("!") ? text.slice(1).trim() : "";
    if (text.startsWith("/") && !slash) { toast("命令格式应为 /命令 参数", "error"); return; }
    if (text.startsWith("!") && !shell) { toast("请输入要运行的命令", "error"); return; }
    if (slash && !builtInCommands.some((item) => item.name === slash[1]) && !state.commands.some((item) => item.name === slash[1])) {
      toast(`未知命令：/${slash[1]}`, "error"); return;
    }
    state.sending = true; renderHeader();
    commandMenu.hidden = true;
    state.actionError = "";
    try {
      if (slash && await executeBuiltIn(slash[1])) return;
      await ensureSessionForSend();
      const model = selectedModel();
      const agent = agentSelect.value || "build";
      if (slash || shell) {
        state.pendingAction = slash ? `/${slash[1]}` : `!${shell}`;
        state.actionError = "";
        renderMain();
      }
      if (slash) {
        await api(`${sessionPath(state.projectId, state.sessionId)}/command`, {
          method: "POST", body: { command: slash[1], arguments: slash[2] || "", agent, ...model }, silent: true,
        });
      } else if (shell) {
        await api(`${sessionPath(state.projectId, state.sessionId)}/shell`, {
          method: "POST", body: { command: shell, agent, ...model }, silent: true,
        });
      } else {
        await api(`${sessionPath(state.projectId, state.sessionId)}/prompt`, {
          method: "POST", body: { text, agent, ...model }, silent: true,
        });
      }
      if (!alive()) return;
      input.value = "";
      await loadSessions(activeProject());
      await refreshSelected();
    } catch (error) {
      state.actionError = `操作失败：${detail(error)}`;
      toast(state.actionError, "error");
    } finally {
      state.pendingAction = "";
      state.sending = false;
      if (alive()) { renderHeader(); renderMain(); }
    }
  });
  input.addEventListener("input", renderCommandMenu);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { commandMenu.hidden = true; return; }
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
