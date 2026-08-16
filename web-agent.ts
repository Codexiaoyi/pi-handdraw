#!/usr/bin/env node
/**
 * web-agent.ts — 独立 Web Agent 模式
 *
 * 启动画布服务器 + 内置聊天 agent：浏览器页面左侧出现可推拉的聊天面板，
 * 直接在网页里和 agent 对话，agent 调用 handdraw 工具在画布上逐笔作图。
 *
 * 模型配置（二选一，也可用 HANDDRAW_LLM_PROVIDER=openai|anthropic 强制指定）：
 *
 * OpenAI 兼容（任何兼容 /chat/completions 的服务）：
 *   HANDDRAW_LLM_API_KEY   （或 OPENAI_API_KEY）
 *   HANDDRAW_LLM_BASE_URL  默认 https://api.openai.com/v1
 *   HANDDRAW_LLM_MODEL     默认 gpt-4o-mini
 *
 * Anthropic（/v1/messages，无 OpenAI key 时自动fallback）：
 *   ANTHROPIC_API_KEY      （或 ANTHROPIC_AUTH_TOKEN）
 *   ANTHROPIC_BASE_URL     默认 https://api.anthropic.com
 *   HANDDRAW_LLM_MODEL     默认 claude-sonnet-4-5
 *
 * 端口沿用 HANDDRAW_CANVAS_PORTS（默认 8788~8791）。
 *
 * 运行：
 *   HANDDRAW_LLM_API_KEY=sk-... npm run agent
 *   ANTHROPIC_API_KEY=sk-ant-... npm run agent
 *
 * API：
 *   GET  /api/agent/info    → { ok, provider, configured, model }
 *   GET  /api/chat/history  → { messages: [{role:"user"|"agent", content}] }
 *   POST /api/chat          → { message, board } → { reply }（串行，忙碌时 409）
 *   POST /api/chat/reset    → 清空聊天记录
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { getCanvasServer } from "./canvas-server";
import {
  executeCanvasAction,
  executeBoardAction,
  PARAMS_SCHEMA,
  BOARD_PARAMS_SCHEMA,
  toolDescriptionFull,
  boardToolDescriptionFull,
} from "./core";

// ---------------------------------------------------------------------------
// 模型提供方配置
// ---------------------------------------------------------------------------

type Provider = "openai" | "anthropic";

const OAI_KEY = process.env.HANDDRAW_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const OAI_BASE = (process.env.HANDDRAW_LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const ANT_KEY = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";
const ANT_BASE = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");

const PROVIDER: Provider =
  (process.env.HANDDRAW_LLM_PROVIDER as Provider | undefined) ?? (OAI_KEY ? "openai" : ANT_KEY ? "anthropic" : "openai");
const API_KEY = PROVIDER === "anthropic" ? ANT_KEY : OAI_KEY;
const MODEL =
  process.env.HANDDRAW_LLM_MODEL ?? (PROVIDER === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini");

const MAX_ROUNDS = 16;
const MAX_HISTORY = 40;
const MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// 对话历史（内部统一用 OpenAI 消息格式，Anthropic 请求时现转换）
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface ChatMsg {
  role: "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const history: ChatMsg[] = [];
let busy = false;

// status/clear 等 action 不需要 elements，agent 版放宽 required 防止严格校验的提供商报错
const AGENT_PARAMS_SCHEMA = { ...PARAMS_SCHEMA, required: [] as string[] };

const OAI_TOOLS = [
  {
    type: "function" as const,
    function: { name: "handdraw_canvas", description: toolDescriptionFull(), parameters: AGENT_PARAMS_SCHEMA },
  },
  {
    type: "function" as const,
    function: { name: "handdraw_board", description: boardToolDescriptionFull(), parameters: BOARD_PARAMS_SCHEMA },
  },
];
const ANT_TOOLS = OAI_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

function systemPrompt(board: string): string {
  return (
    "你是「画布小助手」，住在实时画布网页里的画图 agent。" +
    "用户通过页面左侧的聊天框和你对话，你用 handdraw 工具在手绘风无限画布上边画边讲，绘制过程用户能实时看到。\n" +
    `用户当前正在查看的画板：${board || "默认"}\n\n` +
    "行为规则：\n" +
    "- 用户想画图/讲解/涂鸦时才动笔画；纯聊天就直接回复，不要调用工具\n" +
    "- 画新内容前先 status 看画布现状，再分步增量绘制（每次 1~3 个元素），不要一次调用画完整张图\n" +
    "- 元素用绝对坐标；新图优先放 freeSpots 推荐空位，绝不盖在已有内容上\n" +
    "- 箭头连到盒子边缘：右=(x+w,y+h/2)、左=(x,y+h/2)、下=(x+w/2,y+h)、上=(x+w/2,y)，不要指向盒子中心\n" +
    "- 容器框 textPosition 用 top，内部内容从 y+50 以下开始排\n" +
    "- clear 清空仅用户明确要求时才用\n" +
    "- 回复简洁口语化；画完简单说一句画了什么、还能怎么继续"
  );
}

// ---------------------------------------------------------------------------
// LLM 调用（一轮）：返回 { text, calls }，assistant 消息已入 history
// ---------------------------------------------------------------------------

interface LlmRound {
  text: string;
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

async function openaiRound(board: string): Promise<LlmRound> {
  const res = await fetch(`${OAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OAI_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt(board) }, ...history],
      tools: OAI_TOOLS,
    }),
  });
  if (!res.ok) throw new Error(`LLM 请求失败 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }>;
  };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("LLM 返回为空");
  history.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
  const calls = (msg.tool_calls ?? []).map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
    } catch {
      /* 参数坏了当空对象 */
    }
    return { id: tc.id, name: tc.function?.name ?? "", args };
  });
  return { text: String(msg.content ?? "").trim(), calls };
}

/** OpenAI 内部历史 → Anthropic messages（连续 tool 结果合并进一条 user 消息） */
function toAnthropicMessages(): unknown[] {
  const out: Array<{ role: string; content: unknown }> = [];
  for (const m of history) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
    } else if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content?.trim()) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "…" }] });
    } else if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

async function anthropicRound(board: string): Promise<LlmRound> {
  const endpoint = ANT_BASE.endsWith("/v1") ? `${ANT_BASE}/messages` : `${ANT_BASE}/v1/messages`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANT_KEY,
      Authorization: `Bearer ${ANT_KEY}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(board),
      messages: toAnthropicMessages(),
      tools: ANT_TOOLS,
    }),
  });
  if (!res.ok) throw new Error(`LLM 请求失败 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  };
  const blocks = data.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  const calls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: String(b.id), name: String(b.name), args: b.input ?? {} }));
  history.push({
    role: "assistant",
    content: text,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  });
  return { text, calls };
}

async function llmRound(board: string): Promise<LlmRound> {
  return PROVIDER === "anthropic" ? anthropicRound(board) : openaiRound(board);
}

/** 执行一次 handdraw 工具调用，返回给模型的文本 */
async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const out =
      name === "handdraw_board"
        ? await executeBoardAction(args as Parameters<typeof executeBoardAction>[0], { openBrowser: false })
        : await executeCanvasAction(args as Parameters<typeof executeCanvasAction>[0], { openBrowser: false });
    return out.text;
  } catch (e) {
    return "工具执行失败: " + (e instanceof Error ? e.message : String(e));
  }
}

/** agent 主循环：LLM ↔ handdraw 工具，直到模型给出最终文字回复 */
async function runAgent(message: string, board: string): Promise<string> {
  history.push({ role: "user", content: message });
  while (history.length > MAX_HISTORY) history.shift();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { text, calls } = await llmRound(board);
    if (calls.length === 0) return text || "（空回复）";
    for (const call of calls) {
      // 没指定画板时锁定到用户正在查看的画板，防止画到服务器活跃画板上去
      if (board && !call.args.board) call.args.board = board;
      const result = await runTool(call.name, call.args);
      history.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return "（已连续调用工具太多次，先停一下，回复「继续」即可接着画）";
}

// ---------------------------------------------------------------------------
// HTTP：注册到画布服务器的额外路由（返回 true = 已处理）
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(body || "{}") as Record<string, unknown>);
      } catch {
        rejectBody(new Error("bad json"));
      }
    });
    req.on("error", rejectBody);
  });
}

/** 给页面展示的精简历史（跳过 tool 消息和无文字的 assistant 消息） */
function publicHistory(): Array<{ role: "user" | "agent"; content: string }> {
  const out: Array<{ role: "user" | "agent"; content: string }> = [];
  for (const m of history) {
    if (m.role === "user" && m.content) out.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.content?.trim()) out.push({ role: "agent", content: m.content });
  }
  return out;
}

async function agentApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const json = (code: number, obj: Record<string, unknown>) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/api/agent/info" && req.method === "GET") {
    json(200, { ok: true, provider: PROVIDER, configured: Boolean(API_KEY), model: MODEL });
    return true;
  }
  if (url.pathname === "/api/chat/history" && req.method === "GET") {
    json(200, { messages: publicHistory() });
    return true;
  }
  if (url.pathname === "/api/chat/reset" && req.method === "POST") {
    history.length = 0;
    json(200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/chat" && req.method === "POST") {
    if (!API_KEY) {
      json(503, { error: `未配置模型 API Key（${PROVIDER === "anthropic" ? "ANTHROPIC_API_KEY" : "HANDDRAW_LLM_API_KEY"}）` });
      return true;
    }
    if (busy) {
      json(409, { error: "上一条消息还在处理中，请稍等" });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch {
      json(400, { error: "bad json" });
      return true;
    }
    const message = String(body.message ?? "").trim();
    const board = String(body.board ?? "");
    if (!message) {
      json(400, { error: "消息为空" });
      return true;
    }
    busy = true;
    try {
      const reply = await runAgent(message, board);
      json(200, { reply });
    } catch (e) {
      json(500, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      busy = false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main() {
  const server = getCanvasServer();
  server.setExtraHandler(agentApi);
  const mode = await server.start();
  const url = `http://localhost:${server.getPort()}`;
  console.log(`✏️  Web Agent 画布已启动: ${url}`);
  console.log(`   模型: ${MODEL} (provider=${PROVIDER})`);
  if (mode === "remote") {
    console.warn("   ⚠️ 端口上已有一个画布服务器在跑，聊天 API 未挂载；请先停掉旧进程或换 HANDDRAW_CANVAS_PORTS");
  }
  if (!API_KEY) {
    console.warn("   ⚠️ 未设置模型 API Key，聊天面板可见但无法对话");
  }
  exec(
    process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`,
    () => {}
  );
  // keep alive
  setInterval(() => {}, 1 << 30);
}

process.on("SIGINT", () => {
  getCanvasServer().stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  getCanvasServer().stop();
  process.exit(0);
});

main().catch((err) => {
  console.error("web-agent 启动失败:", err);
  process.exit(1);
});
