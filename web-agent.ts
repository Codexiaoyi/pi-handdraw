#!/usr/bin/env node
/**
 * web-agent.ts — 独立 Web 画布 + 外部 agent 聊天桥
 *
 * 启动画布服务器，并在页面左侧提供一个可推拉的聊天面板。
 * 聊天后端不是内置 LLM，而是桥接到你自己安装的 agent：
 *
 * - pi（默认）：走 pi 自带的 --mode rpc（JSONL 协议），直接复用你已安装的
 *   handdraw pi 扩展，会话持久保存在 boards/.pi-web-session/
 * - claude code / codex / gemini：走 ACP（Agent Client Protocol，Zed 同款），
 *   通过 session/new 注入 handdraw MCP server
 *
 * 配置：
 *   HANDDRAW_AGENT_BACKEND   pi | claude-code | codex | gemini（默认 pi）
 *   HANDDRAW_ACP_CMD         自定义 ACP agent 启动命令（覆盖预设，
 *                            如 "npx -y @zed-industries/claude-code-acp"）
 *   HANDDRAW_PI_ARGS         给 pi 后端的额外参数（如 "--model anthropic/claude-sonnet-4-5"）
 *   HANDDRAW_ACP_AUTO_APPROVE 0 = 拒绝 ACP agent 的工具权限请求（默认 1 = 自动批准）
 *   HANDDRAW_AGENT_TIMEOUT_MS 单条消息超时（默认 600000）
 *   端口沿用 HANDDRAW_CANVAS_PORTS（默认 8788~8791）
 *
 * 运行：
 *   npm run agent                          # 默认 pi
 *   HANDDRAW_AGENT_BACKEND=codex npm run agent
 *
 * HTTP API：
 *   GET  /api/agent/info    → { ok, backend, configured }
 *   GET  /api/chat/history  → { messages: [{role:"user"|"agent", content}] }
 *   POST /api/chat          → { message, board } → { reply }（串行，忙碌时 409）
 *   POST /api/chat/reset    → 清空聊天记录并重开 agent 会话
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, exec, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOARDS_DIR, getCanvasServer } from "./canvas-server";
import { setAgentWorking } from "./core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(__dirname, "mcp-server.ts");

const AUTO_APPROVE = process.env.HANDDRAW_ACP_AUTO_APPROVE !== "0";
const PROMPT_TIMEOUT = Number(process.env.HANDDRAW_AGENT_TIMEOUT_MS ?? 600_000);
const INIT_TIMEOUT = 180_000; // pi 首次启动加载扩展 / npx 首次下载适配器都可能较慢

/** 追加给 agent 的场景说明（pi 用 --append-system-prompt；ACP 后端拼在每条消息前缀里） */
const SCENARIO_PROMPT =
  "你现在处在一个网页画布聊天场景中：用户通过浏览器页面左侧的聊天框和你对话。" +
  "你可以使用 handdraw_canvas / handdraw_board 工具在手绘风实时画布上边画边讲，绘制过程用户实时可见。" +
  "每条用户消息开头会注明用户正在查看的画板名，画图/改图请把 board 参数设为该画板名。" +
  "回复保持简洁口语化；纯聊天不要调用工具。";

// ---------------------------------------------------------------------------
// 后端抽象
// ---------------------------------------------------------------------------

interface AgentSession {
  readonly label: string;
  readonly alive: boolean;
  start(): Promise<void>;
  prompt(text: string, timeoutMs: number): Promise<string>;
  /** 清空上下文（尽量保进程） */
  reset(): Promise<void>;
  kill(): void;
}

type BackendSpec =
  | { kind: "pi"; label: string }
  | { kind: "acp"; label: string; cmd: string; args: string[] };

const ACP_BACKENDS: Record<string, { label: string; cmd: string; args: string[] }> = {
  "claude-code": { label: "Claude Code", cmd: "npx", args: ["-y", "@zed-industries/claude-code-acp"] },
  codex: { label: "Codex", cmd: "npx", args: ["-y", "@zed-industries/codex-acp"] },
  gemini: { label: "Gemini CLI", cmd: "gemini", args: ["--experimental-acp"] },
};

function resolveBackend(): BackendSpec {
  if (process.env.HANDDRAW_ACP_CMD) {
    const parts = process.env.HANDDRAW_ACP_CMD.split(/\s+/).filter(Boolean);
    return { kind: "acp", label: process.env.HANDDRAW_ACP_CMD, cmd: parts[0], args: parts.slice(1) };
  }
  const name = process.env.HANDDRAW_AGENT_BACKEND ?? "pi";
  if (name === "pi") return { kind: "pi", label: "pi" };
  const b = ACP_BACKENDS[name];
  if (!b) throw new Error(`未知 HANDDRAW_AGENT_BACKEND: ${name}（可选 pi / ${Object.keys(ACP_BACKENDS).join(" / ")}）`);
  return { kind: "acp", ...b };
}

// ---------------------------------------------------------------------------
// pi 后端（--mode rpc，JSONL）
// ---------------------------------------------------------------------------

interface PiMsg {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
  method?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  [key: string]: unknown;
}

class PiRpcSession implements AgentSession {
  readonly label = "pi";
  alive = false;
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private turnText = "";
  private settledResolve: (() => void) | null = null;

  constructor(private canvasPort: number) {}

  async start(): Promise<void> {
    const sessionDir = join(BOARDS_DIR, ".pi-web-session");
    mkdirSync(sessionDir, { recursive: true });
    const extraArgs = (process.env.HANDDRAW_PI_ARGS ?? "").split(/\s+/).filter(Boolean);
    const proc = spawn(
      "pi",
      [
        "--mode", "rpc",
        "--session-dir", sessionDir,
        "--name", "handdraw-web-chat",
        "--append-system-prompt", SCENARIO_PROMPT,
        ...extraArgs,
      ],
      {
        cwd: process.cwd(),
        // 让 handdraw 扩展找到本进程的画布服务器（remote 复用模式，走 HTTP 推送）
        env: { ...process.env, HANDDRAW_CANVAS_PORTS: String(this.canvasPort) },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    this.proc = proc;
    this.alive = true;
    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    proc.stderr!.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) console.error(`[pi] ${line.slice(0, 300)}`);
    });
    const onDead = (err?: Error) => {
      this.alive = false;
      for (const [, p] of this.pending) p.reject(err ?? new Error("pi 进程退出"));
      this.pending.clear();
      this.settledResolve?.();
      this.settledResolve = null;
    };
    proc.on("exit", () => onDead());
    proc.on("error", (err) => onDead(err));

    // 等 pi 就绪（加载扩展、恢复会话）
    await this.command({ type: "get_state" }, INIT_TIMEOUT);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let msg: PiMsg;
      try {
        msg = JSON.parse(line) as PiMsg;
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: PiMsg): void {
    if (msg.type === "response" && msg.id != null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.success === false) p.reject(new Error(msg.error ?? `${msg.command} 失败`));
        else p.resolve(msg.data);
      }
      return;
    }
    if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta") {
      this.turnText += msg.assistantMessageEvent.delta ?? "";
      return;
    }
    if (msg.type === "agent_settled") {
      this.settledResolve?.();
      this.settledResolve = null;
      return;
    }
    // 扩展 UI 对话框（select/confirm/input/editor）：回 cancelled 防止 agent 卡住
    if (
      msg.type === "extension_ui_request" &&
      msg.id &&
      ["select", "confirm", "input", "editor"].includes(String(msg.method))
    ) {
      this.sendRaw({ type: "extension_ui_response", id: msg.id, cancelled: true });
    }
  }

  private sendRaw(obj: Record<string, unknown>): void {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  private command(cmd: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = `req-${this.nextId++}`;
    return new Promise((resolveCmd, rejectCmd) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCmd(new Error(`${String(cmd.type)} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolveCmd(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rejectCmd(e);
        },
      });
      this.sendRaw({ ...cmd, id });
    });
  }

  async prompt(text: string, timeoutMs: number): Promise<string> {
    this.turnText = "";
    const settled = new Promise<void>((res) => {
      this.settledResolve = res;
    });
    await this.command({ type: "prompt", message: text }, 60_000);
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      settled,
      new Promise<void>((_, rej) => {
        timer = setTimeout(() => {
          this.sendRaw({ type: "abort" });
          rej(new Error("prompt 超时，已中止"));
        }, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer!));
    return this.turnText.trim();
  }

  /** 新开会话（保留进程和已加载的扩展） */
  async reset(): Promise<void> {
    if (this.alive) {
      try {
        await this.command({ type: "new_session" }, 30_000);
      } catch {
        /* 失败就整体重启 */
      }
    }
  }

  /** RPC get_state（模型、思考级别、会话名等）；失败返回 null */
  async getState(): Promise<Record<string, unknown> | null> {
    if (!this.alive) return null;
    try {
      return (await this.command({ type: "get_state" }, 10_000)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** RPC get_commands（扩展命令 + skills）；失败返回 null */
  async getCommands(): Promise<
    Array<{ name?: string; description?: string; source?: string; location?: string; path?: string }>
  > | null {
    if (!this.alive) return null;
    try {
      const data = (await this.command({ type: "get_commands" }, 10_000)) as {
        commands?: Array<{ name?: string; description?: string; source?: string; location?: string; path?: string }>;
      };
      return data?.commands ?? null;
    } catch {
      return null;
    }
  }

  kill(): void {
    this.alive = false;
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

// ---------------------------------------------------------------------------
// ACP 后端（claude-code / codex / gemini；stdio NDJSON JSON-RPC 2.0）
// ---------------------------------------------------------------------------

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

class AcpSession implements AgentSession {
  readonly label: string;
  alive = false;
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  private turnText = "";
  private sessionId: string | null = null;

  constructor(
    private spec: { label: string; cmd: string; args: string[] },
    private canvasPort: number
  ) {
    this.label = spec.label;
  }

  async start(): Promise<void> {
    const proc = spawn(this.spec.cmd, this.spec.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.alive = true;
    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    proc.stderr!.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) console.error(`[acp] ${line.slice(0, 300)}`);
    });
    const onDead = (err?: Error) => {
      this.alive = false;
      this.sessionId = null;
      for (const [, p] of this.pending) p.reject(err ?? new Error("agent 进程退出"));
      this.pending.clear();
    };
    proc.on("exit", () => onDead());
    proc.on("error", (err) => onDead(err));

    const init = (await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "handdraw-web", title: "Handdraw Web Canvas", version: "0.1.0" },
      },
      INIT_TIMEOUT
    )) as { authMethods?: Array<{ id?: string }> };
    if (init?.authMethods && init.authMethods.length > 0) {
      // authMethods 只是「如需要可用」的认证方式；CLI 已登录时 session/new 直接可用，先试再说
      console.error(`[acp] agent 声明了认证方式（${init.authMethods.map((m) => m.id).join(", ")}），已跳过，如后续报错请先登录该 agent`);
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
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "session/update") {
      const update = (msg.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } })?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        this.turnText += update.content.text ?? "";
      }
      return;
    }
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
    if (msg.method && msg.id != null) {
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `${msg.method} not supported by client` } });
    }
  }

  private send(msg: JsonRpcMsg): void {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(JSON.stringify(msg) + "\n");
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

  async prompt(text: string, timeoutMs: number): Promise<string> {
    if (!this.sessionId) throw new Error("agent 会话未建立");
    this.turnText = "";
    await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, timeoutMs);
    return this.turnText.trim();
  }

  /** ACP 没有通用的重置方法：杀掉进程，下条消息重开会话 */
  async reset(): Promise<void> {
    this.kill();
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
let session: AgentSession | null = null;
let starting: Promise<AgentSession> | null = null;
let busy = false;

const displayHistory: Array<{ role: "user" | "agent"; content: string }> = [];

function isReady(s: AgentSession | null): s is AgentSession {
  return Boolean(s?.alive);
}

async function ensureAgent(canvasPort: number): Promise<AgentSession> {
  if (isReady(session)) return session;
  if (starting) return starting;
  starting = (async () => {
    const s: AgentSession =
      BACKEND.kind === "pi" ? new PiRpcSession(canvasPort) : new AcpSession(BACKEND, canvasPort);
    await s.start();
    session = s;
    starting = null;
    return s;
  })().catch((e) => {
    starting = null;
    throw e;
  });
  return starting;
}

async function chatWithAgent(message: string, board: string, canvasPort: number): Promise<string> {
  const agent = await ensureAgent(canvasPort);
  const context = `[用户正在浏览器里查看画板「${board || "default"}」。]\n\n${message}`;
  // agent 工作期间（思考+作画）点亮画布呼吸灯
  await setAgentWorking(true);
  try {
    const reply = await agent.prompt(context, PROMPT_TIMEOUT);
    return reply || "（agent 没有文字回复，但它可能已经动手画了）";
  } finally {
    await setAgentWorking(false);
  }
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

// ---------------------------------------------------------------------------
// agent 运行信息聚合（右上角浮窗数据源）
// ---------------------------------------------------------------------------

interface NameItem {
  name: string;
  location?: string;
  description?: string;
}

/** 扫描目录条目：子目录名 + 顶层 .ts/.js/.md 文件名（skillDir 模式要求子目录含 SKILL.md） */
function scanEntries(dir: string, location: string, opts?: { skillDir?: boolean }): NameItem[] {
  const out: NameItem[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      try {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (!opts?.skillDir || existsSync(join(full, "SKILL.md"))) out.push({ name, location });
        } else if (/\.(ts|js|md)$/.test(name)) {
          out.push({ name: name.replace(/\.(ts|js|md)$/, ""), location });
        }
      } catch {
        /* 跳过坏条目 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return out;
}

/** settings.json 里的 mcpServers（用户级 + 项目级） */
function scanMcpServers(): NameItem[] {
  const out: NameItem[] = [];
  const files: Array<[string, string]> = [
    [join(homedir(), ".pi/agent/settings.json"), "用户级"],
    [join(process.cwd(), ".pi/settings.json"), "项目级"],
  ];
  for (const [file, location] of files) {
    try {
      const cfg = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
      for (const name of Object.keys(cfg.mcpServers ?? {})) out.push({ name, location });
    } catch {
      /* 无配置 */
    }
  }
  return out;
}

async function collectAgentDetail(): Promise<Record<string, unknown>> {
  const detail: Record<string, unknown> = { backend: BACKEND.label, started: isReady(session) };
  // 运行状态（pi RPC：模型/思考级别/会话/skills）
  if (BACKEND.kind === "pi" && isReady(session) && session instanceof PiRpcSession) {
    const state = await session.getState();
    if (state) {
      const model = state.model as { id?: string; provider?: string; name?: string } | null;
      detail.model = model ? { id: model.id, provider: model.provider, name: model.name } : null;
      detail.thinkingLevel = state.thinkingLevel;
      detail.sessionName = state.sessionName;
      detail.messageCount = state.messageCount;
    }
    const cmds = await session.getCommands();
    if (cmds) {
      detail.skills = cmds
        .filter((c) => c.source === "skill")
        .map((c) => ({ name: c.name, description: c.description, location: c.location }));
      detail.extensionCommands = cmds
        .filter((c) => c.source === "extension")
        .map((c) => ({ name: c.name, description: c.description }));
    }
  }
  // 扩展：文件系统扫描（用户级 + 项目级）
  detail.extensions = [
    ...scanEntries(join(homedir(), ".pi/agent/extensions"), "用户级"),
    ...scanEntries(join(process.cwd(), ".pi/extensions"), "项目级"),
  ];
  // skills：RPC 拿不到时扫目录兼底
  if (!detail.skills) {
    detail.skills = [
      ...scanEntries(join(homedir(), ".pi/agent/skills"), "用户级", { skillDir: true }),
      ...scanEntries(join(process.cwd(), ".pi/skills"), "项目级", { skillDir: true }),
    ];
  }
  detail.mcpServers = scanMcpServers();
  detail.selfMcp = "handdraw-mcp：本项目自带 MCP server（npm run mcp），可供其他 agent 接入画布";
  return detail;
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
    if (url.pathname === "/api/agent/detail" && req.method === "GET") {
      json(200, { ok: true, ...(await collectAgentDetail()) });
      return true;
    }
    if (url.pathname === "/api/chat/history" && req.method === "GET") {
      json(200, { messages: displayHistory.slice(-100) });
      return true;
    }
    if (url.pathname === "/api/chat/reset" && req.method === "POST") {
      displayHistory.length = 0;
      if (session) {
        await session.reset().catch(() => session?.kill());
        if (!isReady(session)) session = null;
      }
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
  console.log(`   agent 后端: ${BACKEND.label}${BACKEND.kind === "pi" ? "（rpc 模式）" : "（ACP）"}`);
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
  session?.kill();
  getCanvasServer().stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("web-agent 启动失败:", err);
  process.exit(1);
});
