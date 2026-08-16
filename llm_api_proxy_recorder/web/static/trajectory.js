"use strict";
/* 轨迹页面：会话列表 + 会话轨迹账本（Turn 分组、增量消息、思考/工具调用、
   Inspector 详情、TTFT/Decoding 时间轴、搜索、折叠）。对齐 deepseek-harness 轨迹视图。 */

/* ============================================================ 消息工具 */
function trjTextOf(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p && typeof p === "object" && typeof p.text === "string") ? p.text : ""))
      .join(" ")
      .trim();
  }
  try { return JSON.stringify(content); } catch (_) { return String(content); }
}

function trjMsgPreview(m) {
  if (!m || typeof m !== "object") return "";
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    const names = m.tool_calls.map((tc) => (tc.function && tc.function.name) || "?").join(", ");
    const base = trjTextOf(m.content);
    return (base ? base + " · " : "") + "调用工具 " + names;
  }
  const text = trjTextOf(m.content);
  if (text) return text;
  if (m.reasoning_content) return "（仅思考过程）";
  return "";
}

const TRJ_ROLE = {
  system: { label: "SYSTEM", cls: "b-dim" },
  user: { label: "USER", cls: "b-ok" },
  assistant: { label: "ASSISTANT", cls: "b-role" },
  tool: { label: "TOOL", cls: "b-warn" },
};

function trjRoleChip(role) {
  const r = TRJ_ROLE[role] || { label: String(role || "?").toUpperCase(), cls: "b-dim" };
  return el("span", { class: "badge " + r.cls, text: r.label });
}

/* ============================================================ 会话列表 */
let trjListState = null;

async function renderTrajectoryList(view) {
  if (!trjListState) {
    trjListState = { date: "all", q: "", applied: { date: "all", q: "" } };
  }
  const st = trjListState;

  const dateSel = el("select");
  dateSel.append(el("option", { value: "all", text: "全部日期" }));
  const today = lastNDates(14)[0];
  lastNDates(14).forEach((d) => dateSel.append(el("option", { value: d, text: d + (d === today ? "（今天）" : "") })));
  dateSel.value = st.date;

  const qInput = el("input", { type: "text", placeholder: "搜索会话内容 / 模型", value: st.q, class: "w-220" });
  qInput.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });

  function apply() {
    st.date = dateSel.value;
    st.q = qInput.value.trim();
    refresh(false);
  }

  const tableBox = el("div");
  view.replaceChildren(
    el("div", { class: "card filter-bar" },
      el("div", { class: "filter-item" }, el("span", { class: "f-label", text: "日期" }), dateSel),
      el("div", { class: "filter-item" }, el("span", { class: "f-label", text: "关键字" }), qInput),
      el("button", { class: "btn", text: "应用", onclick: apply })),
    tableBox
  );

  async function refresh(silent) {
    const params = new URLSearchParams({ date: st.date || "all" });
    if (st.q) params.set("q", st.q);
    let data;
    try {
      data = await api("trajectory/sessions?" + params.toString(), { silent });
    } catch (e) {
      if (!silent) tableBox.replaceChildren(errorCard("加载会话列表失败：" + e.message, () => refresh(false)));
      return;
    }
    const sessions = data.sessions || [];
    if (!sessions.length) {
      tableBox.replaceChildren(el("section", { class: "card" }, emptyBox("暂无会话", "代理转发对话请求后，同一对话的多次调用会聚合为会话轨迹")));
      return;
    }
    const tb = el("tbody");
    sessions.forEach((s) => {
      const href = "#/trajectory/" + encodeURIComponent(s.session_key);
      tb.append(el("tr", { class: "row-link", onclick: () => { location.hash = href; } },
        el("td", { class: "path-cell", title: s.preview || "", text: s.solo ? "（单次调用）" : (s.preview || "—") }),
        el("td", { class: "mono", title: s.model || "", text: s.model || "—" }),
        el("td", { class: "mono num", text: fmtNum(s.calls) }),
        el("td", { class: "mono num", title: fmtNum(s.prompt_tokens), text: fmtTokens(s.prompt_tokens) }),
        el("td", { class: "mono num", title: fmtNum(s.completion_tokens), text: fmtTokens(s.completion_tokens) }),
        el("td", { class: "mono dim", title: s.last_started_at || "", text: fmtTime(s.last_started_at) }),
        el("td", null, statusCell({ status: s.last_status, status_code: null })),
        el("td", null, el("a", { class: "btn btn-xs", href, text: "轨迹" }))));
    });
    tableBox.replaceChildren(el("section", { class: "card" },
      el("div", { class: "card-head-row" },
        el("h2", { text: "会话（" + fmtNum(data.total || sessions.length) + "）" }),
        el("span", { class: "empty-hint", text: "按 模型 + system + 首条用户消息 自动聚合" })),
      el("div", { class: "tbl-wrap" }, el("table", { class: "tbl" },
        el("thead", null, el("tr", null,
          el("th", { text: "首条消息" }), el("th", { text: "模型" }), el("th", { text: "轮数", class: "num" }),
          el("th", { text: "输入 tok", class: "num" }), el("th", { text: "输出 tok", class: "num" }),
          el("th", { text: "最后活动" }), el("th", { text: "状态" }), el("th", { text: "操作" }))),
        tb))));
  }

  await refresh(false);
}

/* ============================================================ 会话轨迹 */
async function renderTrajectorySession(view, key) {
  let data;
  try {
    data = await api("trajectory/sessions/" + encodeURIComponent(key));
  } catch (e) {
    view.replaceChildren(errorCard(e.status === 404 ? "会话不存在" : "加载轨迹失败：" + e.message, () => route()));
    return;
  }
  const turns = data.turns || [];
  if (!turns.length) {
    view.replaceChildren(errorCard("该会话暂无已定稿的调用记录（后台解析可能尚未完成，稍后刷新试试）", () => route()));
    return;
  }

  const collapsed = new Set();
  let selected = null; // { kind: "msg"|"resp"|"toolcall", turn, message, tc }
  let needle = "";

  // ---- 顶部：返回 + 概要
  const cum = data.cumulative_usage || {};
  view.replaceChildren(
    el("div", { class: "detail-top" },
      el("a", { class: "btn btn-ghost", href: "#/trajectory", text: "← 返回会话列表" }),
      el("span", { class: "mono dim", text: data.session_key })),
    el("div", { class: "sum-bar" },
      sumItem("模型", data.model || "—"),
      sumItem("轮数", fmtNum(turns.length)),
      sumItem("累计输入", fmtTokens(cum.prompt_tokens)),
      sumItem("累计输出", fmtTokens(cum.completion_tokens)),
      sumItem("累计合计", fmtTokens(cum.total_tokens)),
      sumItem("开始", fmtTime(data.first_started_at)),
      sumItem("最后活动", fmtTime(data.last_started_at)))
  );

  // ---- 时间轴（TTFT 等待 + 生成解码 分段）
  const timelineCard = el("section", { class: "card" },
    el("div", { class: "card-head-row" },
      el("h2", { text: "时间轴" }),
      el("span", { class: "empty-hint", text: "浅色 = 等待（TTFT）· 深色 = 生成解码，宽度按实际时长" })));
  const maxDur = Math.max(1, ...turns.map((t) => Number(t.duration_ms) || 0));
  const tlRows = el("div", { class: "trj-timeline" });
  turns.forEach((t) => {
    const dur = Number(t.duration_ms) || 0;
    const ttft = Math.min(Math.max(Number(t.ttft_ms) || 0, 0), dur);
    const decode = Math.max(0, dur - ttft);
    const wTotal = (dur / maxDur) * 100;
    const wTtft = dur > 0 ? (ttft / dur) * 100 : 0;
    const tps = t.tokens_per_sec != null ? t.tokens_per_sec.toFixed(1) + " tok/s" : "—";
    const bar = el("div", { class: "trj-tl-bar", style: { width: wTotal + "%" } },
      el("span", { class: "trj-tl-wait", style: { width: wTtft + "%" } }),
      el("span", { class: "trj-tl-decode", style: { width: (100 - wTtft) + "%" } }));
    bar.title = `Turn ${t.turn_no} · Total ${fmtMs(dur)} · TTFT ${fmtMs(ttft)} · Decoding ${fmtMs(decode)} · ${tps}`;
    tlRows.append(el("div", {
      class: "trj-tl-row",
      onclick: () => { const sec = $("#trj-turn-" + t.turn_no); if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" }); },
    },
      el("span", { class: "trj-tl-label mono", text: "#" + t.turn_no }),
      el("div", { class: "trj-tl-track" }, bar),
      el("span", { class: "trj-tl-dur mono dim", text: fmtMs(dur) })));
  });
  timelineCard.append(tlRows);

  // ---- 工具栏
  const searchInput = el("input", { type: "text", placeholder: "在轨迹中搜索（过滤 Turn）", class: "w-220" });
  searchInput.addEventListener("input", () => {
    needle = searchInput.value.trim().toLowerCase();
    redrawLedger();
  });
  const toolbar = el("div", { class: "card filter-bar" },
    el("div", { class: "filter-item" }, el("span", { class: "f-label", text: "搜索" }), searchInput),
    el("button", { class: "btn", text: "全部展开", onclick: () => { collapsed.clear(); redrawLedger(); } }),
    el("button", { class: "btn", text: "全部折叠", onclick: () => { turns.forEach((t) => collapsed.add(t.turn_no)); redrawLedger(); } }));

  // ---- 布局：账本（左） + Inspector（右）
  const ledgerBox = el("div", { class: "trj-ledger" });
  const inspectorBox = el("aside", { class: "trj-inspector card" });
  const layout = el("div", { class: "trj-layout" }, ledgerBox, inspectorBox);
  view.append(timelineCard, toolbar, layout);

  // ---- Inspector 渲染
  function inspectorDefault() {
    inspectorBox.replaceChildren(
      el("h2", { text: "会话概览" }),
      el("div", { class: "meta-line", text: "点击左侧账本中的任意条目查看详情" }),
      el("div", { class: "msg-line" },
        el("span", { class: "chip", text: "轮数 " + turns.length }),
        el("span", { class: "chip", text: "输入 " + fmtTokens(cum.prompt_tokens) }),
        el("span", { class: "chip", text: "输出 " + fmtTokens(cum.completion_tokens) })));
  }

  function timingRows(t) {
    const u = t.usage || {};
    const cu = t.cumulative_usage || {};
    return el("div", { class: "trj-insp-sec" },
      el("h3", { text: "时序" }),
      trjKv("开始时间", fmtTime(t.started_at)),
      trjKv("总耗时", fmtMs(t.duration_ms)),
      trjKv("TTFT", fmtMs(t.ttft_ms)),
      trjKv("解码耗时", t.decode_ms != null ? t.decode_ms.toFixed(1) + " ms" : "—"),
      trjKv("吞吐", t.tokens_per_sec != null ? t.tokens_per_sec.toFixed(1) + " tok/s" : "—"),
      el("h3", { text: "Token 用量（本次 / 会话累计）" }),
      trjKv("输入", fmtNum(u.prompt_tokens) + " / " + fmtNum(cu.prompt_tokens)),
      u.cached_tokens != null ? trjKv("缓存命中", fmtNum(u.cached_tokens)) : null,
      u.reasoning_tokens != null ? trjKv("思考 token", fmtNum(u.reasoning_tokens)) : null,
      trjKv("输出", fmtNum(u.completion_tokens) + " / " + fmtNum(cu.completion_tokens)),
      trjKv("合计", fmtNum(u.total_tokens) + " / " + fmtNum(cu.total_tokens)));
  }

  function tabBody(kind, turn, payload) {
    const body = el("div");
    if (kind === "msg") {
      const m = payload;
      body.append(
        el("h3", { text: "内容" }),
        el("div", { class: "msg-line" }, trjRoleChip(m.role), m.name ? el("span", { class: "chip chip-dim", text: m.name }) : null),
        m.reasoning_content ? _trjBlock("思考过程", m.reasoning_content, "pre-reason") : null,
        m.content != null ? _trjBlock("内容", trjTextOf(m.content), "pre-content") : null,
        Array.isArray(m.tool_calls) ? trjToolCallList(m.tool_calls) : null,
        el("h3", { text: "Raw" }), jsonViewer(m),
        timingRows(turn));
    } else if (kind === "resp") {
      const m = payload || {};
      body.append(
        el("h3", { text: "响应内容" }),
        el("div", { class: "msg-line" },
          trjRoleChip("assistant"),
          turn.finish_reason ? el("span", { class: "chip chip-dim", text: "finish: " + turn.finish_reason }) : null,
          turn.stream ? el("span", { class: "chip chip-dim", text: "流式" }) : null),
        m.reasoning_content
          ? el("details", { class: "raw-chunks" },
              el("summary", { text: "思考过程（" + m.reasoning_content.length + " 字，默认折叠）" }),
              el("pre", { class: "pre-block pre-reason", text: m.reasoning_content }))
          : null,
        m.content != null && m.content !== "" ? _trjBlock("回复内容", trjTextOf(m.content), "pre-content") : null,
        Array.isArray(m.tool_calls) && m.tool_calls.length ? trjToolCallList(m.tool_calls) : null,
        !m.content && !(Array.isArray(m.tool_calls) && m.tool_calls.length) && !m.reasoning_content
          ? el("div", { class: "empty-hint", text: "（无组装内容）" }) : null,
        turn.error ? el("div", { class: "banner banner-err", style: { marginTop: "10px" } },
          el("b", { text: "错误：" }), (turn.error.type || "") + " " + (turn.error.message || "")) : null,
        turn.parse_error ? el("div", { class: "banner banner-warn", style: { marginTop: "10px" } },
          el("b", { text: "解析警告：" }), turn.parse_error) : null,
        el("h3", { text: "Raw" }), jsonViewer(m),
        timingRows(turn));
    } else {
      const tc = payload;
      const fn = tc.function || {};
      let args;
      try { args = JSON.parse(fn.arguments); } catch (_) { args = fn.arguments; }
      body.append(
        el("h3", { text: "工具调用" }),
        el("div", { class: "msg-line" },
          el("span", { class: "chip chip-tool", text: tc.type || "function" }),
          el("span", { class: "mono", text: fn.name || "" }),
          tc.id ? el("span", { class: "mono dim", text: tc.id }) : null),
        el("h3", { text: "参数" }),
        typeof args === "string" ? el("pre", { class: "pre-block", text: args }) : jsonViewer(args),
        timingRows(turn));
    }
    return body;
  }

  function renderInspector() {
    if (!selected) { inspectorDefault(); return; }
    const { kind, turn, payload } = selected;
    let title;
    if (kind === "msg") title = "消息 · Turn " + turn.turn_no;
    else if (kind === "resp") title = "响应 · Turn " + turn.turn_no;
    else title = "工具调用 · Turn " + turn.turn_no;
    inspectorBox.replaceChildren(
      el("h2", { text: title }),
      el("div", { class: "meta-line" },
        el("a", { href: "#/calls/" + encodeURIComponent(turn.call_id), text: "查看完整调用记录 →" })),
      tabBody(kind, turn, payload));
  }

  // ---- 账本渲染
  function cellNode(kind, turn, payload, badge, preview, extra) {
    const node = el("div", {
      class: "trj-cell" + (selected && selected.kind === kind && selected.payload === payload && selected.turn === turn ? " sel" : ""),
      onclick: () => { selected = { kind, turn, payload }; redrawSelection(); },
    },
      el("span", { class: "trj-cell-badge" }, badge),
      el("span", { class: "trj-cell-text", title: preview, text: preview }));
    if (extra) node.append(extra);
    return node;
  }

  function turnSection(t) {
    const u = t.usage || {};
    const cu = t.cumulative_usage || {};
    const respMsg = t.response_message;
    const sec = el("section", {
      class: "card trj-turn" + (collapsed.has(t.turn_no) ? " collapsed" : ""),
      id: "trj-turn-" + t.turn_no,
    });
    // Turn 头（点击折叠/展开）
    const head = el("div", {
      class: "trj-turn-head",
      onclick: (e) => {
        if (e.target.closest("a")) return;
        if (collapsed.has(t.turn_no)) collapsed.delete(t.turn_no); else collapsed.add(t.turn_no);
        sec.classList.toggle("collapsed");
      },
    },
      el("span", { class: "trj-turn-no mono", text: "#" + t.turn_no }),
      statusCell(t, true),
      el("span", { class: "mono dim", text: t.model || "—" }),
      el("span", { class: "chip chip-dim", text: fmtMs(t.duration_ms) }),
      t.ttft_ms != null ? el("span", { class: "chip chip-dim", text: "TTFT " + fmtMs(t.ttft_ms) }) : null,
      t.tokens_per_sec != null ? el("span", { class: "chip chip-dim", text: t.tokens_per_sec.toFixed(1) + " tok/s" }) : null,
      el("span", { class: "chip", text: `in ${fmtTokens(u.prompt_tokens)} · out ${fmtTokens(u.completion_tokens)}` }),
      el("span", { class: "chip chip-dim", text: `累计 ${fmtTokens(cu.total_tokens)}` }),
      t.finish_reason ? el("span", { class: "chip chip-dim", text: t.finish_reason }) : null,
      el("span", { class: "filter-spacer" }),
      el("span", { class: "mono dim", title: t.started_at || "", text: fmtTime(t.started_at) }),
      el("a", { class: "btn btn-xs", href: "#/calls/" + encodeURIComponent(t.call_id), text: "调用" }));
    // 账本条目
    const cells = el("div", { class: "trj-cells" });
    (t.new_messages || []).forEach((m, i) => {
      cells.append(cellNode("msg", t, m, trjRoleChip(m.role),
        trjMsgPreview(m) || "（空）",
        m.name ? el("span", { class: "chip chip-dim trj-cell-extra", text: m.name }) : null));
    });
    if (!t.new_messages || !t.new_messages.length) {
      cells.append(el("div", { class: "trj-cell dim" }, el("span", { class: "trj-cell-badge" }, el("span", { class: "badge b-dim", text: "CONTEXT" })), el("span", { class: "trj-cell-text dim", text: "（与上一轮请求一致，无新增消息）" })));
    }
    if (t.error && t.error.type === "upstream_unreachable") {
      cells.append(el("div", { class: "trj-cell err" }, el("span", { class: "trj-cell-text", text: "上游不可达：" + (t.error.message || "") })));
    }
    if (respMsg && typeof respMsg === "object") {
      if (respMsg.reasoning_content) {
        cells.append(cellNode("resp", t, respMsg,
          el("span", { class: "badge b-think", text: "THINKING" }),
          `思考过程 · ${respMsg.reasoning_content.length} 字（点击展开详情）`));
      }
      if (respMsg.tool_calls) {
        respMsg.tool_calls.forEach((tc) => {
          const fn = (tc && tc.function) || {};
          cells.append(cellNode("toolcall", t, tc,
            el("span", { class: "chip chip-tool", text: "TOOL CALL" }),
            (fn.name || "?") + " " + trjTextOf(fn.arguments).slice(0, 120)));
        });
      }
      const contentText = trjTextOf(respMsg.content);
      if (contentText || !respMsg.tool_calls) {
        cells.append(cellNode("resp", t, respMsg,
          trjRoleChip("assistant"),
          contentText || (respMsg.reasoning_content ? "（仅思考过程，无正文）" : "（无内容）")));
      }
    } else if (!t.error) {
      cells.append(el("div", { class: "trj-cell dim" }, el("span", { class: "trj-cell-text dim", text: "（响应未解析或为空）" })));
    }
    sec.append(head, cells);
    return sec;
  }

  function redrawLedger() {
    const box = el("div");
    turns.forEach((t) => {
      if (needle) {
        const text = JSON.stringify([t.new_messages, t.response_message]).toLowerCase();
        if (!text.includes(needle)) return;
      }
      box.append(turnSection(t));
    });
    if (!box.childNodes.length) {
      box.append(el("section", { class: "card" }, emptyBox("没有匹配的 Turn", "调整搜索关键字试试")));
    }
    ledgerBox.replaceChildren(box);
    renderInspector();
  }

  function redrawSelection() {
    ledgerBox.querySelectorAll(".trj-cell.sel").forEach((n) => n.classList.remove("sel"));
    if (selected) {
      // 重新标记选中（简单做法：整体重绘选中所在 turn 的样式）
      redrawLedger();
      return;
    }
    renderInspector();
  }

  redrawLedger();
}

/* ============================================================ 小组件 */
function _trjBlock(title, text, cls) {
  return el("div", { class: "msg-block" },
    el("span", { class: "lbl", text: title }),
    el("pre", { class: "pre-block " + (cls || ""), text: String(text) }));
}

function trjKv(k, v) {
  return el("div", { class: "trj-kv" },
    el("span", { class: "trj-kv-k", text: k }),
    el("span", { class: "trj-kv-v mono", text: v }));
}

function trjToolCallList(toolCalls) {
  const box = el("div", { class: "trj-insp-sec" });
  box.append(el("h3", { text: "工具调用（" + toolCalls.length + "）" }));
  toolCalls.forEach((tc, i) => {
    const fn = (tc && tc.function) || {};
    let args;
    try { args = JSON.parse(fn.arguments); } catch (_) { args = fn.arguments; }
    box.append(el("div", { class: "toolcall" },
      el("div", { class: "msg-line" },
        el("span", { class: "chip chip-tool", text: "#" + i + " " + (tc.type || "function") }),
        el("span", { class: "mono", text: fn.name || "" }),
        tc.id ? el("span", { class: "mono dim", text: tc.id }) : null),
      typeof args === "string" ? el("pre", { class: "pre-block", text: args }) : jsonViewer(args)));
  });
  return box;
}
