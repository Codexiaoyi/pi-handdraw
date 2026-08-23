#!/usr/bin/env node
/**
 * web-agent.ts — 独立 Web 画布 + 外部 agent 聊天桥
 *
 * 启动画布服务器，并在页面左侧提供一个可推拉的聊天面板。
 * 聊天后端不是内置 LLM，而是桥接到你自己安装的 agent：
 *
 * - pi（默认）：走 pi 自带的 --mode rpc（JSONL 协议），直接复用你已安装的
 *   handdraw pi 扩展；每个画板拥有独立会话，持久保存在 boards/<board>/.pi-web-session/
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
 *   固定端口 HANDDRAW_CANVAS_PORT（默认 8788）
 *
 * 运行：
 *   npm run agent                          # 默认 pi
 *   HANDDRAW_AGENT_BACKEND=codex npm run agent
 *
 * HTTP API：
 *   GET  /api/agent/info    → { ok, backend, configured }
 *   GET  /api/chat/history?board=<board>  → 该画板的会话记录
 *   POST /api/chat          → { message, board } → 该画板的 session reply（全局串行，忙碌时 409）
 *   POST /api/chat/reset    → { board }，清空该画板记录并重开其 agent 会话
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, exec, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOARDS_DIR, DEFAULT_BOARD, getCanvasServer, isValidBoardName } from "./canvas-server";
import { setAgentWorking } from "./core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(__dirname, "mcp-server.ts");

const AUTO_APPROVE = process.env.HANDDRAW_ACP_AUTO_APPROVE !== "0";
const PROMPT_TIMEOUT = Number(process.env.HANDDRAW_AGENT_TIMEOUT_MS ?? 600_000);
const INIT_TIMEOUT = 180_000; // pi 首次启动加载扩展 / npx 首次下载适配器都可能较慢

/** 追加给 agent 的场景说明（pi 用 --append-system-prompt；ACP 后端拼在每条消息前缀里） */
const SCENARIO_PROMPT =
  "你现在处在一个网页画布聊天场景中：用户通过浏览器页面左侧的聊天框和你对话。" +
  "你是蚁后，只负责理解需求、查看画布、整体布局、拆分任务、调用 handdraw_delegate 调度工蚁和最终验收；严禁自己直接绘图或修改画布。" +
  "所有新增、更新、删除、清空操作都必须交给工蚁；handdraw_canvas 仅可用于 status 查看，任何写操作都会被系统拒绝。" +
  "每条用户消息开头会注明用户正在查看的画板名，画图/改图请把 board 参数设为该画板名。" +
  "画图时，连接箭头必须从节点边缘出发并尽量走空白区域，绝不能穿过任何节点实体；直线会碰到对象时，优先使用明显的弧线路径（type:path），必要时用折线绕开。" +
  "采用多步小走：每次只调用 handdraw_delegate 委派当前最小可见的一小块，优先 1 个任务；不要一次性安排整张图，不要提交 noop 或空任务。工蚁完成后再用 handdraw_canvas status 验收，再决定下一小步。" +
  "跨区域标题、箭头和验收也只能拆成后续工蚁小任务执行，蚁后不得直接补画。" +
  "回复保持简洁口语化；纯聊天不要调用工具。";

const WORKER_PROMPT =
  "你是蚁后的绘图工蚁，只执行主 agent 通过 handdraw_delegate 分配给你的任务。" +
  "你不和用户对话，不重新规划整体布局，不调用 handdraw_delegate，不修改任务区域外的内容。" +
  "你必须使用任务指定的 board，并把元素放在指定 region 内；一个任务内的元素按顺序绘制。" +
  "完成后简短返回 completed；遇到覆盖、坐标或工具错误返回 blocked 及原因。";

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
  /** 工蚁身份；蚁后会话没有这个字段。 */
  readonly workerId?: string;
  kill(): void;
  /** 注册文字增量回调；返回注销函数，避免每轮任务叠加旧订阅。 */
  onTextDelta(cb: (delta: string, full: string) => void): () => void;
  /** 注册思考（reasoning）增量回调；reasoning 模型在出 text 之前的思考也能推到前端气泡。 */
  onThinkingDelta(cb: (delta: string, full: string) => void): () => void;
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
  message?: { stopReason?: string; errorMessage?: string };
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
  private turnThinking = "";
  private turnError: string | null = null;
  private settledResolve: (() => void) | null = null;
  private textDeltaCbs: Array<(delta: string, full: string) => void> = [];
  private thinkingDeltaCbs: Array<(delta: string, full: string) => void> = [];

  onTextDelta(cb: (delta: string, full: string) => void): () => void {
    this.textDeltaCbs.push(cb);
    return () => {
      const index = this.textDeltaCbs.indexOf(cb);
      if (index >= 0) this.textDeltaCbs.splice(index, 1);
    };
  }
  onThinkingDelta(cb: (delta: string, full: string) => void): () => void {
    this.thinkingDeltaCbs.push(cb);
    return () => {
      const index = this.thinkingDeltaCbs.indexOf(cb);
      if (index >= 0) this.thinkingDeltaCbs.splice(index, 1);
    };
  }
  private emitTextDelta(delta: string, full: string) {
    for (const cb of this.textDeltaCbs) {
      try { cb(delta, full); } catch { /* ignore */ }
    }
  }
  private emitThinkingDelta(delta: string, full: string) {
    for (const cb of this.thinkingDeltaCbs) {
      try { cb(delta, full); } catch { /* ignore */ }
    }
  }

  constructor(private canvasPort: number, private board: string, readonly workerId?: string) {}

  async start(): Promise<void> {
    // 每个画板一个持久的 pi session，不会在切换画板后携带其他画板上下文。
    const sessionDir = join(BOARDS_DIR, this.board, this.workerId ? `.pi-worker-${this.workerId}` : ".pi-web-session");
    mkdirSync(sessionDir, { recursive: true });
    const extraArgs = (process.env.HANDDRAW_PI_ARGS ?? "").split(/\s+/).filter(Boolean);
    const proc = spawn(
      "pi",
      [
        "--mode", "rpc",
        "--session-dir", sessionDir,
        "--name", this.workerId ? `handdraw-${this.workerId}` : "handdraw-web-chat",
        "--append-system-prompt", this.workerId ? WORKER_PROMPT : SCENARIO_PROMPT,
        ...extraArgs,
      ],
      {
        cwd: process.cwd(),
        // 让 handdraw 扩展找到本进程的画布服务器（remote 复用模式，走 HTTP 推送）
        env: {
          ...process.env,
          HANDDRAW_CANVAS_PORT: String(this.canvasPort),
          HANDDRAW_WORKER_ID: this.workerId ?? "",
        },
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
      const delta = msg.assistantMessageEvent.delta ?? "";
      this.turnText += delta;
      this.emitTextDelta(delta, this.turnText);
      return;
    }
    // 蚁后/工蚁 reasoning 阶段的思考增量：推到气泡里可见，避免“思考中…”看不到任何字。
    if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "thinking_delta") {
      const delta = msg.assistantMessageEvent.delta ?? "";
      this.turnThinking += delta;
      this.emitThinkingDelta(delta, this.turnThinking);
      return;
    }
    if (msg.type === "message_end") {
      const message = msg.message;
      if (message?.stopReason === "error" || message?.stopReason === "aborted") {
        this.turnError = message.errorMessage || `agent ${message.stopReason}`;
      }
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
    this.turnThinking = "";
    this.turnError = null;
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
    if (this.turnError) throw new Error(this.turnError);
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

  /** RPC get_available_models：列出当前 pi 配置中可选的模型。 */
  async getAvailableModels(): Promise<Array<{ id: string; provider: string; name?: string }> | null> {
    if (!this.alive) return null;
    try {
      const data = (await this.command({ type: "get_available_models" }, 15_000)) as {
        models?: Array<{ id?: string; provider?: string; name?: string }>;
      };
      return (data.models ?? [])
        .filter((model) => typeof model.id === "string" && typeof model.provider === "string")
        .map((model) => ({ id: model.id!, provider: model.provider!, name: model.name }));
    } catch {
      return null;
    }
  }

  /** RPC set_model：保留当前画板会话上下文，仅切换后续请求使用的模型。 */
  async setModel(provider: string, modelId: string): Promise<{ id?: string; provider?: string; name?: string } | null> {
    if (!this.alive) throw new Error("pi 会话未启动");
    return (await this.command({ type: "set_model", provider, modelId }, 30_000)) as {
      id?: string;
      provider?: string;
      name?: string;
    } | null;
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
  private turnThinking = "";
  private sessionId: string | null = null;
  private textDeltaCbs: Array<(delta: string, full: string) => void> = [];
  private thinkingDeltaCbs: Array<(delta: string, full: string) => void> = [];

  constructor(
    private spec: { label: string; cmd: string; args: string[] },
    private canvasPort: number,
    readonly workerId?: string
  ) {
    this.label = spec.label;
  }

  onTextDelta(cb: (delta: string, full: string) => void): () => void {
    this.textDeltaCbs.push(cb);
    return () => {
      const index = this.textDeltaCbs.indexOf(cb);
      if (index >= 0) this.textDeltaCbs.splice(index, 1);
    };
  }
  onThinkingDelta(cb: (delta: string, full: string) => void): () => void {
    this.thinkingDeltaCbs.push(cb);
    return () => {
      const index = this.thinkingDeltaCbs.indexOf(cb);
      if (index >= 0) this.thinkingDeltaCbs.splice(index, 1);
    };
  }
  private emitTextDelta(delta: string, full: string) {
    for (const cb of this.textDeltaCbs) {
      try { cb(delta, full); } catch { /* ignore */ }
    }
  }
  private emitThinkingDelta(delta: string, full: string) {
    for (const cb of this.thinkingDeltaCbs) {
      try { cb(delta, full); } catch { /* ignore */ }
    }
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
            env: [
              { name: "HANDDRAW_CANVAS_PORT", value: String(this.canvasPort) },
              { name: "HANDDRAW_WORKER_ID", value: this.workerId ?? "" },
            ],
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
        const delta = update.content.text ?? "";
        this.turnText += delta;
        this.emitTextDelta(delta, this.turnText);
      } else if (update?.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") {
        // ACP 的思考增量：agent_thought_chunk。与 text 分离，保证 reasoning 不会污染最终回复。
        const delta = update.content.text ?? "";
        this.turnThinking += delta;
        this.emitThinkingDelta(delta, this.turnThinking);
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
    this.turnThinking = "";
    const prompt = this.workerId ? `${WORKER_PROMPT}\n\n${text}` : text;
    await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: prompt }] }, timeoutMs);
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
type ChatMessage = {
  role: "user" | "agent" | "system" | "worker";
  content: string;
  time?: string;
};
type BoardAgentState = {
  session: AgentSession | null;
  starting: Promise<AgentSession> | null;
  history: ChatMessage[];
  activeAgentMessage: ChatMessage | null;
  /** 蚁后当前 reasoning 增量全文本；仅前端驱动态用，不写入历史。 */
  activeThinking: string;
  persistTimer: ReturnType<typeof setTimeout> | null;
};

function historyFile(board: string): string {
  return join(BOARDS_DIR, boardKey(board), "chat-history.json");
}
function persistHistory(board: string): void {
  const state = getBoardAgent(board);
  try {
    mkdirSync(join(BOARDS_DIR, boardKey(board)), { recursive: true });
    writeFileSync(historyFile(board), JSON.stringify(state.history, null, 2));
  } catch { /* history must never break drawing */ }
}
function scheduleHistoryPersist(board: string): void {
  const state = getBoardAgent(board);
  if (state.persistTimer) return;
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    persistHistory(board);
  }, 120);
}
function addHistory(board: string, role: ChatMessage["role"], content: string): ChatMessage {
  const message = { role, content, time: new Date().toISOString() } satisfies ChatMessage;
  const state = getBoardAgent(board);
  state.history.push(message);
  scheduleHistoryPersist(board);
  return message;
}
const boardAgents = new Map<string, BoardAgentState>();

interface QueuedWorkerTask {
  taskId: string;
  title?: string;
  region: { x: number; y: number; w: number; h: number };
  instructions: string;
}
interface WorkerRuntime {
  id: string;
  session: AgentSession | null;
  starting: Promise<AgentSession> | null;
  task: QueuedWorkerTask | null;
  status: "idle" | "starting" | "drawing" | "blocked" | "failed";
}
interface WorkerBoardState {
  queue: QueuedWorkerTask[];
  workers: WorkerRuntime[];
  /** 已排队或执行中的区域预留；任务结束后释放。 */
  reservations: Array<{ taskId: string; region: QueuedWorkerTask["region"] }>;
}
const workerBoards = new Map<string, WorkerBoardState>();
const workerWarmups = new Set<string>();
const dispatchVersions = new Map<string, number>();
// 蚁后聊天仍然是一问一答；工蚁队列完全独立，后台异步执行。
let busy = false;
// 每轮聊天最多派一批当前小任务，下一步由下一轮 status 验收后再安排。
let dispatchesThisTurn = 0;

function workerBoard(board: string): WorkerBoardState {
  const key = boardKey(board);
  let state = workerBoards.get(key);
  if (!state) {
    state = {
      queue: [],
      reservations: [],
      workers: Array.from({ length: 4 }, (_, i) => ({
        id: `worker-${i + 1}`,
        session: null,
        starting: null,
        task: null,
        status: "idle",
      })),
    };
    workerBoards.set(key, state);
  }
  return state;
}

async function reportWorker(worker: WorkerRuntime, board: string): Promise<void> {
  // 同进程直调 registry（单一来源）；广播由 CanvasServer 的订阅者完成
  getCanvasServer().workerRegistry.update(boardKey(board), worker.id, {
    status: worker.status,
    taskId: worker.task?.taskId,
    region: worker.task?.region,
  });
}

async function ensureWorker(worker: WorkerRuntime, board: string, canvasPort: number): Promise<AgentSession> {
  if (isReady(worker.session)) return worker.session;
  if (worker.starting) return worker.starting;
  worker.status = "starting";
  await reportWorker(worker, board);
  worker.starting = (async () => {
    const session: AgentSession =
      BACKEND.kind === "pi"
        ? new PiRpcSession(canvasPort, boardKey(board), worker.id)
        : new AcpSession(BACKEND, canvasPort, worker.id);
    await session.start();
    bindWorkerStream(session, worker.id, board);
    worker.session = session;
    worker.starting = null;
    return session;
  })().catch((e) => {
    worker.starting = null;
    worker.status = "failed";
    void reportWorker(worker, board);
    throw e;
  });
  return worker.starting;
}

function regionsOverlap(a: QueuedWorkerTask["region"], b: QueuedWorkerTask["region"]): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

async function warmWorkers(board: string, canvasPort: number): Promise<void> {
  const key = boardKey(board);
  if (workerWarmups.has(key)) return;
  workerWarmups.add(key);
  const state = workerBoard(key);
  await Promise.all(state.workers.map(async (worker) => {
    try {
      await ensureWorker(worker, board, canvasPort);
      if (!worker.task) {
        worker.status = "idle";
        await reportWorker(worker, board);
      }
    } catch (error) {
      console.error(`[${worker.id}] 预热失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  workerWarmups.delete(key);
}

function scheduleWorkerWarmup(board: string, canvasPort: number): void {
  void warmWorkers(board, canvasPort).catch((error) => console.error(`工蚁预热失败：${error instanceof Error ? error.message : String(error)}`));
}

function isDrawingRequest(message: string): boolean {
  return /画|绘|图|架构|流程|涂鸦|手帐|示意|设计|做个|制作|绘制|draw|diagram|sketch/i.test(message);
}

async function boardRegionElementCount(
  board: string,
  canvasPort: number,
  region: { x: number; y: number; w: number; h: number }
): Promise<number | null> {
  try {
    const response = await fetch(`http://localhost:${canvasPort}/state?board=${encodeURIComponent(boardKey(board))}`);
    if (!response.ok) return null;
    const summary = await response.json() as {
      occupied?: Array<{ x: number; y: number; w: number; h: number }>;
    };
    return (summary.occupied ?? []).filter((item) =>
      item.x >= region.x - 2 && item.y >= region.y - 2 &&
      item.x + item.w <= region.x + region.w + 2 &&
      item.y + item.h <= region.y + region.h + 2
    ).length;
  } catch {
    return null;
  }
}

async function fallbackDelegate(board: string, message: string, canvasPort: number): Promise<void> {
  const key = boardKey(board);
  let summary: { bounds?: { maxX: number; minY: number }; occupied?: Array<{ x: number; y: number; w: number; h: number }> } = {};
  try {
    const res = await fetch(`http://localhost:${canvasPort}/state?board=${encodeURIComponent(key)}`);
    summary = await res.json() as typeof summary;
  } catch { /* 使用默认空位 */ }
  const maxX = Number.isFinite(summary.bounds?.maxX) ? summary.bounds!.maxX : 80;
  const minY = Number.isFinite(summary.bounds?.minY) ? Math.max(80, summary.bounds!.minY) : 100;
  const x = maxX + 140;
  const region = { x, y: minY, w: 300, h: 220 };
  const tasks = [{
    taskId: `auto-${Date.now()}-1`,
    title: "自动拆分 当前第一小步",
    region,
    instructions:
      `用户原始需求：${message}\n` +
      "这是系统兜底的第一小步。只在指定 region 内绘制一个简单、可见的起始元素；" +
      "必须使用明确的绝对坐标、每个元素带 desc，不能调用 handdraw_delegate。完成后等待下一步，不要扩展到其他区域。",
  }];
  await enqueueWorkerTasks(key, tasks, canvasPort);
  addHistory(key, "system", `系统兜底：蚁后本轮未成功委派，已自动安排 1 个最小任务：\n${tasks.map((t) => `- ${t.taskId}：${t.title} @ ${JSON.stringify(t.region)}`).join("\n")}`);
}

async function pumpWorkers(board: string, canvasPort: number): Promise<void> {
  const state = workerBoard(board);
  for (const worker of state.workers) {
    if (worker.task || state.queue.length === 0) continue;
    worker.task = state.queue.shift()!;
    worker.status = "drawing";
    void (async () => {
      const task = worker.task!;
      try {
        // 先登记 taskId/region，再让 worker 调用绘图工具，避免首笔画撞上状态竞态。
        await reportWorker(worker, board);
        const beforeCount = await boardRegionElementCount(board, canvasPort, task.region);
        const session = await ensureWorker(worker, board, canvasPort);
        worker.status = "drawing";
        await reportWorker(worker, board);
        const prompt =
          `[异步工蚁任务]\n任务 ID：${task.taskId}\n画板：${boardKey(board)}\n` +
          `允许区域：${JSON.stringify(task.region)}\n任务标题：${task.title ?? "未命名"}\n` +
          `绘图要求：${task.instructions}\n` +
          "调用 handdraw_canvas 时必须原样携带 taskId 和 region 参数；每个元素必须完全位于 region 内。只画这个区域内的任务；完成后回复 completed。";
        addHistory(board, "worker", `${worker.id} 已领取任务 ${task.taskId}\n区域：${JSON.stringify(task.region)}\n要求：${task.instructions}`);
        const workerReply = await session.prompt(prompt, PROMPT_TIMEOUT);
        const afterCount = await boardRegionElementCount(board, canvasPort, task.region);
        if (beforeCount !== null && afterCount !== null && afterCount <= beforeCount) {
          worker.status = "failed";
          addHistory(board, "worker", `${worker.id} 任务 ${task.taskId} 失败：模型已结束，但画板没有新增元素；未记录为完成。${workerReply ? `\n回复：${workerReply}` : ""}`);
        } else {
          worker.status = "idle";
          addHistory(board, "worker", `${worker.id} 完成任务 ${task.taskId}${workerReply ? `\n回复：${workerReply}` : ""}`);
        }
      } catch (error) {
        worker.status = "failed";
        const reason = error instanceof Error ? error.message : String(error);
        addHistory(board, "worker", `${worker.id} 任务 ${task.taskId} 失败：${reason}`);
        console.error(`[${worker.id}] ${reason}`);
      } finally {
        worker.task = null;
        const reservationIndex = state.reservations.findIndex((r) => r.taskId === task.taskId);
        if (reservationIndex >= 0) state.reservations.splice(reservationIndex, 1);
        await reportWorker(worker, board);
        void pumpWorkers(board, canvasPort);
      }
    })();
  }
}

async function enqueueWorkerTasks(
  board: string,
  tasks: Array<{ taskId?: string; title?: string; region: { x: number; y: number; w: number; h: number }; instructions: string }>,
  canvasPort: number
): Promise<{ queued: number; workers: WorkerRuntime[] }> {
  const state = workerBoard(board);
  const normalized = tasks.map((task, index) => ({
    ...task,
    taskId: task.taskId || `task-${Date.now()}-${index + 1}`,
  }));
  const ids = new Set<string>();
  for (const task of normalized) {
    if (ids.has(task.taskId) || state.reservations.some((r) => r.taskId === task.taskId)) {
      throw new Error(`任务 ID 重复：${task.taskId}`);
    }
    ids.add(task.taskId);
    if (!(task.region.w > 0 && task.region.h > 0)) throw new Error(`任务区域尺寸必须大于 0：${task.taskId}`);
    if (state.reservations.some((r) => regionsOverlap(task.region, r.region))) {
      const hit = state.reservations.find((r) => regionsOverlap(task.region, r.region))!;
      throw new Error(`任务区域与现有任务重叠：${task.taskId} 与 ${hit.taskId}`);
    }
    for (const other of normalized) {
      if (other !== task && other.taskId < task.taskId && regionsOverlap(task.region, other.region)) {
        throw new Error(`任务区域重叠：${task.taskId} 与 ${other.taskId}`);
      }
    }
  }
  for (const task of normalized) {
    state.reservations.push({ taskId: task.taskId, region: task.region });
    state.queue.push(task);
  }
  dispatchVersions.set(boardKey(board), (dispatchVersions.get(boardKey(board)) ?? 0) + 1);
  void pumpWorkers(board, canvasPort);
  return { queued: normalized.length, workers: state.workers };
}

function boardKey(board: string): string {
  return board || DEFAULT_BOARD;
}
function getBoardAgent(board: string): BoardAgentState {
  const key = boardKey(board);
  let state = boardAgents.get(key);
  if (!state) {
    let history: ChatMessage[] = [];
    try {
      const saved = JSON.parse(readFileSync(historyFile(key), "utf8")) as unknown;
      if (Array.isArray(saved)) history = saved.filter((m): m is ChatMessage => Boolean(m && typeof m === "object" && typeof (m as ChatMessage).content === "string"));
    } catch { /* 首次使用或旧版本没有历史 */ }
    state = { session: null, starting: null, history, activeAgentMessage: null, activeThinking: "", persistTimer: null };
    boardAgents.set(key, state);
  }
  return state;
}

function bindQueenStream(session: AgentSession, board: string): void {
  const state = getBoardAgent(board);
  session.onTextDelta((delta, full) => {
    void setAgentWorking(true);
    if (!state.activeAgentMessage) {
      state.activeAgentMessage = addHistory(board, "agent", "");
    }
    state.activeAgentMessage.content = full;
    // 若蚁后输出的首句话是思考内容，前端会立即看到“思考中…”被实际文字覆盖。
    state.activeThinking = "";
    scheduleHistoryPersist(board);
    getCanvasServer().broadcastSpeech({
      board: boardKey(board),
      kind: "text",
      delta,
      full,
      done: false,
    });
  });
  // reasoning 增量：完整打到蚁后气泡里，避免“思考中…”看不见任何字。
  session.onThinkingDelta((delta, full) => {
    void setAgentWorking(true);
    state.activeThinking = full;
    if (!state.activeAgentMessage) {
      // 思考先于第一条 text：仅占位，不写入历史（思考是中途状态，历史只记最终文字回复）。
      state.activeAgentMessage = addHistory(board, "agent", "");
    }
    scheduleHistoryPersist(board);
    getCanvasServer().broadcastSpeech({
      board: boardKey(board),
      kind: "thinking",
      delta,
      full,
      done: false,
    });
  });
}

function bindWorkerStream(session: AgentSession, workerId: string, board: string): void {
  // 每只工蚁独立 session：text 与 thinking 增量都带上 workerId，前端路由到该工蚁专属气泡。
  session.onTextDelta((delta, full) => {
    getCanvasServer().broadcastSpeech({
      board: boardKey(board),
      kind: "text",
      delta,
      full,
      done: false,
      workerId,
    });
  });
  session.onThinkingDelta((delta, full) => {
    getCanvasServer().broadcastSpeech({
      board: boardKey(board),
      kind: "thinking",
      delta,
      full,
      done: false,
      workerId,
    });
  });
}

function finishQueenStream(board: string): string | null {
  const state = getBoardAgent(board);
  const content = state.activeAgentMessage?.content ?? null;
  if (content != null) {
    getCanvasServer().broadcastSpeech({
      board: boardKey(board),
      kind: "text",
      full: content,
      done: true,
    });
    // 思考阶段没有产生文字时，移除临时占位消息，避免历史里留下空的“蚁后”气泡。
    if (!content.trim() && state.activeAgentMessage) {
      const index = state.history.indexOf(state.activeAgentMessage);
      if (index >= 0) state.history.splice(index, 1);
    }
    state.activeAgentMessage = null;
    state.activeThinking = "";
    scheduleHistoryPersist(board);
  }
  return content;
}
function isReady(s: AgentSession | null): s is AgentSession {
  return Boolean(s?.alive);
}

async function ensureAgent(board: string, canvasPort: number): Promise<AgentSession> {
  const key = boardKey(board);
  const state = getBoardAgent(key);
  if (isReady(state.session)) return state.session;
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const s: AgentSession =
      BACKEND.kind === "pi" ? new PiRpcSession(canvasPort, key) : new AcpSession(BACKEND, canvasPort);
    await s.start();
    state.session = s;
    state.starting = null;
    bindQueenStream(s, key);
    return s;
  })().catch((e) => {
    state.starting = null;
    throw e;
  });
  return state.starting;
}

async function chatWithAgent(message: string, board: string, canvasPort: number): Promise<string> {
  const key = boardKey(board);
  const agent = await ensureAgent(key, canvasPort);
  // 先确保蚁后会话独占首轮资源，再后台预热工蚁，避免五个模型进程同时抢启动资源。
  scheduleWorkerWarmup(key, canvasPort);
  const context = `[用户正在浏览器里查看画板「${key}」。]\n\n${message}`;
  const dispatchVersionBefore = dispatchVersions.get(key) ?? 0;
  // 先把用户消息和一个临时的蚁后消息放进历史；模型尚未输出文字时，历史也能显示“思考中…”。
  addHistory(key, "user", message);
  dispatchesThisTurn = 0;
  const state = getBoardAgent(key);
  state.activeAgentMessage = addHistory(key, "agent", "");
  try {
    const reply = await agent.prompt(context, PROMPT_TIMEOUT);
    if (isDrawingRequest(message) && (dispatchVersions.get(key) ?? 0) === dispatchVersionBefore) {
      await fallbackDelegate(key, message, canvasPort);
    }
    const streamed = finishQueenStream(key);
    // pi/ACP 若没有文本增量，仍记录最终回复；若最终文本与流式文本不同，也保留两者。
    if (reply && streamed !== reply) addHistory(key, "agent", reply);
    return reply || "（agent 没有文字回复，但它可能已经动手画了）";
  } catch (e) {
    finishQueenStream(key);
    addHistory(key, "system", `蚁后执行失败：${e instanceof Error ? e.message : String(e)}`);
    throw e;
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

async function collectAgentDetail(board: string): Promise<Record<string, unknown>> {
  const key = boardKey(board);
  const session = getBoardAgent(key).session;
  const detail: Record<string, unknown> = { backend: BACKEND.label, board: key, started: isReady(session) };
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
      const board = url.searchParams.get("board") ?? "";
      json(200, { ok: true, ...(await collectAgentDetail(board)) });
      return true;
    }
    if (url.pathname === "/api/delegate" && req.method === "POST") {
      try {
        if (busy && dispatchesThisTurn >= 1) {
          throw new Error("本轮已安排一个小步骤；请等工蚁完成并在下一轮查看 status 后再继续委派");
        }
        const body = await readBody(req);
        const board = String(body.board ?? DEFAULT_BOARD);
        if (!isValidBoardName(board)) throw new Error("非法画板名");
        const rawTasks = Array.isArray(body.tasks) ? body.tasks : [];
        const tasks = rawTasks.filter((task): task is Record<string, unknown> => Boolean(task && typeof task === "object"));
        if (!tasks.length) throw new Error("没有任务");
        if (tasks.length < 1 || tasks.length > 4) throw new Error("增量委派每次要求 1～4 个互不重叠的区域任务；建议每次只派 1 个小任务");
        if (busy && tasks.length !== 1) throw new Error("多步小走模式下，每轮只能委派 1 个当前小任务；完成后下一轮再继续");
        const normalized = tasks.map((task, index) => {
          const region = task.region as Record<string, unknown>;
          if (!region || ![region.x, region.y, region.w, region.h].every((n) => typeof n === "number" && Number.isFinite(n))) {
            throw new Error(`任务 ${index + 1} 缺少有效 region`);
          }
          const instructions = String(task.instructions ?? "").trim();
          if (!instructions) throw new Error(`任务 ${index + 1} 缺少 instructions`);
          return {
            taskId: String(task.taskId ?? `task-${Date.now()}-${index + 1}`),
            title: task.title ? String(task.title) : undefined,
            region: { x: Number(region.x), y: Number(region.y), w: Number(region.w), h: Number(region.h) },
            instructions,
          };
        });
        for (let i = 0; i < normalized.length; i++) {
          for (let j = i + 1; j < normalized.length; j++) {
            const a = normalized[i].region;
            const b = normalized[j].region;
            if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
              throw new Error(`任务区域重叠：${normalized[i].taskId} 与 ${normalized[j].taskId}`);
            }
          }
        }
            addHistory(board, "system", `蚁后已派发 ${normalized.length} 个工蚁任务：\n${normalized.map((task) => `- ${task.taskId} @ ${JSON.stringify(task.region)}：${task.instructions}`).join("\n")}`);
        const result = await enqueueWorkerTasks(board, normalized, canvasPortRef());
        if (busy) dispatchesThisTurn++;
        setTimeout(() => scheduleWorkerWarmup(board, canvasPortRef()), 1500);
        json(200, { ok: true, board: boardKey(board), ...result, workers: result.workers.map((w) => ({ id: w.id, status: w.status, taskId: w.task?.taskId })) });
      } catch (e) {
        json(400, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    // 模型切换只适用于 pi RPC；选择器打开时会预热当前画板的会话，以便读取可用模型。
    if (url.pathname === "/api/agent/models" && req.method === "GET") {
      if (BACKEND.kind !== "pi") {
        json(400, { ok: false, error: "当前 ACP 后端不支持从画布切换模型" });
        return true;
      }
      try {
        const board = url.searchParams.get("board") ?? "";
        const session = await ensureAgent(board, canvasPortRef());
        if (!(session instanceof PiRpcSession)) throw new Error("当前后端不支持模型切换");
        const models = await session.getAvailableModels();
        const state = await session.getState();
        if (!models) throw new Error("读取可用模型失败");
        json(200, { ok: true, board: boardKey(board), models, model: state?.model ?? null });
      } catch (e) {
        json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (url.pathname === "/api/agent/models" && req.method === "POST") {
      if (BACKEND.kind !== "pi") {
        json(400, { ok: false, error: "当前 ACP 后端不支持从画布切换模型" });
        return true;
      }
      if (busy) {
        json(409, { ok: false, error: "AI 正在处理消息，完成后再切换模型" });
        return true;
      }
      try {
        const body = await readBody(req);
        const board = String(body.board ?? "");
        const provider = String(body.provider ?? "").trim();
        const modelId = String(body.modelId ?? "").trim();
        if (!provider || !modelId) throw new Error("缺少 provider 或 modelId");
        const session = await ensureAgent(board, canvasPortRef());
        if (!(session instanceof PiRpcSession)) throw new Error("当前后端不支持模型切换");
        const model = await session.setModel(provider, modelId);
        json(200, { ok: true, board: boardKey(board), model });
      } catch (e) {
        json(400, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (url.pathname === "/api/chat/history" && req.method === "GET") {
      const board = url.searchParams.get("board") ?? "";
      const state = getBoardAgent(board);
      json(200, { board: boardKey(board), messages: state.history });
      return true;
    }
    if (url.pathname === "/api/chat/reset" && req.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await readBody(req); } catch { body = {}; }
      const board = String(body.board ?? "");
      const state = getBoardAgent(board);
      state.history.length = 0;
      state.activeAgentMessage = null;
      persistHistory(board);
      if (state.session) {
        await state.session.reset().catch(() => state.session?.kill());
        if (!isReady(state.session)) state.session = null;
      }
      json(200, { ok: true, board: boardKey(board) });
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
  // 后台预热四个长期 worker；不阻塞页面和蚁后聊天，首批任务无需再承担进程启动开销。
  if (mode === "local") {
    void ensureAgent(DEFAULT_BOARD, server.getPort()).then(() => {
      setTimeout(() => scheduleWorkerWarmup(DEFAULT_BOARD, server.getPort()), 1000);
    }).catch((error) => console.error(`蚁后预热失败：${error instanceof Error ? error.message : String(error)}`));
  }
  if (mode === "remote") {
    console.warn("   ⚠️ 8788 端口上已有一个画布服务器在跑，聊天 API 未挂载；请先停止旧 handdraw 进程");
  }
  exec(
    process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`,
    () => {}
  );
  // keep alive
  setInterval(() => {}, 1 << 30);
}

function shutdown() {
  for (const state of boardAgents.values()) state.session?.kill();
  getCanvasServer().stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("web-agent 启动失败:", err);
  process.exit(1);
});
