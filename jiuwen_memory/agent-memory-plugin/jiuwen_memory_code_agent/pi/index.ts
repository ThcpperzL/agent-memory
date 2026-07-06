// jiuwen-memory pi extension — pi (pi-coding-agent) ExtensionAPI implementation.
//
// This mirrors what the Claude Code / Codex / OpenCode integrations do, but
// through pi's extension API (not MCP, not stdout). Lifecycle hooks call the
// jiuwen memory_server REST API directly (127.0.0.1:8000), the same server the
// other code-agents talk to.
//
// Lifecycle mapping (matches the other code-agent hooks):
//   session_start       → GET /health (probe only, no search)        [like session-start.mjs]
//   before_agent_start  → POST /search_memory/ + /search_user_history_summary/
//                         → inject results into the system prompt   [like prompt-submit.mjs's search half]
//   agent_end           → POST /add_messages/ (record the user prompt,
//                         deferred until the agent has finished so it
//                         doesn't interrupt the conversation)        [like prompt-submit.mjs's write half]
//
// Write policy (consistent across jiuwen code-agents): ONLY the user's prompt
// is written to memory. The agent's reply, tool results, and sub-agent results
// are NOT recorded — agent_end here only persists `lastPrompt`, never the
// assistant text.
//
// Install: drop this folder into ~/.pi/agent/extensions/jiuwen-memory/ and
// reference it in ~/.pi/agent/settings.json:
//   { "extensions": ["~/.pi/agent/extensions/jiuwen-memory"] }
//
// Requires: @mariozechner/pi-coding-agent types (provided by pi at runtime),
// and the `typebox` package (Type) for tool parameter schemas.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { basename } from "node:path";
import { createPlaintextBearerAuthGuard } from "./security.js";

// ---------------------------------------------------------------------------
// Types — pi passes assistant content as an array of blocks (same shape as
// the agentmemory reference), so we can reuse the same block-extraction logic.
// ---------------------------------------------------------------------------
type TextBlock = { type?: string; text?: string };
type AssistantMessage = { role?: string; content?: unknown };

type MemoryItem = {
  content?: string;
  type?: string;
  score?: number;
};

type SearchResult = {
  results?: MemoryItem[];
};

// ---------------------------------------------------------------------------
// Config
//
// Env var names intentionally match the other jiuwen code-agent integrations
// (JIUWEN_MEMORY_URL / JIUWEN_MEMORY_API_KEY / JIUWEN_USER_ID / ...), so one
// shared ~/.jiuwenmemory/.env configures every agent uniformly. The pi default
// user_id is `pi-user` to keep pi's memories isolated from cc-user / codex-user
// / opencode-user unless JIUWEN_USER_ID is set explicitly.
// ---------------------------------------------------------------------------
const REST_URL = process.env.JIUWEN_MEMORY_URL || "http://localhost:8000";
const SECRET = process.env.JIUWEN_MEMORY_API_KEY || "";
const DEFAULT_USER_ID = process.env.JIUWEN_USER_ID || "pi-user";
const DEBUG = process.env.JIUWEN_PI_DEBUG === "1";

const SEARCH_MEM_NUM = 5;
const SEARCH_SUMMARY_NUM = 3;
const DEFAULT_THRESHOLD = 0.3;
const MAX_TRUNCATE = 8000;

const guardPlaintextBearerAuth = createPlaintextBearerAuthGuard();

const TOOL_GUIDANCE = [
  "<jiuwen-memory-instructions>",
  "You have access to jiuwen-memory for persistent cross-session memory.",
  "memory_search — semantic search across long-term memory (user profile,",
  "  episodic, semantic). Use it to recall prior decisions, preferences,",
  "  bugs, and workflows from past sessions.",
  "memory_save — write a durable fact, convention, workflow, preference, or",
  "  bug fix back to long-term memory when you discover something worth",
  "  remembering beyond this session.",
  "Always present only what the tools actually return — never fabricate.",
  "</jiuwen-memory-instructions>",
].join("\n");

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

async function postJson<T>(
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs = 3000,
): Promise<T | null> {
  try {
    const res = await fetch(`${REST_URL}/${pathname}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return (await res.json()) as T;
    if (DEBUG) console.error(`[jiuwen] POST /${pathname} returned ${res.status}`);
  } catch (e) {
    if (DEBUG) console.error(`[jiuwen] POST /${pathname} failed:`, (e as Error)?.message || e);
  }
  return null;
}

// Fire-and-forget POST — never throws, used for background memory writes.
async function post(pathname: string, body: Record<string, unknown>, timeoutMs = 3000): Promise<void> {
  try {
    const res = await fetch(`${REST_URL}/${pathname}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (DEBUG && !res.ok) console.error(`[jiuwen] POST /${pathname} returned ${res.status}`);
  } catch (e) {
    if (DEBUG) console.error(`[jiuwen] POST /${pathname} failed:`, (e as Error)?.message || e);
  }
}

async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${REST_URL}/health`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Project resolution — mirrors agentmemory's resolveProject() and the
// _shared.mjs resolveProject(): scope_id = git toplevel basename, ensuring
// per-project memory isolation. JIUWEN_MEMORY_PROJECT_NAME overrides.
// ---------------------------------------------------------------------------
function resolveProject(cwd?: string): string {
  const explicit = process.env.JIUWEN_MEMORY_PROJECT_NAME;
  if (explicit && explicit.trim()) return explicit.trim();
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).toString().trim();
    if (top) return basename(top);
  } catch {}
  return basename(dir);
}

// ---------------------------------------------------------------------------
// Block / message extraction — pi's assistant content is an array of blocks.
// ---------------------------------------------------------------------------
function getText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [] as string[];
      const block = part as TextBlock;
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      return [] as string[];
    })
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// jiuwen memory_server endpoints (trailing slash matches FastAPI declarations).
// ---------------------------------------------------------------------------
const EP_ADD_MESSAGES = "add_messages/";
const EP_SEARCH_MEMORY = "search_memory/";
const EP_SEARCH_SUMMARY = "search_user_history_summary/";
const EP_HEALTH = "health";

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------
async function addMessages(
  messages: Array<{ role: string; content: string }>,
  scopeId: string,
  userId = DEFAULT_USER_ID,
): Promise<void> {
  await post(EP_ADD_MESSAGES, {
    messages,
    user_id: userId,
    scope_id: scopeId,
  }, 3000);
}

/**
 * Combined search — calls /search_memory/ and /search_user_history_summary/,
 * merges results into a formatted context string for system prompt injection
 * (before_agent_start). Mirrors searchAndFormat() in _shared.mjs.
 */
async function searchAndFormat(query: string, scopeId: string, userId = DEFAULT_USER_ID): Promise<string> {
  const [memResult, summaryResult] = await Promise.all([
    postJson<SearchResult>(EP_SEARCH_MEMORY, {
      query,
      num: SEARCH_MEM_NUM,
      user_id: userId,
      scope_id: scopeId,
      threshold: DEFAULT_THRESHOLD,
    }),
    postJson<SearchResult>(EP_SEARCH_SUMMARY, {
      query,
      num: SEARCH_SUMMARY_NUM,
      user_id: userId,
      scope_id: scopeId,
      threshold: DEFAULT_THRESHOLD,
    }),
  ]);

  const memItems = memResult?.results || [];
  const summaryItems = summaryResult?.results || [];
  const lines: string[] = [];

  if (memItems.length) {
    lines.push("## Related Memories");
    for (const r of memItems) {
      const label = r.type ? `[${r.type}]` : "";
      lines.push(`- ${label} ${String(r.content || "").slice(0, 300)} (score: ${Number(r.score || 0).toFixed(2)})`);
    }
  }
  if (summaryItems.length) {
    if (lines.length) lines.push("");
    lines.push("## Related History Summaries");
    for (const r of summaryItems) {
      lines.push(`- ${String(r.content || "").slice(0, 300)} (score: ${Number(r.score || 0).toFixed(2)})`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function jiuwenMemoryExtension(pi: ExtensionAPI) {
  // Hard-fail early if the user explicitly required HTTPS but configured a
  // plaintext-HTTP, non-loopback URL with a bearer secret — otherwise we'd be
  // leaking the token and the memory payload over the wire.
  if (process.env.JIUWEN_MEMORY_REQUIRE_HTTPS === "1") {
    guardPlaintextBearerAuth(REST_URL, SECRET);
  }

  let currentProject = process.cwd();
  let lastPrompt = "";
  let lastHealthOk = false;

  async function refreshStatus(ctx: { ui: { setStatus: (key: string, text: string) => void } }) {
    lastHealthOk = await healthCheck();
    ctx.ui.setStatus("jiuwen-memory", lastHealthOk ? "🧠 jiuwen" : "🧠 jiuwen off");
  }

  // -------------------------------------------------------------------------
  // Slash command: /jiuwen-status — quick health probe from inside pi.
  // (Mirrors the agentmemory reference's /agentmemory-status command.)
  // -------------------------------------------------------------------------
  pi.registerCommand("jiuwen-status", {
    description: "Check local jiuwen memory_server health",
    handler: async (_args, ctx) => {
      const ok = await healthCheck();
      if (!ok) {
        ctx.ui.notify(`jiuwen memory_server is unreachable at ${REST_URL}`, "warning");
        return;
      }
      ctx.ui.notify(`jiwen memory_server healthy at ${REST_URL}`, "info");
    },
  });

  // -------------------------------------------------------------------------
  // Tool: memory_health — confirm the shared memory server is reachable.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "memory_health",
    label: "Memory Health",
    description: "Check whether the local jiuwen memory_server is reachable and healthy",
    parameters: Type.Object({}),
    async execute() {
      const ok = await healthCheck();
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `jiuwen memory_server healthy at ${REST_URL}`
              : `jiuwen memory_server unreachable at ${REST_URL}`,
          },
        ],
        details: { ok, url: REST_URL },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: memory_search — semantic search across long-term memory.
  // (Exposes search_memories + search_history_summaries together, like the
  // OpenCode /recall command does.)
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search jiuwen-memory for cross-session project memory, prior decisions, bugs, and user preferences",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for in memory" }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          default: SEARCH_MEM_NUM,
          description: "Maximum memories to return",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const scopeId = resolveProject(currentProject);
      const memResult = await postJson<SearchResult>(EP_SEARCH_MEMORY, {
        query: params.query,
        num: params.limit ?? SEARCH_MEM_NUM,
        user_id: DEFAULT_USER_ID,
        scope_id: scopeId,
        threshold: DEFAULT_THRESHOLD,
      });
      const summaryResult = await postJson<SearchResult>(EP_SEARCH_SUMMARY, {
        query: params.query,
        num: SEARCH_SUMMARY_NUM,
        user_id: DEFAULT_USER_ID,
        scope_id: scopeId,
        threshold: DEFAULT_THRESHOLD,
      });
      const context = formatToolResults(memResult?.results || [], summaryResult?.results || []);
      return {
        content: [{ type: "text", text: context }],
        details: { query: params.query, memories: memResult?.results || [], summaries: summaryResult?.results || [] },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: memory_save — explicitly persist a durable fact to long-term memory.
  // (Mirrors the OpenCode /remember command — writes via /add_messages/.)
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "memory_save",
    label: "Memory Save",
    description: "Save a durable fact, convention, workflow, preference, or bug fix into jiuwen-memory",
    parameters: Type.Object({
      content: Type.String({ description: "What should be remembered" }),
    }),
    async execute(_toolCallId, params) {
      const scopeId = resolveProject(currentProject);
      await addMessages(
        [{ role: "user", content: params.content.slice(0, MAX_TRUNCATE) }],
        scopeId,
        DEFAULT_USER_ID,
      );
      return {
        content: [{ type: "text", text: `Saved memory: ${params.content}` }],
        details: { ok: true, scope_id: scopeId, user_id: DEFAULT_USER_ID },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Hook: session_start — probe health, set the footer status.
  // No memory search here (matches session-start.mjs); search happens on
  // before_agent_start instead.
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    currentProject = process.cwd();
    await refreshStatus(ctx);
  });

  // -------------------------------------------------------------------------
  // Hook: before_agent_start — search memories for the incoming prompt and
  // inject them into the system prompt. (Mirrors the search half of
  // prompt-submit.mjs.)
  // -------------------------------------------------------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    currentProject = (event.systemPromptOptions?.cwd as string) || process.cwd();
    lastPrompt = (event.prompt || "").trim();
    if (!lastPrompt) {
      await refreshStatus(ctx);
      return;
    }

    const scopeId = resolveProject(currentProject);
    const recall = await searchAndFormat(lastPrompt, scopeId, DEFAULT_USER_ID);

    await refreshStatus(ctx);

    const systemPrompt = [event.systemPrompt, TOOL_GUIDANCE, recall].filter(Boolean).join("\n\n");
    return { systemPrompt };
  });

  // -------------------------------------------------------------------------
  // Hook: agent_end — persist the user's prompt to memory.
  //
  // Write policy: ONLY the user prompt is recorded (never the assistant
  // reply, never tool results) — identical to the other jiuwen code-agent
  // hooks. The write is deferred to agent_end (after the agent has finished
  // responding) so it never interrupts the conversation, the same deferred
  // strategy the OpenCode plugin uses (chat.message → message.updated).
  // -------------------------------------------------------------------------
  pi.on("agent_end", async () => {
    if (!lastHealthOk || !lastPrompt) return;
    const scopeId = resolveProject(currentProject);
    // Fire-and-forget; never block the agent loop on the write.
    void addMessages(
      [{ role: "user", content: lastPrompt.slice(0, MAX_TRUNCATE) }],
      scopeId,
      DEFAULT_USER_ID,
    );
  });
}

// ---------------------------------------------------------------------------
// Formatting for the memory_search tool (richer than the injected recall —
// shows type + mem content + score, grouped by memories vs summaries).
// ---------------------------------------------------------------------------
function formatToolResults(memories: MemoryItem[], summaries: MemoryItem[]): string {
  const lines: string[] = [];
  if (!memories.length && !summaries.length) return "No relevant memories found.";

  if (memories.length) {
    lines.push("## Memories");
    for (const r of memories) {
      const label = r.type ? `[${r.type}]` : "[memory]";
      lines.push(`- ${label} ${String(r.content || "").slice(0, 300)} (score: ${Number(r.score || 0).toFixed(2)})`);
    }
  }
  if (summaries.length) {
    if (lines.length) lines.push("");
    lines.push("## History Summaries");
    for (const r of summaries) {
      lines.push(`- ${String(r.content || "").slice(0, 300)} (score: ${Number(r.score || 0).toFixed(2)})`);
    }
  }
  return lines.join("\n");
}
