"use strict";
/* 设置页：上游管理 / 出站代理 / 记录设置 / 服务设置 + 连通性测试 + 保存 */

function renderSettings(view) {
  view.replaceChildren(el("div", { class: "loading", text: "加载中…" }));
  (async () => {
    let settings, meta;
    try {
      [settings, meta] = await Promise.all([api("settings"), api("meta")]);
    } catch (e) {
      view.replaceChildren(errorCard("加载设置失败：" + e.message, () => route()));
      return;
    }
    const cfg = settings.config;

    // 上游数据副本（_extraText 为 extra_headers 的多行文本编辑态）
    const ups = cfg.upstreams.map((u) => Object.assign({}, u, {
      _extraText: Object.entries(u.extra_headers || {}).map(([k, v]) => k + "=" + v).join("\n"),
    }));
    const originalNames = new Set(cfg.upstreams.map((u) => u.name));
    let defaultUp = cfg.default_upstream;

    const restartBanner = el("div", { class: "banner banner-warn hidden" },
      el("b", { text: "⚠ 监听配置已变更：" }), "host / port / admin_prefix 属于监听配置，需重启服务后生效");
    const errBanner = el("div", { class: "banner banner-err hidden" });

    const metaItem = (label, value) => el("div", { class: "meta-item" },
      el("div", { class: "m-label", text: label }),
      el("div", { class: "m-value", title: value, text: value }));

    view.replaceChildren(
      el("section", { class: "card meta-bar" },
        metaItem("版本", "v" + (meta.version || "—")),
        metaItem("配置文件", settings.config_path || "—"),
        metaItem("记录目录", settings.records_dir || "—")),
      restartBanner,
      errBanner
    );

    /* ---------------- 工具 */
    const field = (label, control, hint) => el("div", { class: "field" },
      el("label", { class: "f-label", text: label }), control,
      hint ? el("div", { class: "f-hint", text: hint }) : null);

    function parseExtra(text) {
      const out = {};
      String(text || "").split("\n").forEach((line) => {
        line = line.trim();
        if (!line) return;
        const i = line.indexOf("=");
        if (i <= 0) return; // 非法行忽略
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      return out;
    }
    const splitCsv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

    /* ---------------- 上游行 */
    const upBox = el("div");
    function renderUps() {
      upBox.replaceChildren();
      ups.forEach((u) => upBox.append(upCard(u)));
    }

    function upCard(u) {
      const nameIn = el("input", { type: "text", value: u.name, placeholder: "名称，如 deepseek", class: "mono" });
      nameIn.addEventListener("input", () => {
        const old = u.name;
        u.name = nameIn.value.trim();
        if (defaultUp === old) defaultUp = u.name; // 默认上游改名跟随
      });
      const urlIn = el("input", { type: "text", value: u.base_url, placeholder: "https://api.example.com", class: "mono" });
      urlIn.addEventListener("input", () => { u.base_url = urlIn.value.trim(); });
      const keyIn = el("input", { type: "password", value: u.api_key || "", placeholder: "sk-…（留空表示无密钥）", class: "mono", autocomplete: "off" });
      keyIn.addEventListener("input", () => { u.api_key = keyIn.value; });
      const eye = el("button", { class: "btn btn-xs", type: "button", text: "显示", title: "切换明文显示", onclick: () => {
        const show = keyIn.type === "password";
        keyIn.type = show ? "text" : "password";
        eye.textContent = show ? "隐藏" : "显示";
      } });
      const stratSel = el("select",
        el("option", { value: "replace", text: "replace（注入上游密钥）" }),
        el("option", { value: "keep", text: "keep（透传客户端密钥）" }));
      stratSel.value = u.key_strategy || "replace";
      stratSel.addEventListener("change", () => { u.key_strategy = stratSel.value; });
      const extraTa = el("textarea", { rows: "2", class: "mono", placeholder: "extra_headers，每行一条：Header=Value" });
      extraTa.value = u._extraText || "";
      extraTa.addEventListener("input", () => { u._extraText = extraTa.value; });

      const radio = el("input", { type: "radio", name: "up-default", checked: u.name === defaultUp });
      radio.addEventListener("change", () => {
        if (radio.checked) { defaultUp = u.name; renderUps(); }
      });

      const testRes = el("span", { class: "test-res" });
      const testBtn = el("button", { class: "btn btn-xs", type: "button", text: "测试连通性", onclick: async () => {
        testBtn.disabled = true;
        testRes.className = "test-res dim";
        testRes.textContent = " 测试中…";
        const body = {};
        if (u.name && originalNames.has(u.name)) body.name = u.name; // 已保存过的上游可用 name
        if (u.base_url) body.base_url = u.base_url;
        if (u.api_key) body.api_key = u.api_key;
        try {
          const r = await api("settings/test-upstream", { method: "POST", body, silent: true });
          if (r.ok) {
            testRes.className = "test-res ok";
            testRes.textContent = ` ✓ HTTP ${r.status_code} · ${r.latency_ms} ms`;
          } else {
            testRes.className = "test-res err";
            testRes.textContent = ` ✗ ${r.status_code != null ? "HTTP " + r.status_code + " · " : ""}${r.error || "失败"}`;
          }
        } catch (e) {
          testRes.className = "test-res err";
          testRes.textContent = " ✗ " + (e.detail ? format422(e.detail) : e.message);
        }
        testBtn.disabled = false;
      } });
      const delBtn = el("button", { class: "btn btn-xs btn-danger", type: "button", text: "删除", onclick: () => {
        const i = ups.indexOf(u);
        if (i >= 0) ups.splice(i, 1);
        if (defaultUp === u.name && ups.length) defaultUp = ups[0].name;
        renderUps();
      } });

      return el("div", { class: "up-card" },
        el("div", { class: "up-head" },
          el("label", { class: "default-pick", title: "设为默认上游" }, radio, el("span", { text: "默认" })),
          field("名称", nameIn),
          field("转发策略", stratSel),
          delBtn),
        field("base_url", urlIn),
        field("api_key", el("span", { class: "inline-controls" }, keyIn, eye)),
        field("extra_headers", extraTa),
        el("div", { class: "up-actions" }, testBtn, testRes));
    }

    renderUps();
    const addBtn = el("button", { class: "btn", type: "button", text: "+ 添加上游", onclick: () => {
      ups.push({ name: "", base_url: "https://", api_key: "", extra_headers: {}, key_strategy: "replace", _extraText: "" });
      renderUps();
    } });

    view.append(el("section", { class: "card" },
      el("div", { class: "card-head-row" },
        el("h2", { text: "上游服务" }),
        el("span", { class: "empty-hint", text: "修改需点击底部保存后生效" })),
      upBox, addBtn));

    /* ---------------- 出站代理 */
    const proxyIn = el("input", { type: "text", value: cfg.outbound.proxy_url || "", placeholder: "http://127.0.0.1:7890 或 socks5://…", class: "mono" });
    view.append(el("section", { class: "card" }, el("h2", { text: "出站代理" }),
      field("proxy_url", proxyIn, "留空 = 直连；支持 http:// / https:// / socks5://")));

    /* ---------------- 记录设置 */
    const dirIn = el("input", { type: "text", value: cfg.recording.dir, class: "mono", placeholder: "~/.llm-api-proxy-recorder/records" });
    const rhIn = el("input", { type: "text", value: (cfg.recording.redact_headers || []).join(", "), class: "mono", placeholder: "authorization, x-api-key, …" });
    const maxIn = el("input", { type: "number", value: cfg.recording.max_capture_mb, min: "0.1", step: "0.5", style: { width: "120px" } });
    const mkSwitch = (label, checked) => {
      const input = el("input", { type: "checkbox", checked });
      return [el("label", { class: "switch" }, input, el("span", { class: "slider" }), el("span", { class: "switch-label", text: label })), input];
    };
    const [redactSw, redactChk] = mkSwitch("脱敏敏感头（redact）", cfg.recording.redact);
    const [rrqSw, rrqChk] = mkSwitch("记录请求头", cfg.recording.record_request_headers);
    const [rspSw, rspChk] = mkSwitch("记录响应头", cfg.recording.record_response_headers);
    const [rchunkSw, rchunkChk] = mkSwitch("记录原始 SSE 分块（raw_chunks）", cfg.recording.record_raw_chunks);

    view.append(el("section", { class: "card" }, el("h2", { text: "记录设置" }),
      el("div", { class: "settings-grid" },
        el("div", { class: "field full" }, el("label", { class: "f-label", text: "记录目录 dir" }), dirIn,
          el("div", { class: "f-hint", text: "支持 ~ 展开；修改后立即对新记录生效" })),
        el("div", { class: "field full" }, el("label", { class: "f-label", text: "脱敏头列表 redact_headers（逗号分隔）" }), rhIn),
        redactSw, rrqSw, rspSw, rchunkSw,
        el("div", { class: "field" }, el("label", { class: "f-label", text: "单次捕获上限 max_capture_mb" }), maxIn,
          el("div", { class: "f-hint", text: "请求/响应体超过该大小将被截断记录" })))));

    /* ---------------- 服务设置 */
    const hostIn = el("input", { type: "text", value: cfg.server.host, class: "mono" });
    const portIn = el("input", { type: "number", value: cfg.server.port, style: { width: "120px" } });
    const prefixIn = el("input", { type: "text", value: cfg.server.admin_prefix, class: "mono" });
    view.append(el("section", { class: "card" },
      el("h2", null, "服务设置", el("span", { class: "tag-warn", text: "需重启生效" })),
      el("div", { class: "settings-grid" },
        el("div", { class: "field" }, el("label", { class: "f-label", text: "监听地址 host" }), hostIn),
        el("div", { class: "field" }, el("label", { class: "f-label", text: "端口 port" }), portIn),
        el("div", { class: "field" }, el("label", { class: "f-label", text: "管理路径前缀 admin_prefix" }), prefixIn,
          el("div", { class: "f-hint", text: "必须以 / 开头" })))));

    /* ---------------- 保存 */
    const saveBtn = el("button", { class: "btn btn-primary", text: "保存设置", onclick: save });
    async function save() {
      errBanner.classList.add("hidden");
      const body = {
        server: {
          host: hostIn.value.trim() || "127.0.0.1",
          port: parseInt(portIn.value, 10) || 0,
          admin_prefix: prefixIn.value.trim(),
        },
        upstreams: ups.map((u) => ({
          name: u.name,
          base_url: u.base_url,
          api_key: u.api_key || "",
          extra_headers: parseExtra(u._extraText),
          key_strategy: u.key_strategy || "replace",
        })),
        default_upstream: defaultUp,
        outbound: { proxy_url: proxyIn.value.trim() },
        recording: {
          dir: dirIn.value.trim() || "~/.llm-api-proxy-recorder/records",
          redact: redactChk.checked,
          redact_headers: splitCsv(rhIn.value),
          record_request_headers: rrqChk.checked,
          record_response_headers: rspChk.checked,
          record_raw_chunks: rchunkChk.checked,
          max_capture_mb: parseFloat(maxIn.value) || 20,
        },
      };
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      try {
        const r = await api("settings", { method: "PUT", body });
        toast("已保存", "ok");
        restartBanner.classList.toggle("hidden", !r.restart_required);
        if (r.restart_required) restartBanner.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {
        errBanner.classList.remove("hidden");
        errBanner.replaceChildren(el("b", { text: e.status === 422 ? "校验失败：" : "保存失败：" }),
          e.status === 422 || e.detail
            ? el("pre", { class: "pre-block", text: e.detail ? format422(e.detail) : e.message })
            : String(e.message));
      }
      saveBtn.disabled = false;
      saveBtn.textContent = "保存设置";
    }
    view.append(el("div", { class: "save-bar" }, saveBtn));
  })();
}
