"use strict";
/* Local skill management and shared accessible selection/import dialogs. */

function skillError(error) { return error?.data?.detail || error?.message || String(error); }

function createSkillDialog(title) {
  const previous = document.activeElement;
  const body = el("div", { class: "wsp-modal skill-dialog", role: "dialog", "aria-modal": "true", "aria-label": title });
  const mask = el("div", { class: "wsp-modal-mask" }, body);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    mask.remove();
    document.removeEventListener("keydown", onKey);
    if (previous?.isConnected) previous.focus();
  };
  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(body.querySelectorAll("button:not(:disabled), input:not(:disabled), a[href]"))
      .filter((node) => !node.hidden && node.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  body.append(el("div", { class: "skill-dialog-head" }, el("h2", { text: title }),
    el("button", { class: "wsp-mini", type: "button", text: "×", "aria-label": "关闭", onclick: close })));
  mask.addEventListener("click", (event) => { if (event.target === mask) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(mask);
  addCleanup(close);
  return { body, close, alive: () => !closed && mask.isConnected };
}

function openSkillImport(onImported) {
  const dialog = createSkillDialog("新增技能");
  const pathInput = el("input", { id: "skill-source-path", type: "text", placeholder: "包含 SKILL.md 的技能目录绝对路径",
    autocomplete: "off", spellcheck: "false", "aria-label": "技能目录" });
  const errorLine = el("div", { class: "wsp-question-error", role: "alert" });
  const browser = el("div", { class: "skill-directory-browser", hidden: true });
  let browsing = null, browseRequest = 0;
  async function browse(path) {
    const request = ++browseRequest;
    browser.hidden = false;
    browser.replaceChildren(el("p", { text: "正在读取目录…" }));
    try {
      const data = await api("terminal/fs" + (path ? "?path=" + encodeURIComponent(path) : ""), { silent: true });
      if (!dialog.alive() || request !== browseRequest) return;
      browsing = data.path;
      browser.replaceChildren(el("div", { class: "skill-browser-path", text: data.path || "选择根目录" }));
      if (data.path) browser.append(el("button", { class: "skill-directory-option", type: "button", text: "↑ 上级目录",
        onclick: () => browse(data.parent) }));
      for (const entry of data.entries || []) browser.append(el("button", { class: "skill-directory-option", type: "button",
        text: "▤ " + entry.name, onclick: () => browse(entry.path) }));
      if (data.path) browser.append(el("button", { class: "wsp-mini primary", type: "button", text: "选择此目录", onclick: () => {
        pathInput.value = browsing; browser.hidden = true; pathInput.focus();
      } }));
    } catch (error) {
      if (dialog.alive() && request === browseRequest) browser.replaceChildren(el("p", { text: skillError(error) }));
    }
  }
  const importButton = el("button", { class: "wsp-mini primary", type: "button", text: "导入并启用", onclick: async () => {
    const path = pathInput.value.trim();
    if (!path) { errorLine.textContent = "请指定技能目录"; pathInput.focus(); return; }
    importButton.disabled = true;
    importButton.textContent = "正在复制…";
    errorLine.textContent = "";
    try {
      const skill = await api("skills", { method: "POST", body: { path }, silent: true });
      if (!dialog.alive()) return;
      dialog.close();
      onImported(skill);
    } catch (error) {
      if (dialog.alive()) errorLine.textContent = skillError(error);
    } finally {
      importButton.disabled = false;
      importButton.textContent = "导入并启用";
    }
  } });
  dialog.body.append(el("p", { text: "选择单个技能目录，应用会复制 SKILL.md 及脚本、参考资料等资源。导入后即可在各项目中使用。" }),
    el("div", { class: "wsp-modal-row" }, pathInput,
      el("button", { class: "wsp-mini", type: "button", text: "浏览目录", onclick: () => browse(pathInput.value.trim() || null) })),
    browser, errorLine, el("div", { class: "wsp-modal-actions" },
      el("button", { class: "wsp-mini", type: "button", text: "取消", onclick: dialog.close }), importButton));
  pathInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !importButton.disabled) importButton.click(); });
  pathInput.focus();
}

function renderSkills(view) {
  let disposed = false, items = [], loading = true, busy = false;
  addCleanup(() => { disposed = true; });
  const search = el("input", { type: "search", placeholder: "搜索技能名称和描述", "aria-label": "搜索技能" });
  const directory = el("code", { class: "skill-storage-path" });
  const count = el("span", { class: "skill-count" });
  const errorLine = el("div", { class: "banner banner-err", role: "alert", hidden: true });
  const list = el("div", { class: "skill-list" });
  const add = el("button", { class: "btn btn-primary", type: "button", text: "＋ 新增技能", onclick: () => openSkillImport((skill) => {
    toast(`技能 ${skill.name} 已导入并启用`, "ok"); load();
  }) });
  view.replaceChildren(el("section", { class: "skills-page" },
    el("div", { class: "skill-page-head" },
      el("div", null, el("h1", { text: "技能" }), el("p", { text: "为 OpenCode 添加可复用的指令、脚本和参考资料。" })), add),
    el("section", { class: "card skill-guide" },
      el("h2", { text: "按需使用技能" }),
      el("p", { text: "在工作区输入 /skills 选择已启用的技能，再补充任务并发送；AI 也会根据任务自动选择和加载技能。" }),
      el("p", null, "技能存放位置：", directory),
      el("p", { class: "dim", text: "停用后保留应用副本；删除仅移除应用副本，源目录仍保留。技能变更会在工作区空闲时刷新。" })),
    errorLine, el("div", { class: "skill-toolbar" }, search, count,
      el("button", { class: "btn", type: "button", text: "刷新", onclick: () => load() })), list));

  function draw() {
    const query = search.value.trim().toLocaleLowerCase();
    const matches = items.filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(query));
    count.textContent = `${items.length} 个技能 · ${items.filter((item) => item.enabled && !item.error).length} 个已启用`;
    add.disabled = busy;
    list.replaceChildren();
    if (loading) { list.append(el("div", { class: "loading", text: "正在读取技能…" })); return; }
    if (!matches.length) {
      list.append(el("div", { class: "card skill-empty" }, el("h2", { text: query ? "没有匹配的技能" : "还没有技能" }),
        el("p", { text: query ? "试试其他名称或关键词。" : "点击「新增技能」，选择包含 SKILL.md 的本地目录。" })));
      return;
    }
    for (const item of matches) {
      const toggle = el("button", { class: "btn", type: "button", role: "switch", "aria-checked": String(item.enabled),
        "aria-label": `启用 ${item.name}`, text: item.enabled ? "停用" : "启用", disabled: busy,
        onclick: () => change(item, "PATCH", { enabled: !item.enabled }) });
      const remove = el("button", { class: "btn btn-danger", type: "button", text: "删除", disabled: busy, onclick: () => {
        const dialog = createSkillDialog("删除技能");
        dialog.body.append(el("p", { text: `删除应用中的「${item.name}」副本？源目录不会被删除。` }),
          el("div", { class: "wsp-modal-actions" }, el("button", { class: "wsp-mini", type: "button", text: "取消", onclick: dialog.close }),
            el("button", { class: "wsp-mini", type: "button", text: "删除副本", onclick: () => { dialog.close(); change(item, "DELETE"); } })));
        dialog.body.querySelector("button").focus();
      } });
      list.append(el("article", { class: "card skill-card" + (!item.enabled ? " skill-disabled" : "") },
        el("div", { class: "skill-card-copy" },
          el("div", { class: "skill-card-title" }, el("h2", { text: item.name }),
            el("span", { class: `skill-state${item.enabled && !item.error ? " enabled" : ""}`, text: item.error ? "格式错误" : item.enabled ? "已启用" : "已停用" })),
          el("p", { text: item.error || item.description }), el("code", { class: "skill-storage-path", text: item.path })),
        el("div", { class: "skill-card-actions" }, toggle, remove)));
    }
  }
  async function load() {
    try {
      const data = await api("skills", { silent: true });
      if (disposed) return;
      items = data.items || [];
      directory.textContent = data.directory;
      errorLine.hidden = true;
    } catch (error) {
      if (disposed) return;
      errorLine.textContent = "读取技能失败：" + skillError(error); errorLine.hidden = false;
    } finally { loading = false; if (!disposed) draw(); }
  }
  async function change(item, method, body) {
    if (busy) return;
    busy = true; draw(); errorLine.hidden = true;
    try {
      await api(`skills/${encodeURIComponent(item.id)}`, { method, body, silent: true });
      if (!disposed) { toast(method === "DELETE" ? "技能副本已删除" : body.enabled ? "技能已启用" : "技能已停用", "ok"); await load(); }
    } catch (error) {
      if (!disposed) { errorLine.textContent = skillError(error); errorLine.hidden = false; }
    } finally { busy = false; if (!disposed) draw(); }
  }
  search.addEventListener("input", draw);
  draw(); load();
}
