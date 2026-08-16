/**
 * canvas-server.ts — 实时画布服务器（多画板）
 *
 * 本地 HTTP + WebSocket 服务器：
 * - GET /            : 无限画布页面（增量渲染 + 笔尖跟随动画），?board=<名> 指定画板
 * - WS /ws?board=<名>: 推送"新笔画"事件，浏览器实时播放（按画板隔离）
 * - /state、/api/*   : 画板状态与绘制 API（供 remote 模式的其他进程复用）
 * - /api/boards      : 画板管理（list/create/switch/delete）
 *
 * 画板 = boards/<画板名>/ 目录：
 * - state.json  画布状态（元素 + 笔画回放缓存，重启自动恢复）
 * - images/     图片等资源（预留给后续画布引用）
 */
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { pageStrings, getLang } from "./i18n";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 画板根目录（可用 HANDDRAW_BOARDS_DIR 覆盖） */
export const BOARDS_DIR = process.env.HANDDRAW_BOARDS_DIR ?? join(__dirname, "boards");
/** 旧版单画布状态文件（启动时自动迁移为 default 画板） */
const LEGACY_STATE_FILE = join(__dirname, "canvas-state.json");
const ACTIVE_FILE = join(BOARDS_DIR, ".active-board");
export const DEFAULT_BOARD = "default";

/** 候选端口（8787 可能被其他项目占用；可用 HANDDRAW_CANVAS_PORTS=端口1,端口2 覆盖） */
export const CANVAS_PORTS =
  process.env.HANDDRAW_CANVAS_PORTS?.split(",").map(Number).filter((n) => n > 0) ?? [8788, 8789, 8790, 8791];
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
  /** 叠放层次（小的在下面） */
  z?: number;
  /** 额外元数据（文字内容/颜色/字号/贴纸名等，status 展示用） */
  meta?: Record<string, unknown>;
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
  /** 是否是填充斜线（合并为一笔，整体快速生长、笔尖不跟随） */
  hatch?: boolean;
  /** 笔画结束后笔抬起 */
  penUp?: boolean;
  label: string;
  /** 所属元素 ID（修改/删除用） */
  elementId?: string;
  /** 元素叠放层次（页面按 z 分组排序渲染） */
  z?: number;
}

export interface CanvasSummary {
  /** 画板名 */
  board: string;
  /** 画板目录（资源放这里） */
  dir: string;
  elementCount: number;
  /** 已画内容总范围 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** 每个已画元素的位置与元数据（AI 判断空位用） */
  occupied: CanvasElementInfo[];
  /** 推荐空位（内容右侧/下方） */
  freeSpots: Array<{ x: number; y: number; w: number; h: number; hint: string }>;
}

export interface BoardListItem {
  name: string;
  elementCount: number;
  dir: string;
  active: boolean;
}

/** 额外路由处理器（如 web-agent 的聊天 API）：返回 true = 已处理 */
export type CanvasExtraHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL
) => Promise<boolean>;

interface BoardState {
  name: string;
  elements: CanvasElementInfo[];
  replayCache: StrokeMsg[];
  nextElId: number;
  nextZ: number;
}

/** 画板名合法性：目录名安全（不含路径分隔符/..，不做隐藏文件） */
export function isValidBoardName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 60 &&
    !/[/\\]/.test(name) &&
    !name.includes("..") &&
    !/^[\s.]/.test(name) &&
    !/[\s.]$/.test(name)
  );
}

export class CanvasServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  /** 每个连接订阅的画板 */
  private clients = new Map<WebSocket, string>();
  /** agent 是否在工作（思考+作画）：新连接会同步该状态 */
  private agentWorking = false;
  private pageHtml = "";
  private actualPort = 0;
  /** 额外路由（web-agent 模式注册聊天 API 用），在内置路由全部未命中后调用 */
  private extraHandler: CanvasExtraHandler | null = null;

  setExtraHandler(handler: CanvasExtraHandler | null): void {
    this.extraHandler = handler;
  }

  /** 已加载的画板状态（懒加载 + 写回磁盘） */
  private boards = new Map<string, BoardState>();
  private activeBoard = DEFAULT_BOARD;

  // ---- 画板目录与持久化 ----

  boardDir(name: string): string {
    const dir = resolve(BOARDS_DIR, name);
    // 防御：画板目录必须在 BOARDS_DIR 内
    if (!dir.startsWith(resolve(BOARDS_DIR))) return resolve(BOARDS_DIR, DEFAULT_BOARD);
    return dir;
  }

  private stateFile(name: string): string {
    return join(this.boardDir(name), "state.json");
  }

  private persist(name: string): void {
    const b = this.boards.get(name);
    if (!b) return;
    try {
      mkdirSync(this.boardDir(name), { recursive: true });
      writeFileSync(
        this.stateFile(name),
        JSON.stringify({ elements: b.elements, replayCache: b.replayCache, nextElId: b.nextElId, nextZ: b.nextZ })
      );
    } catch {
      /* ignore */
    }
  }

  private persistActive(): void {
    try {
      mkdirSync(BOARDS_DIR, { recursive: true });
      writeFileSync(ACTIVE_FILE, this.activeBoard);
    } catch {
      /* ignore */
    }
  }

  /** 取画板状态（懒加载；不存在则给空状态，首次绘制时才落盘） */
  getBoard(name: string): BoardState {
    let b = this.boards.get(name);
    if (b) return b;
    b = { name, elements: [], replayCache: [], nextElId: 1, nextZ: 1 };
    try {
      const data = JSON.parse(readFileSync(this.stateFile(name), "utf8")) as Partial<BoardState>;
      b.elements = data.elements ?? [];
      b.replayCache = data.replayCache ?? [];
      b.nextElId = data.nextElId ?? 1;
      b.nextZ = data.nextZ ?? b.elements.length + 1;
    } catch {
      /* 新画板 */
    }
    this.boards.set(name, b);
    return b;
  }

  boardExists(name: string): boolean {
    return this.boards.has(name) || existsSync(this.stateFile(name));
  }

  getActiveBoard(): string {
    return this.activeBoard;
  }

  listBoards(): BoardListItem[] {
    const names = new Set<string>(this.boards.keys());
    try {
      for (const e of readdirSync(BOARDS_DIR, { withFileTypes: true })) {
        if (e.isDirectory() && isValidBoardName(e.name)) names.add(e.name);
      }
    } catch {
      /* boards 目录还没建 */
    }
    if (names.size === 0) names.add(DEFAULT_BOARD);
    return [...names].sort().map((name) => ({
      name,
      elementCount: this.getBoard(name).elements.length,
      dir: this.boardDir(name),
      active: name === this.activeBoard,
    }));
  }

  /** 创建画板（目录 + images/ 子目录）；返回 false = 已存在 */
  createBoard(name: string): boolean {
    const existed = this.boardExists(name);
    mkdirSync(join(this.boardDir(name), "images"), { recursive: true });
    if (!existed) {
      this.getBoard(name); // 载入空状态
      this.persist(name);
    }
    this.activeBoard = name;
    this.persistActive();
    return !existed;
  }

  /** 切换当前画板；false = 不存在 */
  switchBoard(name: string): boolean {
    if (!this.boardExists(name)) return false;
    this.activeBoard = name;
    this.persistActive();
    return true;
  }

  /** 删除画板画布数据（state.json + 内存状态；目录内其他资源保留，空目录顺手删） */
  deleteBoard(name: string): boolean {
    if (!this.boardExists(name)) return false;
    this.boards.delete(name);
    try {
      rmSync(this.stateFile(name), { force: true });
      // 目录空了就删掉；有 images/ 等资源则保留
      const dir = this.boardDir(name);
      const left = readdirSync(dir);
      const onlyEmptyImages = left.length === 1 && left[0] === "images" && readdirSync(join(dir, "images")).length === 0;
      if (left.length === 0 || onlyEmptyImages) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (this.activeBoard === name) {
      this.activeBoard = DEFAULT_BOARD;
      this.persistActive();
    }
    // 通知订阅该画板的客户端清屏
    this.broadcast(name, JSON.stringify({ type: "clear" }));
    return true;
  }

  /** 旧版单画布状态迁移为 default 画板 */
  private migrateLegacyState(): void {
    try {
      if (existsSync(LEGACY_STATE_FILE) && !existsSync(this.stateFile(DEFAULT_BOARD))) {
        mkdirSync(this.boardDir(DEFAULT_BOARD), { recursive: true });
        renameSync(LEGACY_STATE_FILE, this.stateFile(DEFAULT_BOARD));
      }
    } catch {
      /* ignore */
    }
  }

  private loadActive(): void {
    try {
      const name = readFileSync(ACTIVE_FILE, "utf8").trim();
      if (name && isValidBoardName(name) && this.boardExists(name)) this.activeBoard = name;
    } catch {
      /* ignore */
    }
  }

  // ---- 服务器生命周期 ----

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
   * - 端口被占用且是画布服务器 → 复用（remote，由 core.ts 走 HTTP 推送）
   * - 端口被占用但不是画布服务器 → 尝试下一个端口
   */
  async start(): Promise<"local" | "remote"> {
    if (this.http) return "local";
    // 加载画布页面（直接读取，i18n 已硬编码在 HTML 里）
    try {
      this.pageHtml = readFileSync(join(__dirname, "canvas-page.html"), "utf8");
    } catch {
      this.pageHtml = "<html><body>canvas page missing</body></html>";
    }
    this.migrateLegacyState();
    this.loadActive();
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

  /** 从 query/body 里取画板名（默认当前画板） */
  private boardOf(url: URL, body?: { board?: string }): string {
    const name = body?.board ?? url.searchParams.get("board") ?? undefined;
    return name && isValidBoardName(name) ? name : this.activeBoard;
  }

  private readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
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

  private tryListen(port: number): Promise<"local" | "remote" | "skip"> {
    return new Promise((resolveListen) => {
      const http = createServer((req, res) => {
        void (async () => {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (url.pathname === "/" || url.pathname === "/index.html") {
            // 每次请求重新读页面文件：改 canvas-page.html 后只需刷新浏览器，不必重启服务器
            try {
              this.pageHtml = readFileSync(join(__dirname, "canvas-page.html"), "utf8");
            } catch {
              /* 读失败用启动时缓存 */
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(this.pageHtml);
            return;
          }
          if (url.pathname === "/state") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(this.getSummary(this.boardOf(url))));
            return;
          }
          if (url.pathname === "/api/strokes") {
            // 全量笔画：页面静默整体重绘用（agent 任务结束后清前端残留）
            const b = this.getBoard(this.boardOf(url));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ strokes: b.replayCache }));
            return;
          }
          if (url.pathname === "/api/boards" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ active: this.activeBoard, boards: this.listBoards() }));
            return;
          }
          if (url.pathname === "/api/boards" && req.method === "POST") {
            try {
              const body = (await this.readBody(req)) as { action?: string; name?: string };
              const name = body.name ?? "";
              if (!isValidBoardName(name)) throw new Error("bad name");
              let out: Record<string, unknown>;
              switch (body.action) {
                case "create":
                  out = { ok: true, created: this.createBoard(name) };
                  break;
                case "switch":
                  out = { ok: this.switchBoard(name) };
                  break;
                case "delete":
                  out = { ok: this.deleteBoard(name) };
                  break;
                default:
                  throw new Error("bad action");
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ...out, active: this.activeBoard, boards: this.listBoards() }));
            } catch {
              res.writeHead(400);
              res.end();
            }
            return;
          }
          if (req.method === "POST" && url.pathname === "/api/push") {
            // 远程推送（其他进程复用本服务器）
            try {
              const body = (await this.readBody(req)) as { board?: string; strokes: StrokeMsg[]; elements: CanvasElementInfo[] };
              const board = this.boardOf(url, body);
              this.pushStrokes(board, body.strokes ?? [], body.elements ?? []);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(this.getSummary(board)));
            } catch {
              res.writeHead(400);
              res.end();
            }
            return;
          }
          if (req.method === "POST" && url.pathname === "/api/agent-status") {
            // 远程进程上报 agent 工作状态（呼吸灯），广播到所有画板
            const body = (await this.readBody(req).catch(() => ({}))) as { working?: boolean };
            this.setAgentWorking(Boolean(body.working));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === "POST" && url.pathname === "/api/clear") {
            const body = await this.readBody(req).catch(() => ({}));
            const board = this.boardOf(url, body);
            this.clear(board);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, ...this.getSummary(board) }));
            return;
          }
          if (req.method === "POST" && (url.pathname === "/api/update" || url.pathname === "/api/remove")) {
            try {
              const body = (await this.readBody(req)) as {
                board?: string;
                elementId: string;
                strokes?: StrokeMsg[];
                info?: CanvasElementInfo;
              };
              if (!body.elementId) throw new Error("no id");
              const board = this.boardOf(url, body);
              const ok =
                url.pathname === "/api/update"
                  ? this.updateElement(board, body.elementId, body.strokes ?? [], body.info as CanvasElementInfo)
                  : this.removeElement(board, body.elementId);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok, ...this.getSummary(board) }));
            } catch {
              res.writeHead(400);
              res.end();
            }
            return;
          }
          if (this.extraHandler) {
            try {
              if (await this.extraHandler(req, res, url)) return;
            } catch {
              res.writeHead(500);
              res.end();
              return;
            }
          }
          res.writeHead(404);
          res.end();
        })();
      });

      this.wss = new WebSocketServer({ server: http, path: "/ws" });
      // 端口冲突等错误由 http 的 error 处理统一接管，这里避免 wss 崩溃
      this.wss.on("error", () => {
        /* 由 http error 处理 */
      });
      this.wss.on("connection", (ws, req) => {
        const url = new URL(req.url ?? "/ws", "http://localhost");
        const board = this.boardOf(url);
        this.clients.set(ws, board);
        ws.on("close", () => this.clients.delete(ws));
        ws.on("error", () => this.clients.delete(ws));
        // 连接后回放该画板已画内容（让新开页面也能看到全部）
        const cache = this.getBoard(board).replayCache;
        if (cache.length > 0) {
          ws.send(JSON.stringify({ type: "batch", strokes: cache }));
        }
        // 同步当前 agent 工作状态（呼吸灯）
        ws.send(JSON.stringify({ type: "agent", working: this.agentWorking }));
      });

      http.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // 端口被占用：检查是否已有画布服务器 → 复用；否则尝试下一个端口
          CanvasServer.isCanvasServerOnPort(port).then((isMine) => {
            resolveListen(isMine ? "remote" : "skip");
          });
        } else {
          resolveListen("skip");
        }
      });
      http.listen(port, () => {
        this.http = http;
        resolveListen("local");
      });
    });
  }

  stop(): void {
    for (const ws of this.clients.keys()) ws.close();
    this.clients.clear();
    this.wss?.close();
    this.http?.close();
    this.http = null;
    this.wss = null;
  }

  // ---- 绘制操作（全部按画板隔离） ----

  /** 追加元素并推送笔画（工具每次调用） */
  pushStrokes(board: string, strokes: StrokeMsg[], elements: CanvasElementInfo[]): void {
    const b = this.getBoard(board);
    const zOf = new Map<string, number>();
    for (const el of elements) {
      if (!el.id) el.id = `el${b.nextElId++}`;
      if (el.z == null) el.z = b.nextZ++;
      zOf.set(el.id, el.z);
    }
    b.elements.push(...elements);
    for (const s of strokes) {
      if (s.z == null && s.elementId) s.z = zOf.get(s.elementId);
      b.replayCache.push(s);
    }
    const msg = strokes.length === 1 ? JSON.stringify(strokes[0]) : JSON.stringify({ type: "batch", strokes });
    this.broadcast(board, msg);
    this.persist(board);
  }

  /** 更新元素：删除旧笔画 + 推送新笔画（z 默认沿用原值） */
  updateElement(board: string, elementId: string, strokes: StrokeMsg[], newInfo: CanvasElementInfo): boolean {
    const b = this.getBoard(board);
    const idx = b.elements.findIndex((e) => e.id === elementId);
    if (idx === -1) return false;
    const info = { ...newInfo, id: elementId };
    if (info.z == null) info.z = b.elements[idx].z ?? b.nextZ++;
    b.elements[idx] = info;
    // 从回放缓存移除旧笔画
    b.replayCache = b.replayCache.filter((s) => s.elementId !== elementId);
    for (const s of strokes) {
      s.elementId = elementId;
      if (s.z == null) s.z = info.z;
      b.replayCache.push(s);
    }
    this.broadcast(board, JSON.stringify({ type: "update", elementId, z: info.z, strokes }));
    this.persist(board);
    return true;
  }

  /** 删除元素 */
  removeElement(board: string, elementId: string): boolean {
    const b = this.getBoard(board);
    const before = b.elements.length;
    b.elements = b.elements.filter((e) => e.id !== elementId);
    b.replayCache = b.replayCache.filter((s) => s.elementId !== elementId);
    if (b.elements.length === before) return false;
    this.broadcast(board, JSON.stringify({ type: "remove", elementId }));
    this.persist(board);
    return true;
  }

  clear(board: string): void {
    const b = this.getBoard(board);
    b.elements = [];
    b.replayCache = [];
    b.nextZ = 1;
    this.broadcast(board, JSON.stringify({ type: "clear" }));
    this.persist(board);
  }

  /** Agent 工作状态（思考+作画中）：广播给所有画板页面，驱动页面呼吸灯 */
  setAgentWorking(working: boolean): void {
    if (this.agentWorking === working) return;
    this.agentWorking = working;
    const msg = JSON.stringify({ type: "agent", working });
    for (const [ws] of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  private broadcast(board: string, msg: string): void {
    for (const [ws, b] of this.clients) {
      if (b === board && ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  getSummary(board: string): CanvasSummary {
    const b = this.getBoard(board);
    let bounds: CanvasSummary["bounds"] = null;
    for (const el of b.elements) {
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
      board,
      dir: this.boardDir(board),
      elementCount: b.elements.length,
      bounds,
      occupied: b.elements,
      freeSpots,
    };
  }
}

let instance: CanvasServer | null = null;

export function getCanvasServer(): CanvasServer {
  if (!instance) instance = new CanvasServer();
  return instance;
}
