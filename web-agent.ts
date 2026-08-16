#!/usr/bin/env node
/**
 * web-agent.ts — 独立 Web 画布 + 外部 agent 聊天桥（ACP 协议）
 *
 * 启动画布服务器，并在页面左侧提供一个可推拉的聊天面板。
 * 聊天后端不是内置 LLM，而是通过 ACP（Agent Client Protocol，Zed 同款）
 * 桥接到你自己安装的 agent CLI——claude code / codex / gemini 等。
 * agent 通过 ACP session 里注入的 handdraw MCP server 在画布上实时作画。
 *
 * 配置：
 *   HANDDRAW_AGENT_BACKEND   claude-code | codex | gemini
 *                            （默认自动探测 PATH：claude → codex → gemini）
 *   HANDDRAW_ACP_CMD         自定义 ACP agent 启动命令（覆盖预设，
 *                            如 "npx -y @zed-industries/claude-code-acp"）
 *   HANDDRAW_ACP_AUTO_APPROVE 0 = 拒绝所有工具权限请求（默认 1 = 自动批准）
 *   HANDDRAW_AGENT_TIMEOUT_MS 单条消息超时（默认 600000）
 *   端口沿用 HANDDRAW_CANVAS_PORTS（默认 8788~8791）
 *
 * 运行：
 *   npm run agent                          # 自动探测
 *   HANDDRAW_AGENT_BACKEND=codex npm run agent
 *
 * HTTP API：
 *   GET  /api/agent/info    → { ok, backend, configured }
 *   GET  /api/chat/history  → { messages: [{role:"user"|"agent", content}] }
 *   POST /api/chat          → { message, board } → { reply }（串行，忙碌时 409）
 *   POST /api/chat/reset    → 清空聊天记录并重开 agent 会话
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, exec, execSync, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCanvasServer } from "./canvas-server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(__dirname, "mcp-server.ts");

const AUTO_APPROVE = process.env.HANDDRAW_ACP_AUTO_APPROVE !== "0";
const PROMPT_TIMEOUT = Number(process.env.HANDDRAW_AGENT_TIMEOUT_MS ?? 600_000);
const INIT_TIMEOUT = 180_000; // 首次 npx 下载适配器可能较慢

// ---------------------------------------------------------------------------
// ACP agent 后端预设
// ---------------------------------------------------------------------------

interface Backend {
  label: string;
  cmd: string;
  args: string[];
}

const BACKENDS: Record<string, Backend> = {
  "claude-code": { label: "Claude Code", cmd: "npx", args: ["-y", "@zed-industries/claude-code-acp"] },
  codex: { label: "Codex", cmd: "npx", args: ["-y", "@zed-industries/codex-acp"] },
  gemini: { label: "Gemini CLI", cmd: "gemini", args: ["--experimental-acp"] },
};

function resolveBackend(): Backend & { name: string } {
  if (process.env.HANDDRAW_ACP_CMD) {
    const parts = process.env.HANDDRAW_ACP_CMD.split(/\s+/).filter(Boolean);
    return { name: "custom", label: process.env.HANDDRAW_ACP_CMD, cmd: parts[0], args: parts.slice(1) };
  }
  const name = process.env.HANDDRAW_AGENT_BACKEND;
  if (name) {
    const b = BACKENDS[name];
    if (!b) throw new Error(`未知 HANDDRAW_AGENT_BACKEND: ${name}（可选 ${Object.keys(BACKENDS).join(" / ")}）`);
    return { ...b, name };
  }
  // 自动探测
  const has = (bin: string) => {
    try {
      execSync(`command -v ${bin}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (has("claude")) return { ...BACKENDS["claude-code"], name: "claude-code" };
  if (has("codex")) return { ...BACKENDS["codex"], name: "codex" };
  if (has("gemini")) return { ...BACKENDS["gemini"], name: "gemini" };
  return { ...BACKENDS["claude-code"], name: "claude-code" };
}

// ---------------------------------------------------------------------------
// ACP client（stdio NDJSON JSON-RPC 2.0）
// ---------------------------------------------------------------------------

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

class AcpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  /** 当前 prompt turn 累积的 agent 文本 */
  private turnText = "";
  sessionId: string | null = null;
  alive = false;

  constructor(
    private backend: Backend,
    private canvasPort: number
  ) {}

  async start(): Promise<void> {
    const proc = spawn(this.backend.cmd, this.backend.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.alive = true;
    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    proc.stderr!.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) console.error(`[acp:${this.backend.name ?? "agent"}] ${line.slice(0, 300)}`);
    });
    proc.on("exit", (code) => {
      this.alive = false;
      this.sessionId = null;
      for (const [, p] of this.pending) p.reject(new Error(`agent 进程退出 (code=${code})`));
      this.pending.clear();
    });
    proc.on("error", (err) => {
      this.alive = false;
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });

    const init = (await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "handdraw-web", title: "Handdraw Web Canvas", version: "0.1.0" },
      },
      INIT_TIMEOUT
    )) as { agentCapabilities?: unknown; authMethods?: Array<unknown> };
    if (init?.authMethods && init.authMethods.length > 0) {
      // authMethods 只是「如需要可用」的认证方式；CLI 已登录时 session/new 直接可用，先试再说
      console.error(`[acp] agent 声明了认证方式（${init.authMethods.map((m) => (m as { id?: string }).id).join(", ")}），已跳过，如后续报错请先登录该 agent`);
    }

    const s = (await this.request(
      "session/new",
      {
        cwd: process.cwd(),
        mcpServers: [
          {
            name: "handdraw",
            command: "npx",
            args: ["tsx", MCP_SERVER],
            // 让 MCP server 把笔画推送到本进程的画布端口（remote 复用模式）
            env: [{ name: "HANDDRAW_CANVAS_PORTS", value: String(this.canvasPort) }],
          },
        ],
      },
      INIT_TIMEOUT
    )) as { sessionId?: string };
    if (!s?.sessionId) throw new Error("session/new 未返回 sessionId");
    this.sessionId = s.sessionId;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(line) as JsonRpcMsg;
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: JsonRpcMsg): void {
    // 响应（有 id 且无 method）
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    // agent → client 通知
    if (msg.method === "session/update") {
      const update = (msg.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } })?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        this.turnText += update.content.text ?? "";
      }
      return;
    }
    // agent → client 请求：权限
    if (msg.method === "session/request_permission" && msg.id != null) {
      const params = msg.params as { options?: Array<{ optionId: string; kind?: string }> };
      const options = params?.options ?? [];
      const allow =
        options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once") ?? options[0];
      const outcome =
        AUTO_APPROVE && allow
          ? { outcome: "selected", optionId: allow.optionId }
          : { outcome: "selected", optionId: (options.find((o) => o.kind?.startsWith("reject")) ?? allow)?.optionId };
      this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome } });
      return;
    }
    // 其他 agent → client 请求（fs/*、terminal/* 等）：声明过不支持，回 Method not found
    if (msg.method && msg.id != null) {
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `${msg.method} not supported by client` } });
    }
  }

  private send(msg: JsonRpcMsg): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === "session/prompt" && this.sessionId) {
          this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
        }
        rejectReq(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolveReq(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rejectReq(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async prompt(text: string): Promise<string> {
    if (!this.sessionId) throw new Error("agent 会话未建立");
    this.turnText = "";
    await this.request(
      "session/prompt",
      { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
      PROMPT_TIMEOUT
    );
    return this.turnText.trim();
  }

  kill(): void {
    this.alive = false;
    this.sessionId = null;
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

// ---------------------------------------------------------------------------
// 聊天会话管理
// ---------------------------------------------------------------------------

const BACKEND = resolveBackend();
let client: AcpClient | null = null;
let starting: Promise<AcpClient> | null = null;
let busy = false;

const displayHistory: Array<{ role: "user" | "agent"; content: string }> = [];

async function ensureAgent(canvasPort: number): Promise<AcpClient> {
  if (client?.alive && client.sessionId) return client;
  if (starting) return starting;
  starting = (async () => {
    const c = new AcpClient(BACKEND, canvasPort);
    await c.start();
    client = c;
    starting = null;
    return c;
  })().catch((e) => {
    starting = null;
    throw e;
  });
  return starting;
}

async function chatWithAgent(message: string, board: string, canvasPort: number): Promise<string> {
  const agent = await ensureAgent(canvasPort);
  const context =
    `[来自画布网页的实时聊天。用户正在浏览器里查看画板「${board || "default"}」。` +
    `如果需要用 handdraw 工具画图/改图，请把 board 参数设为这个画板名。]\n\n${message}`;
  const reply = await agent.prompt(context);
  return reply || "（agent 没有文字回复，但它可能已经动手画了）";
}

// ---------------------------------------------------------------------------
// HTTP API（挂载到画布服务器）
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

function makeAgentApi(canvasPortRef: () => number) {
  return async function agentApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const json = (code: number, obj: Record<string, unknown>) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === "/api/agent/info" && req.method === "GET") {
      json(200, { ok: true, backend: BACKEND.label, model: BACKEND.label, configured: true });
      return true;
    }
    if (url.pathname === "/api/chat/history" && req.method === "GET") {
      json(200, { messages: displayHistory.slice(-100) });
      return true;
    }
    if (url.pathname === "/api/chat/reset" && req.method === "POST") {
      displayHistory.length = 0;
      client?.kill();
      client = null;
      json(200, { ok: true });
      return true;
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
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
        const reply = await chatWithAgent(message, board, canvasPortRef());
        displayHistory.push({ role: "user", content: message }, { role: "agent", content: reply });
        json(200, { reply });
      } catch (e) {
        json(500, { error: e instanceof Error ? e.message : String(e) });
      } finally {
        busy = false;
      }
      return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main() {
  console.log(`   agent 后端: ${BACKEND.label}（ACP）`);
  const server = getCanvasServer();
  server.setExtraHandler(makeAgentApi(() => server.getPort()));
  const mode = await server.start();
  const url = `http://localhost:${server.getPort()}`;
  console.log(`✏️  Web Agent 画布已启动: ${url}`);
  if (mode === "remote") {
    console.warn("   ⚠️ 端口上已有一个画布服务器在跑，聊天 API 未挂载；请先停掉旧进程或换 HANDDRAW_CANVAS_PORTS");
  }
  exec(
    process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`,
    () => {}
  );
  // keep alive
  setInterval(() => {}, 1 << 30);
}

function shutdown() {
  client?.kill();
  getCanvasServer().stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("web-agent 启动失败:", err);
  process.exit(1);
});
