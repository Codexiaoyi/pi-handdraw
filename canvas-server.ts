/**
 * canvas-server.ts — 实时画布服务器
 *
 * 本地 HTTP + WebSocket 服务器：
 * - GET /  : 提供无限画布页面（增量渲染 + 笔尖跟随动画）
 * - WS /ws : 推送"新笔画"事件，浏览器实时播放
 * - 维护画布状态（已画元素），供 AI 判断下一笔画在哪
 */
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 画布状态持久化文件（重启自动恢复） */
const STATE_FILE = join(__dirname, "canvas-state.json");

/** 候选端口（8787 可能被其他项目占用） */
export const CANVAS_PORTS = [8788, 8789, 8790, 8791];
export const CANVAS_PORT = CANVAS_PORTS[0];

export interface CanvasElementInfo {
  /** 元素唯一 ID（修改/删除用） */
  id: string;
  type: string;
  label?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StrokeMsg {
  type: "stroke";
  /** SVG path（布局坐标） */
  d: string;
  color: string;
  width: number;
  /** 书写时长 ms */
  dur: number;
  /** 填充色（填充图形） */
  fill?: string;
  /** 是否是 text 元素（字体渲染，淡入） */
  isText?: boolean;
  /** 笔画结束后笔抬起 */
  penUp?: boolean;
  label: string;
  /** 所属元素 ID（修改/删除用） */
  elementId?: string;
}

export interface CanvasSummary {
  elementCount: number;
  /** 已画内容总范围 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** 每个已画元素的位置（AI 判断空位用） */
  occupied: CanvasElementInfo[];
  /** 推荐空位（内容右侧/下方） */
  freeSpots: Array<{ x: number; y: number; w: number; h: number; hint: string }>;
}

export class CanvasServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private pageHtml = "";
  private actualPort = 0;

  /** 已画元素（摘要用） */
  private elements: CanvasElementInfo[] = [];
  private strokeCount = 0;
  private nextElId = 1;
  /** 全部已画笔画（新连接回放 + 持久化） */
  private replayCache: StrokeMsg[] = [];

  /** 持久化到磁盘（进程重启自动恢复） */
  private persist(): void {
    try {
      writeFileSync(
        STATE_FILE,
        JSON.stringify({ elements: this.elements, replayCache: this.replayCache, nextElId: this.nextElId })
      );
    } catch {
      /* ignore */
    }
  }

  /** 从磁盘恢复 */
  private load(): void {
    try {
      const data = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
        elements?: CanvasElementInfo[];
        replayCache?: StrokeMsg[];
        nextElId?: number;
      };
      this.elements = data.elements ?? [];
      this.replayCache = data.replayCache ?? [];
      this.nextElId = data.nextElId ?? 1;
      this.strokeCount = this.replayCache.length;
    } catch {
      /* ignore */
    }
  }

  getPort(): number {
    return this.actualPort || CANVAS_PORT;
  }

  isRunning(): boolean {
    return this.http !== null;
  }

  /** 检查某端口是否已有画布服务器（供复用判断） */
  static async isCanvasServerOnPort(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${port}/state`);
      if (!res.ok) return false;
      const data = (await res.json()) as { elementCount?: number };
      return typeof data.elementCount === "number";
    } catch {
      return false;
    }
  }

  /**
   * 启动：依次尝试候选端口。
   * - 空闲端口 → 本进程监听（local）
   * - 端口被占用且是画布服务器 → 复用（remote，由 index.ts 处理推送）
   * - 端口被占用但不是画布服务器 → 尝试下一个端口
   */
  async start(): Promise<"local" | "remote"> {
    if (this.http) return "local";
    // 加载画布页面
    try {
      this.pageHtml = readFileSync(join(__dirname, "canvas-page.html"), "utf8");
    } catch {
      this.pageHtml = "<html><body>canvas page missing</body></html>";
    }
    this.load(); // 恢复上次画布内容
    for (const port of CANVAS_PORTS) {
      const ok = await this.tryListen(port);
      if (ok === "local") {
        this.actualPort = port;
        return "local";
      }
      if (ok === "remote") {
        this.actualPort = port;
        return "remote";
      }
    }
    throw new Error("NO_PORT_AVAILABLE");
  }

  private tryListen(port: number): Promise<"local" | "remote" | "skip"> {
    return new Promise((resolve) => {
      const http = createServer((req, res) => {
        if (req.url === "/" || req.url === "/index.html") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(this.pageHtml);
          return;
        }
        if (req.url === "/state") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.getSummary()));
          return;
        }
        if (req.method === "POST" && req.url === "/api/push") {
          // 远程推送（其他进程复用本服务器）
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const { strokes, elements } = JSON.parse(body) as { strokes: StrokeMsg[]; elements: CanvasElementInfo[] };
              this.pushStrokes(strokes ?? [], elements ?? []);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(this.getSummary()));
            } catch {
              res.writeHead(400);
              res.end();
            }
          });
          return;
        }
        if (req.method === "POST" && (req.url === "/api/update" || req.url === "/api/remove")) {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const data = JSON.parse(body) as { elementId: string; strokes?: StrokeMsg[]; info?: CanvasElementInfo };
              if (!data.elementId) throw new Error("no id");
              const ok =
                req.url === "/api/update"
                  ? this.updateElement(data.elementId, data.strokes ?? [], data.info as CanvasElementInfo)
                  : this.removeElement(data.elementId);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok, ...this.getSummary() }));
            } catch {
              res.writeHead(400);
              res.end();
            }
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({ server: http, path: "/ws" });
      // 端口冲突等错误由 http 的 error 处理统一接管，这里避免 wss 崩溃
      this.wss.on("error", () => {
        /* 由 http error 处理 */
      });
      this.wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("close", () => this.clients.delete(ws));
        ws.on("error", () => this.clients.delete(ws));
        // 连接后回放当前已画内容（让新开页面也能看到全部）
        if (this.replayCache.length > 0) {
          ws.send(JSON.stringify({ type: "batch", strokes: this.replayCache }));
        }
      });

      http.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // 端口被占用：检查是否已有画布服务器 → 复用；否则尝试下一个端口
          CanvasServer.isCanvasServerOnPort(port).then((isMine) => {
            resolve(isMine ? "remote" : "skip");
          });
        } else {
          resolve("skip");
        }
      });
      http.listen(port, () => {
        this.http = http;
        resolve("local");
      });
    });
  }

  stop(): void {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    this.wss?.close();
    this.http?.close();
    this.http = null;
    this.wss = null;
  }

  /** 追加元素并推送笔画（工具每次调用） */
  pushStrokes(strokes: StrokeMsg[], elements: CanvasElementInfo[]): void {
    for (const el of elements) {
      if (!el.id) el.id = `el${this.nextElId++}`;
    }
    this.elements.push(...elements);
    for (const s of strokes) {
      this.replayCache.push(s);
      this.strokeCount++;
    }
    if (strokes.length === 1) {
      this.broadcast(JSON.stringify(strokes[0]));
    } else {
      this.broadcast(JSON.stringify({ type: "batch", strokes }));
    }
    this.persist();
  }

  /** 更新元素：删除旧笔画 + 推送新笔画 */
  updateElement(elementId: string, strokes: StrokeMsg[], newInfo: CanvasElementInfo): boolean {
    const idx = this.elements.findIndex((e) => e.id === elementId);
    if (idx === -1) return false;
    const info = { ...newInfo, id: elementId };
    this.elements[idx] = info;
    // 从回放缓存移除旧笔画
    this.replayCache = this.replayCache.filter((s) => s.elementId !== elementId);
    for (const s of strokes) {
      s.elementId = elementId;
      this.replayCache.push(s);
      this.strokeCount++;
    }
    this.broadcast(JSON.stringify({ type: "update", elementId, strokes }));
    this.persist();
    return true;
  }

  /** 删除元素 */
  removeElement(elementId: string): boolean {
    const before = this.elements.length;
    this.elements = this.elements.filter((e) => e.id !== elementId);
    this.replayCache = this.replayCache.filter((s) => s.elementId !== elementId);
    if (this.elements.length === before) return false;
    this.broadcast(JSON.stringify({ type: "remove", elementId }));
    this.persist();
    return true;
  }

  clear(): void {
    this.elements = [];
    this.replayCache = [];
    this.strokeCount = 0;
    this.broadcast(JSON.stringify({ type: "clear" }));
    this.persist();
  }

  private broadcast(msg: string): void {
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  getSummary(): CanvasSummary {
    let bounds: CanvasSummary["bounds"] = null;
    for (const el of this.elements) {
      const x1 = el.x;
      const y1 = el.y;
      const x2 = el.x + el.w;
      const y2 = el.y + el.h;
      if (!bounds) {
        bounds = { minX: x1, minY: y1, maxX: x2, maxY: y2 };
      } else {
        bounds.minX = Math.min(bounds.minX, x1);
        bounds.minY = Math.min(bounds.minY, y1);
        bounds.maxX = Math.max(bounds.maxX, x2);
        bounds.maxY = Math.max(bounds.maxY, y2);
      }
    }
    const freeSpots: CanvasSummary["freeSpots"] = [];
    if (bounds) {
      const pad = 80;
      freeSpots.push({
        x: bounds.minX,
        y: bounds.maxY + pad,
        w: Math.max(bounds.maxX - bounds.minX, 300),
        h: 80,
        hint: "内容下方",
      });
      freeSpots.push({
        x: bounds.maxX + pad,
        y: bounds.minY,
        w: 300,
        h: Math.max(bounds.maxY - bounds.minY, 200),
        hint: "内容右侧",
      });
      freeSpots.push({
        x: bounds.minX,
        y: bounds.maxY + pad * 2.5,
        w: 300,
        h: 80,
        hint: "内容下方偏右",
      });
    } else {
      freeSpots.push({ x: 60, y: 80, w: 400, h: 120, hint: "画布左上角（起点）" });
    }
    return {
      elementCount: this.elements.length,
      bounds,
      occupied: this.elements,
      freeSpots,
    };
  }
}

let instance: CanvasServer | null = null;

export function getCanvasServer(): CanvasServer {
  if (!instance) instance = new CanvasServer();
  return instance;
}
