# llm-api-proxy-recorder

本地大模型 API 代理记录器：**透明转发**所有 LLM API 请求/响应（含流式 SSE），同时**旁路落盘**完整调用明细，并提供 Web 管理界面与轨迹分析。

> 设计原则：代理转发零侵入——所有请求/响应逐字节透传、不改任何头；解析与记录全部在旁路异步完成，任何写盘失败只记日志告警，绝不中断代理流。

## 功能特性

- **透明代理**：按上游 `base_url` 拼接转发，请求/响应（含流式 SSE 分块、gzip、JSON）原样透传
- **完整录制**：请求体/响应体、SSE 分块、时间戳（TTFT/首字节/解码耗时/token 吞吐）、headers、工具调用，落盘 JSON + JSONL 索引
- **多上游路由**：`/up/{name}/...` 前缀选择命名上游，其余走默认上游
- **会话轨迹（Trajectory）**：按轮次（Turn）聚合的调用时间轴，支持 Inspector 多 Tab 结构化查看
  - Summary / Preview（Markdown 渲染）/ Raw / System Prompt（行级 diff）/ Tools（增删对比）/ Options / Usage（Token 柱状图）/ Timing / Source / Headers / Chunks
- **数据清理**：按日期删除、清空全部、保留策略（`retention_days` 自动清理），调用详情页单条删除
- **脱敏**：请求头可配置脱敏（`authorization` 等），记录时替换为 `***`
- **凭据透传**：`key_strategy` 默认 `keep`，完整透传客户端凭据头；可选 `replace` 注入上游 key
- **Web 终端**（Windows）：浏览器中启动多个 opencode / shell 会话，选择项目目录、目录浏览器导航、多 tab 并行、断线自动重连、会话在服务重启前保活

## 环境要求

- Python ≥ 3.10
- 依赖：FastAPI / uvicorn / httpx / pydantic（见 `pyproject.toml`）
- Web 终端功能仅限 Windows（依赖 `pywinpty` ConPTY），且需 `opencode` 在 PATH 中（可选，缺失时仍可启动 shell 会话）

## 安装

```bash
cd llm-api-proxy-recorder

# 创建虚拟环境并安装（含开发依赖）
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## 快速开始

### 1. 准备配置

首次启动若配置文件不存在会自动生成默认配置并写盘。**本仓库约定**使用项目本地配置，避免 macOS 沙盒无法写入家目录的问题：

```bash
# 复制一份配置文件（首次启动后会自动生成，也可手工创建）
# .runtime/ 已在 .gitignore 中，仅本机有效
```

`.runtime/config.json` 结构示例：

```jsonc
{
  "server": {
    "host": "127.0.0.1",
    "port": 8117,
    "admin_prefix": "/__recorder"
  },
  "upstreams": [
    {
      "name": "deepseek",
      "base_url": "https://api.deepseek.com",
      "api_key": "sk-xxxxxxxxxxxxxxxx",   // key_strategy=keep 时不注入，仅 replace 用
      "extra_headers": {},
      "key_strategy": "keep"              // keep=透传客户端凭据 | replace=注入上游 key
    }
  ],
  "default_upstream": "deepseek",
  "outbound": { "proxy_url": "" },        // 出站代理，支持 http/https/socks5，空=直连
  "recording": {
    "dir": "/path/to/.runtime/records",   // 记录存储目录
    "redact": true,                       // 请求头脱敏
    "redact_headers": ["authorization", "x-api-key", "api-key", "cookie"],
    "session_id_headers": ["x-deepseek-harness-session-id", "x-session-id"],
    "record_request_headers": true,
    "record_response_headers": true,
    "record_raw_chunks": false,           // 是否记录原始 SSE 分块
    "max_capture_mb": 20.0,               // 单次请求/响应体截断阈值
    "retention_days": 0                   // 保留天数，0=永久；>0 启动+每小时自动清理
  }
}
```

### 2. 启动

```bash
.venv/bin/llm-api-proxy-recorder --config .runtime/config.json
# 等价：.venv/bin/python -m llm_api_proxy_recorder --config .runtime/config.json
```

CLI 参数：

| 参数 | 说明 |
|---|---|
| `--host` | 监听地址（默认 `127.0.0.1`） |
| `--port` | 监听端口（默认 `8117`） |
| `--config` | 配置文件路径（默认 `~/.llm-api-proxy-recorder/config.json`） |
| `--records-dir` | 记录目录（覆盖 `recording.dir`，仅本次生效） |
| `--admin-prefix` | 管理路径前缀（默认 `/__recorder`） |

### 3. 访问地址

| 用途 | 地址 |
|---|---|
| Web 管理界面 | http://127.0.0.1:8117/__recorder/ |
| 代理入口 | http://127.0.0.1:8117 |
| 多上游路由 | http://127.0.0.1:8117/up/{name}/v1/chat/completions |

### 4. 通过代理调用

```bash
# 非流式（走默认上游）
curl http://127.0.0.1:8117/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'

# 流式 SSE
curl -N http://127.0.0.1:8117/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{"model":"deepseek-reasoner","stream":true,"messages":[{"role":"user","content":"1+1=?"}]}'

# 指定上游
curl http://127.0.0.1:8117/up/deepseek/v1/chat/completions -H "Content-Type: application/json" ...
```

调用后访问 Web UI，即可在「调用列表」「轨迹」中查看记录。

## Web 管理界面

| 页面 | 说明 |
|---|---|
| 仪表盘 | 概览统计（记录数、错误、token 等） |
| 调用列表 | 分页/过滤/搜索全部调用，可进入详情，详情页可删除单条 |
| 轨迹 | 按会话聚合的时间轴 + 轮次账本，右侧 Inspector 多 Tab 分析 |
| 终端 | 浏览器中的多会话终端（opencode / shell），详见下方「Web 终端」 |
| 设置 | 上游服务（含测试连通）、出站代理、记录设置、**数据清理**、Web 终端 |

## Web 终端

在浏览器中直接操作命令行版 opencode（或通用 shell），无需手动 cd 目录：

1. 打开 Web UI → 「终端」→「+ 新建会话」
2. 选择会话类型（opencode / shell），通过**目录浏览器**（盘符 → 逐级子目录，支持面包屑跳转）或直接粘贴路径选择项目目录
3. 「启动会话」即在该目录下通过 ConPTY 启动 opencode TUI，完整界面渲染在浏览器 xterm.js 中
4. 多个项目可同时开启会话，tab / 侧栏切换；关闭 tab 即终止进程；意外退出可一键重启（同目录同类型）

行为细节：

- 会话由服务端托管，**浏览器关闭/断网不杀进程**，重新打开自动恢复；WebSocket 断线自动重连并回放缓冲
- opencode 会话默认注入 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 指向本代理（可在设置中关闭或指定上游），LLM 调用即被完整录制
- 相关设置：设置页「Web 终端」（命令、默认 shell、最大会话数、滚动缓冲、代理联动）

## 管理端 API

前缀 `{admin_prefix}/api`，默认 `/__recorder/api`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/overview` | 仪表盘概览统计 |
| GET | `/calls` | 调用列表（分页/过滤） |
| GET | `/calls/{id}` | 调用详情 |
| DELETE | `/calls/{id}` | 删除单条记录 |
| GET | `/records/stats` | 存储统计（每日期文件数/字节数） |
| DELETE | `/records/date/{date}` | 删除某日期全部记录（`YYYY-MM-DD`） |
| DELETE | `/records/all` | 清空全部记录 |
| POST | `/records/cleanup` | 手动执行保留策略清理 |
| GET | `/trajectory/sessions` | 轨迹会话列表 |
| GET | `/trajectory/sessions/{key}` | 轨迹会话详情（Turns） |
| GET | `/settings` | 读取配置 |
| PUT | `/settings` | 保存配置（部分项需重启） |
| POST | `/settings/test-upstream` | 测试上游连通性 |
| GET | `/meta` | 服务元信息 |
| GET | `/terminal/check` | 检测 opencode / shell 命令 |
| GET | `/terminal/sessions` | 终端会话列表 |
| POST | `/terminal/sessions` | 创建会话（`cwd` / `kind` / 尺寸） |
| DELETE | `/terminal/sessions/{id}` | 终止会话 |
| GET | `/terminal/fs` | 目录浏览（无 `path` → 盘符列表） |
| WS | `/terminal/ws/{id}` | 终端流（输入/resize；输出二进制帧） |

## 数据存储

记录文件存放于 `recording.dir`（默认 `~/.llm-api-proxy-recorder/records`，本仓库为 `.runtime/records`）：

```
records/
├── calls/
│   └── 2026-08-16/
│       ├── c20260816_182552_a1b272.json          # 最终记录
│       └── c20260816_182552_a1b272.partial.json  # 请求时占位（响应后定稿删除）
└── index/
    └── 2026-08-16.jsonl                          # 当日索引行
```

- 写盘采用**原子写**（临时文件 + `os.replace`），崩溃不产生半截文件
- 上游中途断流也会以 `status=error` 定稿，保留已收到分片

## 测试

```bash
.venv/bin/python -m pytest tests/ -q
```

覆盖：代理转发、SSE 解析、录制/索引、轨迹聚合、数据清理等（当前 113 个用例）。

## 目录结构

```
llm_api_proxy_recorder/
├── admin/api.py        # 管理端 API
├── app.py              # FastAPI 应用工厂 + 保留清理后台任务
├── cli.py              # CLI 入口
├── config.py           # Pydantic 配置模型 + 加载/保存
├── proxy/
│   ├── client.py       # 上游 HTTP 客户端
│   ├── handler.py      # 透明代理转发 + 旁路录制
│   └── router.py       # 多上游路由
├── recording/
│   ├── models.py       # 录制数据模型
│   ├── parse.py        # 请求/响应解析（含会话归属、轨迹 Turn）
│   ├── redact.py       # 头脱敏
│   ├── sse.py          # SSE 解析器
│   └── store.py        # 文件存储/索引/清理/统计
├── terminal/           # Web 终端（Windows ConPTY）
│   ├── manager.py      # PTY 会话管理（spawn/IO 泵/缓冲/生命周期）
│   └── routes.py       # 会话 CRUD + 目录浏览 + WebSocket
└── web/static/         # Web UI（原生 JS：app/calls/trajectory/settings/terminal 等）
```
