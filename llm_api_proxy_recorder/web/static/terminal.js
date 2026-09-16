"use strict";
/* 终端页：浏览器中管理多个 opencode / shell 会话（xterm.js + WebSocket）。
 * 页面状态 TERM 在路由离开时整体清理（addCleanup）。
 * 每个会话一个 xterm 实例，tab 切换用 display 隐藏保活（保滚动历史）。 */

let TERM = null;

/* ============================================================ 页面渲染 */
function renderTerminal(view) {
  view.replaceChildren(el("div", { class: "loading", text: "加载中…" }));
  (async () => {
    let meta, check, sessions;
    try {
      [meta, check, sessions] = await Promise.all([
        api("meta"),
        api("terminal/check", { silent: true }),
        api("terminal/sessions"),
      ]);
    } catch (e) {
      view.replaceChildren(errorCard("加载终端失败：" + (e.detail ? format422(e.detail) : e.message), () => route()));
      return;
    }

    TERM = {
      adminPrefix: meta.admin_prefix || "/__recorder",
      check,
      byId: new Map(),
      activeId: null,
      sideList: null,
      tabs: null,
      area: null,
      empty: null,
      ro: null,
    };

    const newBtn = el("button", { class: "btn btn-primary", type: "button", text: "+ 新建会话", onclick: () => openCreateModal() });
    const hint = el("div", {
      class: "term-hint " + (check.opencode_found ? "ok" : "warn"),
      text: check.opencode_found ? "opencode 已就绪" : "未检测到 opencode，可先使用 shell 会话",
    });

    TERM.sideList = el("div", { class: "term-list" });
    TERM.tabs = el("div", { class: "term-tabs" });
    TERM.area = el("div", { class: "term-area" });
    TERM.empty = el("div", { class: "term-empty-wrap" },
      emptyBox("暂无终端会话", "点击「新建会话」选择项目目录，在浏览器中启动 opencode"));

    view.replaceChildren(
      el("section", { class: "term-page" },
        el("aside", { class: "term-side" },
          el("div", { class: "term-side-head" }, newBtn, hint),
          TERM.sideList),
        el("div", { class: "term-main" }, TERM.tabs, TERM.area)));

    // 已有会话逐个挂接（服务重启前残留的会话仍在运行）
    for (const info of sessions.items || []) addSession(info, { focus: false });
    refreshAll();
    if (TERM.byId.size) activate(TERM.byId.keys().next().value);

    // 尺寸自适应：容器变化 + 窗口变化
    TERM.ro = new ResizeObserver(() => fitActive());
    TERM.ro.observe(TERM.area);
    const onWinResize = () => fitActive();
    window.addEventListener("resize", onWinResize);
    addCleanup(() => {
      window.removeEventListener("resize", onWinResize);
      if (TERM && TERM.ro) TERM.ro.disconnect();
      for (const s of TERM.byId.values()) {
        if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
        closeWs(s);
        try { s.term.dispose(); } catch (_) { /* 已销毁 */ }
      }
      TERM = null;
    });
  })();
}

/* ============================================================ 会话管理 */
function addSession(info, { focus }) {
  const s = Object.assign({}, info, { ws: null, wsState: "closed", reconnectTimer: null, attempts: 0 });

  s.overlayEl = el("div", { class: "term-overlay hidden" });
  s.boxEl = el("div", { class: "term-box" }, s.overlayEl);

  s.term = new Terminal({
    scrollback: 5000,
    fontSize: 13,
    fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace',
    cursorBlink: true,
    theme: {
      background: "#181d27",
      foreground: "#e6e9ef",
      cursor: "#3b82f6",
      selectionBackground: "rgba(59, 130, 246, .35)",
    },
  });
  s.fit = new FitAddon.FitAddon();
  s.term.loadAddon(s.fit);
  s.term.open(s.boxEl);
  s.term.onData((d) => sendInput(s, d));

  TERM.byId.set(s.id, s);
  TERM.area.append(s.boxEl);
  connect(s);
  if (focus) activate(s.id);
}

function closeSession(id, { silent } = {}) {
  const s = TERM.byId.get(id);
  if (!s) return;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  closeWs(s);
  try { s.term.dispose(); } catch (_) { /* 已销毁 */ }
  s.boxEl.remove();
  TERM.byId.delete(id);
  api("terminal/sessions/" + encodeURIComponent(id), { method: "DELETE", silent: true }).catch(() => {});
  if (TERM.activeId === id) {
    TERM.activeId = null;
    if (TERM.byId.size) activate(TERM.byId.keys().next().value);
  }
  refreshAll();
  if (!silent) toast("会话已关闭", "");
}

async function restartSession(s) {
  const { cwd, kind } = s;
  try {
    const info = await api("terminal/sessions", { method: "POST", body: { cwd, kind }, silent: true });
    closeSession(s.id, { silent: true });
    addSession(info, { focus: true });
    refreshAll();
    toast("会话已重新启动", "");
  } catch (e) {
    toast("重启失败：" + (e.detail ? format422(e.detail) : e.message), "error");
  }
}

/* ============================================================ WebSocket */
function wsUrl(id) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + TERM.adminPrefix + "/api/terminal/ws/" + encodeURIComponent(id);
}

function connect(s) {
  closeWs(s);
  const ws = new WebSocket(wsUrl(s.id));
  ws.binaryType = "arraybuffer";
  s.ws = ws;
  s.wsState = "connecting";
  ws.onopen = () => { s.attempts = 0; s.wsState = "open"; refreshAll(); };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === "attached" && msg.alive === false) markExited(s, null);
    } else {
      s.term.write(new Uint8Array(ev.data));
    }
  };
  ws.onclose = () => {
    s.ws = null;
    s.wsState = "closed";
    if (s.alive) scheduleReconnect(s);
    refreshAll();
  };
  ws.onerror = () => { try { ws.close(); } catch (_) { /* 关闭中 */ } };
}

function scheduleReconnect(s) {
  if (s.reconnectTimer || !s.alive) return;
  s.attempts++;
  const delay = Math.min(15000, 500 * Math.pow(2, Math.min(s.attempts, 5)));
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    if (s.alive && TERM && TERM.byId.has(s.id)) connect(s);
  }, delay);
}

function closeWs(s) {
  if (s.ws) {
    s.ws.onclose = null;
    s.ws.onerror = null;
    s.ws.onmessage = null;
    try { s.ws.close(); } catch (_) { /* 关闭中 */ }
    s.ws = null;
  }
}

function sendInput(s, data) {
  if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "input", data }));
}

function sendResize(s) {
  if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "resize", cols: s.term.cols, rows: s.term.rows }));
}

function markExited(s, code) {
  s.alive = false;
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  closeWs(s);
  s.overlayEl.classList.remove("hidden");
  s.overlayEl.replaceChildren(
    el("div", { class: "term-overlay-card" },
      el("div", { class: "term-overlay-title", text: "进程已退出" + (code != null ? "（code " + code + "）" : "") }),
      el("div", { class: "term-overlay-actions" },
        el("button", { class: "btn btn-xs", type: "button", text: "重新启动", onclick: () => restartSession(s) }),
        el("button", { class: "btn btn-xs btn-danger", type: "button", text: "关闭", onclick: () => closeSession(s.id) }))));
  refreshAll();
}

/* ============================================================ tab / 侧栏 */
function activate(id) {
  const s = TERM.byId.get(id);
  if (!s) return;
  TERM.activeId = id;
  for (const [sid, x] of TERM.byId) x.boxEl.classList.toggle("active", sid === id);
  refreshAll();
  requestAnimationFrame(() => {
    fitActive();
    try { s.term.focus(); } catch (_) { /* 已销毁 */ }
  });
}

function fitActive() {
  const s = TERM.byId.get(TERM.activeId);
  if (!s) return;
  try {
    s.fit.fit();
    sendResize(s);
  } catch (_) { /* 尺寸不可用时忽略 */ }
}

function statusDot(s) {
  const cls = s.alive ? (s.wsState === "open" ? "run" : s.wsState === "connecting" ? "conn" : "lost") : "dead";
  const title = { run: "运行中", conn: "连接中", lost: "连接断开，自动重连中", dead: "已退出" }[cls];
  return el("span", { class: "term-dot " + cls, title });
}

function refreshAll() {
  if (!TERM) return;
  refreshTabs();
  refreshSideList();
  refreshEmpty();
}

function refreshTabs() {
  TERM.tabs.replaceChildren();
  for (const s of TERM.byId.values()) {
    TERM.tabs.append(el("button", {
      class: "term-tab" + (s.id === TERM.activeId ? " active" : ""),
      type: "button",
      title: s.cwd + "（" + (s.kind === "shell" ? "shell" : "opencode") + "）",
      onclick: () => activate(s.id),
    },
      statusDot(s),
      el("span", { class: "term-tab-name", text: s.title || s.id }),
      el("span", {
        class: "term-tab-close", title: "关闭会话", text: "×",
        onclick: (ev) => { ev.stopPropagation(); closeSession(s.id); },
      })));
  }
}

function refreshSideList() {
  TERM.sideList.replaceChildren();
  for (const s of TERM.byId.values()) {
    TERM.sideList.append(el("div", {
      class: "term-side-item" + (s.id === TERM.activeId ? " active" : ""),
      onclick: () => activate(s.id),
    },
      el("div", { class: "term-side-row" }, statusDot(s),
        el("span", { class: "term-side-title", text: s.title || s.id }),
        el("span", { class: "badge " + (s.kind === "shell" ? "b-dim" : "b-ok"), text: s.kind === "shell" ? "shell" : "opencode" })),
      el("div", { class: "term-side-path mono", title: s.cwd, text: s.cwd })));
  }
}

function refreshEmpty() {
  const has = TERM.byId.size > 0;
  TERM.area.classList.toggle("has-sessions", has);
  if (has) {
    TERM.empty.remove();
  } else {
    TERM.area.append(TERM.empty);
  }
}

/* ============================================================ 新建会话弹窗 */
function openCreateModal() {
  const check = TERM.check;

  const cwdInput = el("input", {
    type: "text", class: "mono", placeholder: "项目目录绝对路径，如 D:\\project\\my-app",
    autocomplete: "off", spellcheck: "false",
  });

  // 目录浏览器（懒加载子目录）
  const browser = el("div", { class: "term-browser hidden" });
  let browserLoaded = false;
  const toggleBtn = el("button", { class: "btn btn-xs", type: "button", text: "浏览目录…", onclick: async () => {
    if (browser.classList.contains("hidden")) {
      browser.classList.remove("hidden");
      toggleBtn.textContent = "收起浏览";
      if (!browserLoaded) { browserLoaded = true; await loadFs(null); }
    } else {
      browser.classList.add("hidden");
      toggleBtn.textContent = "浏览目录…";
    }
  } });

  async function loadFs(path) {
    let r;
    try {
      r = await api("terminal/fs" + (path ? "?path=" + encodeURIComponent(path) : ""), { silent: true });
    } catch (e) {
      toast("读取目录失败：" + (e.detail ? format422(e.detail) : e.message), "error");
      return;
    }
    renderFs(r);
  }

  function renderFs(r) {
    browser.replaceChildren();
    // 面包屑：根 → 逐级
    const crumb = el("div", { class: "term-crumb" });
    if (!r.path) {
      crumb.append(el("span", { class: "term-crumb-item", text: "此电脑" }));
    } else {
      // parts[0] 形如 “D:”（盘符本身已带冒号），逐级重建各级目标路径
      const parts = String(r.path).split(/[\\/]+/).filter(Boolean);
      const driveLabel = /^[a-zA-Z]:?$/.test(parts[0] || "") ? parts[0].replace(/:$/, "") + ":" : null;
      parts.forEach((p, i) => {
        const label = i === 0 && driveLabel ? driveLabel : p;
        const target = parts.slice(0, i + 1).map((x, j) => (j === 0 ? driveLabel || x : x)).join("\\") + (driveLabel && i === 0 ? "\\" : "");
        crumb.append(
          el("span", { class: "term-crumb-item clickable", text: label, onclick: () => loadFs(target) }));
        if (i < parts.length - 1) crumb.append(el("span", { class: "term-crumb-sep", text: "\\" }));
      });
    }
    browser.append(crumb);

    const list = el("div", { class: "term-browser-list" });
    if (r.parent && r.parent !== r.path) {
      list.append(el("div", { class: "term-browser-item up", text: "← 上级目录", onclick: () => loadFs(r.parent) }));
    }
    if (!(r.entries || []).length) {
      list.append(el("div", { class: "term-browser-empty", text: "（无子目录）" }));
    }
    for (const e of r.entries || []) {
      list.append(el("div", {
        class: "term-browser-item", title: e.path,
        onclick: () => { cwdInput.value = e.path; loadFs(e.path); },
      }, el("span", { class: "term-dir-icon", text: "▸" }), el("span", { text: e.name })));
    }
    browser.append(list);
  }

  // 会话类型
  const opencodeOpt = el("label", { class: "term-kind" },
    el("input", { type: "radio", name: "term-kind", value: "opencode", checked: true, disabled: !check.opencode_found }),
    el("span", null, " opencode", check.opencode_found
      ? el("span", { class: "dim", text: "（AI 编码代理）" })
      : el("span", { class: "term-warn-text", text: "（未检测到）" })));
  const shellOpt = el("label", { class: "term-kind" },
    el("input", { type: "radio", name: "term-kind", value: "shell" }),
    el("span", null, " " + (check.shell_command || "shell"), el("span", { class: "dim", text: "（通用终端）" })));
  if (!check.opencode_found) {
    const shellRadio = shellOpt.querySelector("input");
    if (shellRadio) shellRadio.checked = true;
  }

  const errLine = el("div", { class: "term-modal-err" });
  const startBtn = el("button", { class: "btn btn-primary", type: "button", text: "启动会话", onclick: async () => {
    const cwd = cwdInput.value.trim();
    if (!cwd) { errLine.textContent = "请填写或选择项目目录"; return; }
    const kind = (browser.closest(".modal") || document).querySelector('input[name="term-kind"]:checked');
    startBtn.disabled = true;
    startBtn.textContent = "启动中…";
    try {
      const info = await api("terminal/sessions", { method: "POST", body: { cwd, kind: kind ? kind.value : "opencode" }, silent: true });
      mask.remove();
      addSession(info, { focus: true });
      refreshAll();
      toast("会话已启动：" + (info.title || cwd), "");
    } catch (e) {
      errLine.textContent = "启动失败：" + (e.detail ? format422(e.detail) : e.message);
      startBtn.disabled = false;
      startBtn.textContent = "启动会话";
    }
  } });

  const mask = el("div", { class: "modal-mask", onclick: (ev) => { if (ev.target === mask) mask.remove(); } },
    el("div", { class: "modal term-modal" },
      el("div", { class: "modal-title" }, el("b", { text: "新建终端会话" }),
        el("span", { class: "modal-close", text: "×", onclick: () => mask.remove() })),
      el("div", { class: "field" },
        el("label", { class: "f-label", text: "会话类型" }),
        el("div", { class: "term-kinds" }, opencodeOpt, shellOpt)),
      el("div", { class: "field" },
        el("label", { class: "f-label", text: "项目目录" }),
        el("div", { class: "term-cwd-row" }, cwdInput, toggleBtn),
        el("div", { class: "f-hint", text: "opencode 将在该目录下启动；也可直接粘贴路径" })),
      browser,
      errLine,
      el("div", { class: "modal-actions" },
        el("button", { class: "btn", type: "button", text: "取消", onclick: () => mask.remove() }),
        startBtn)));

  document.body.append(mask);
  cwdInput.focus();
}
