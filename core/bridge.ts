/**
 * core/bridge.ts — 画布桥：把 local / remote 两种画布服务器模式折叠成一个统一接口
 *
 * - LocalBridge：本进程直调 CanvasServer（最快路径）
 * - RemoteBridge：跨进程，复用远端画布服务器（HTTP）
 * - NoopBridge：服务器没起来时的兜底，不让上层报错
 *
 * 同时负责画布服务器生命周期（ensureCanvasServer / shutdownCanvasServer）和
 * agent 工作状态上报（setAgentWorking，驱动页面呼吸灯）。
 */
import { exec } from "node:child_process";
import {
  getCanvasServer,
  type CanvasServer,
  type StrokeMsg,
  type CanvasElementInfo,
  type BoardListItem,
} from "../canvas-server";

/** 画布服务器当前模式（ensureCanvasServer 内被读写） */
let canvasServerMode: "local" | "remote" | null = null;

/** 最近一次 agent 工作状态：服务器未启动时先挂起，启动成功后补发 */
let pendingAgentWorking = false;

/** Bridge 实例（懒创建；ensureCanvasServer 成功后强制重建） */
let currentBridge: CanvasBridge | null = null;

/** 画布桥统一接口：local / remote / noop 三个实现都满足 */
export interface CanvasBridge {
  push(board: string, msgs: StrokeMsg[], infos: CanvasElementInfo[]): Promise<void>;
  summary(board: string): Promise<Record<string, unknown>>;
  modify(board: string, action: "update" | "remove", elementId: string, strokes?: StrokeMsg[], info?: CanvasElementInfo): Promise<boolean>;
  listBoards(): Promise<{ active: string; boards: BoardListItem[] }>;
  op(action: "create" | "switch" | "delete", name: string): Promise<{ ok: boolean; created?: boolean }>;
  clear(board: string): Promise<void>;
  setAgentWorking(working: boolean): Promise<void>;
}

/** 拿到当前 bridge；首次调用时懒创建并锁定 */
export function getBridge(): CanvasBridge {
  if (currentBridge) return currentBridge;
  const server = getCanvasServer();
  if (canvasServerMode === "remote") {
    currentBridge = new RemoteBridge(server.getPort());
  } else if (canvasServerMode === "local") {
    currentBridge = new LocalBridge(server);
  } else {
    currentBridge = new NoopBridge();
  }
  return currentBridge;
}

/** 本进程直接调 CanvasServer 方法（最快路径） */
class LocalBridge implements CanvasBridge {
  constructor(private server: CanvasServer) {}
  push(board: string, msgs: StrokeMsg[], infos: CanvasElementInfo[]): Promise<void> {
    this.server.pushStrokes(board, msgs, infos);
    return Promise.resolve();
  }
  async summary(board: string): Promise<Record<string, unknown>> {
    return this.server.getSummary(board) as unknown as Record<string, unknown>;
  }
  modify(board: string, action: "update" | "remove", elementId: string, strokes: StrokeMsg[] = [], info?: CanvasElementInfo): Promise<boolean> {
    return Promise.resolve(
      action === "update"
        ? this.server.updateElement(board, elementId, strokes, info as CanvasElementInfo)
        : this.server.removeElement(board, elementId)
    );
  }
  listBoards(): Promise<{ active: string; boards: BoardListItem[] }> {
    return Promise.resolve({ active: this.server.getActiveBoard(), boards: this.server.listBoards() });
  }
  op(action: "create" | "switch" | "delete", name: string): Promise<{ ok: boolean; created?: boolean }> {
    switch (action) {
      case "create": return Promise.resolve({ ok: true, created: this.server.createBoard(name) });
      case "switch": return Promise.resolve({ ok: this.server.switchBoard(name) });
      case "delete": return Promise.resolve({ ok: this.server.deleteBoard(name) });
    }
  }
  clear(board: string): Promise<void> {
    this.server.clear(board);
    return Promise.resolve();
  }
  setAgentWorking(working: boolean): Promise<void> {
    this.server.setAgentWorking(working);
    return Promise.resolve();
  }
}

/** 跨进程：复用远端画布服务器（HTTP POST） */
class RemoteBridge implements CanvasBridge {
  constructor(private port: number) {}
  private url(p: string) { return `http://localhost:${this.port}${p}`; }
  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(this.url(path), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    return res.json().catch(() => ({}));
  }
  private async get(path: string): Promise<any> {
    const res = await fetch(this.url(path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async push(board: string, msgs: StrokeMsg[], infos: CanvasElementInfo[]): Promise<void> {
    await this.post("/api/push", { board, strokes: msgs, elements: infos });
  }
  async summary(board: string): Promise<Record<string, unknown>> {
    return this.get(`/state?board=${encodeURIComponent(board)}`);
  }
  async modify(board: string, action: "update" | "remove", elementId: string, strokes?: StrokeMsg[], info?: CanvasElementInfo): Promise<boolean> {
    try {
      const d = await this.post(`/api/${action}`, { board, elementId, strokes, info });
      return d.ok !== false;
    } catch {
      return false;
    }
  }
  async listBoards(): Promise<{ active: string; boards: BoardListItem[] }> {
    try { return await this.get("/api/boards"); }
    catch { return { active: "default", boards: [] }; }
  }
  async op(action: "create" | "switch" | "delete", name: string): Promise<{ ok: boolean; created?: boolean }> {
    try {
      const d = await this.post("/api/boards", { action, name });
      return { ok: d.ok !== false, created: d.created };
    } catch {
      return { ok: false };
    }
  }
  async clear(board: string): Promise<void> {
    await this.post("/api/clear", { board });
  }
  async setAgentWorking(working: boolean): Promise<void> {
    await this.post("/api/agent-status", { working });
  }
}

/** 兜底：服务器没起来或没准备好时不让上层报错 */
class NoopBridge implements CanvasBridge {
  async push() { /* noop */ }
  async summary() { return {}; }
  async modify() { return false; }
  async listBoards() { return { active: "default", boards: [] }; }
  async op() { return { ok: false }; }
  async clear() { /* noop */ }
  async setAgentWorking() { /* noop */ }
}

/** 用默认浏览器打开 URL（macOS/Linux/Windows） */
function openInBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // 打开失败不影响主流程
  });
}

/** 上报 agent 工作状态（思考+作画中），驱动画布页面呼吸灯。失败静默 */
export async function setAgentWorking(working: boolean): Promise<void> {
  pendingAgentWorking = working;
  if (canvasServerMode === null) return;
  try {
    await getBridge().setAgentWorking(working);
  } catch {
    /* 呼吸灯失败不影响主流程 */
  }
}

export async function ensureCanvasServer(openBrowser: boolean): Promise<string | null> {
  const server = getCanvasServer();
  try {
    if (!server.isRunning()) {
      try {
        canvasServerMode = await server.start();
      } catch (err) {
        canvasServerMode = null;
        currentBridge = null;
        throw err;
      }
      if (openBrowser && canvasServerMode === "local") {
        openInBrowser(`http://localhost:${server.getPort()}`);
      }
    } else {
      canvasServerMode = "local";
    }
    currentBridge = null; // 强制下次 getBridge() 按新模式重建
    // 补发挂起的 agent 工作状态（agent 可能在首次动笔前就开始思考）
    if (pendingAgentWorking) void setAgentWorking(true);
    return `http://localhost:${server.getPort()}`;
  } catch {
    canvasServerMode = null;
    currentBridge = null;
    return null;
  }
}

/** 进程退出时停止本进程监听的画布服务器（remote 模式不动） */
export function shutdownCanvasServer(): void {
  if (canvasServerMode === "local") {
    getCanvasServer().stop();
  }
  canvasServerMode = null;
  currentBridge = null;
}
