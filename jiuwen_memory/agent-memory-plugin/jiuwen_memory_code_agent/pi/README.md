# JiuwenMemory for pi

> Persistent cross-session memory for [pi](https://github.com/mariozechner/pi-coding-agent) via **jiuwen-memory** server.
>
> pi 扩展，通过 **jiuwen-memory** 服务实现跨会话持久记忆。3 个生命周期 hook + 2 个工具 + 1 个命令，直接调用 memory_server 的 REST API。

## 它做什么

把 jiuwen-memory 作为 pi 的扩展接入。pi 运行时：

- `session_start` — 仅探测 `/health`（不搜索记忆），并设置 footer 状态 `🧠 jiuwen` / `🧠 jiuwen off`。与其它 code-agent 的 `session-start` 行为一致。
- `before_agent_start` — 用当前 prompt 搜索记忆（`/search_memory/` + `/search_user_history_summary/`），把结果 + 记忆能力说明注入 **system prompt**。等价于其它 agent 的 `UserPromptSubmit` 搜索注入部分。
- `agent_end` — 把这一轮**用户输入的 prompt** 后台写入记忆（`/add_messages/`）。延后到 agent 回复结束写入，避免打断对话——与 OpenCode 插件的「`chat.message` 存 pending → `message.updated` 落库」策略一致。

工具侧暴露 `memory_search` / `memory_save` 两个工具，外加 `/jiuwen-status` 命令。

> **写入策略（与 Claude Code / Codex / OpenCode 完全一致）**：只记录**用户输入的 prompt**。Agent 的回答、工具调用结果、子 agent 结果**都不写入**记忆——`agent_end` 只持久化 `lastPrompt`。

## 前置条件

只需启动 jiuwen-memory 的 memory_server：

```bash
python -m jiuwen_memory.server.memory_server     # 默认 127.0.0.1:8000
```

验证：

```bash
curl http://127.0.0.1:8000/health    # {"status":"healthy",...}
```

所有 hook 和工具都直接调用 memory_server 的 REST API，无其它服务依赖。pi 也会自动加载 `@mariozechner/pi-coding-agent` 类型和 `typebox`（`Type`）——前者由 pi 运行时提供，后者需随扩展安装。

## 安装

把本目录拷进 pi 的全局扩展目录：

```bash
mkdir -p ~/.pi/agent/extensions/jiuwen-memory
cp jiuwen_memory/agent-memory-plugin/jiuwen_memory_code_agent/pi/* ~/.pi/agent/extensions/jiuwen-memory/
```

然后在 `~/.pi/agent/settings.json` 显式启用（也可被 pi 自动发现并 `/reload` 热重载）：

```json
{
  "extensions": ["~/.pi/agent/extensions/jiuwen-memory"]
}
```

重启 pi 后生效。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `JIUWEN_MEMORY_URL` | `http://localhost:8000` | memory_server REST API 地址 |
| `JIUWEN_MEMORY_API_KEY` | (无) | Bearer token；服务端开启 `MEMORY_API_KEY` 鉴权时必填 |
| `JIUWEN_USER_ID` | `pi-user` | 记忆归属的用户 id；显式设置则覆盖 `pi-user` 默认值 |
| `JIUWEN_MEMORY_PROJECT_NAME` | (无) | 覆盖项目名（默认取 git toplevel basename 作为 `scope_id`） |
| `JIUWEN_MEMORY_REQUIRE_HTTPS` | (off) | 设为 `1` 时，若用明文 HTTP + 非 loopback 地址 + 配了 `JIUWEN_MEMORY_API_KEY`，直接报错；否则只警告一次 |
| `JIUWEN_PI_DEBUG` | (off) | 设 `1` 开启扩展调试日志（stderr） |

> **user_id 默认值**：未设 `JIUWEN_USER_ID` 时，pi 用 `pi-user`——与 Claude Code（`cc-user`）/ Codex（`codex-user`）/ OpenCode（`opencode-user`）隔离，避免共用同一份 hook 脚本时记忆互相串掉。每个 user 的记忆在服务端天然隔离。
>
> **scope 隔离**：`scope_id = resolveProject(cwd)`（git toplevel basename），每个项目的记忆相互隔离，可用 `JIUWEN_MEMORY_PROJECT_NAME` 覆盖。

## hook → 端点映射

| hook | memory_server 端点 | 写入记忆? | 注入? |
|---|---|---|---|
| `session_start` | `GET /health` | ❌ | ❌（仅设 footer 状态） |
| `before_agent_start` | `POST /search_memory/` + `POST /search_user_history_summary/` | ❌ | ✅ system prompt |
| `agent_end` | `POST /add_messages/`（后台，仅用户 prompt） | ✅（仅用户 prompt） | ❌ |

## 工具与命令

| 名称 | 类型 | 用途 |
|---|---|---|
| `memory_health` | 工具 | 检查 memory_server 是否可达 |
| `memory_search` | 工具 | 语义搜索长期记忆 + 历史摘要 |
| `memory_save` | 工具 | 显式保存一条记忆（经 `/add_messages/`，自动抽取结构化记忆） |
| `/jiuwen-status` | 命令 | 在 pi 内快速查 memory_server 健康状态 |

## 设计说明

- **走 pi 扩展 API，不走 MCP**：可直接 hook 进 agent 生命周期（`session_start` / `before_agent_start` / `agent_end`），比 MCP 工具更早介入；记忆注入直接操作 system prompt，不经过 stdout→context 管道。
- **后台写不阻塞**：`agent_end` 的 `/add_messages/` 是 fire-and-forget，绝不阻塞 pi 的 LLM 轮次。
- **环境变量与其它 code-agent 统一**：同一份 `~/.jiuwenmemory/.env` 即可配置 Claude Code / Codex / OpenCode / pi 全部 agent。

## 验证它是否工作

1. **验证服务存活**：`curl http://localhost:8000/health`
2. **验证 footer 状态**：启动 pi 会话，footer 应显示 `🧠 jiuwen`（服务可达）或 `🧠 jiuwen off`（不可达）
3. **验证自动捕获**：发一条消息，等 agent 回复结束后，在 memory_server 中确认用户 prompt 已被写入记忆（仅用户输入，不含 agent 回答）
4. **试用工具/命令**：让 pi 调用 `memory_health` / `memory_search`，或直接 `/jiuwen-status`

## 目录结构

```
pi/
├── index.ts        # pi 扩展入口：3 hook + 2 工具 + 1 命令
├── security.ts     # 明文 bearer 鉴权守卫（JIUWEN_MEMORY_REQUIRE_HTTPS）
├── package.json    # npm 元信息
└── README.md
```

## License

Apache-2.0
