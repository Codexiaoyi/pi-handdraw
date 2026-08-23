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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { pageStrings, getLang } from "./i18n";
import { buildSvg, type HandDrawElement } from "./draw";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 画板根目录（可用 HANDDRAW_BOARDS_DIR 覆盖） */
export const BOARDS_DIR = process.env.HANDDRAW_BOARDS_DIR ?? join(__dirname, "boards");

/** 画板 images/ 目录允许的图片类型 → MIME */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
/** 旧版单画布状态文件（启动时自动迁移为 default 画板） */
const LEGACY_STATE_FILE = join(__dirname, "canvas-state.json");
const ACTIVE_FILE = join(BOARDS_DIR, ".active-board");
export const DEFAULT_BOARD = "default";

/** Handdraw 固定端口：不再自动切换到其他端口；可用 HANDDRAW_CANVAS_PORT 覆盖。 */
export const CANVAS_PORT = Number(process.env.HANDDRAW_CANVAS_PORT ?? 8788);
export const CANVAS_PORTS = [CANVAS_PORT];

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
  /** 所属对象的说明：作画蚂蚁仅展示这一条元数据，不展示 agent 的聊天文本。 */
  desc?: string;
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
  /** 异步调度时负责该笔画的工蚁 ID */
  workerId?: string;
  /** 异步调度任务 ID；服务端据此绑定当前区域预留 */
  taskId?: string;
  /** 图片元素：非笔画，页面直接渲染 <image>（src 已解析为可访问 URL） */
  image?: { src: string; x: number; y: number; w: number; h: number };
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
  /** 缩略图 URL（动态返回 SVG），无内容时为 null */
  thumbnail: string | null;
  /** 最近编辑时间（ms），用于卡片显示 "x 分钟前" */
  lastEdited: number;
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
  /** 当前异步绘图 worker 的状态，按画板隔离，供页面显示调度进度和区域校验 */
  private workerStates = new Map<string, Array<{
    id: string;
    status: string;
    taskId?: string;
    region?: { x: number; y: number; w: number; h: number };
  }>>();

  private getWorkerStates(board: string): Array<{
    id: string;
    status: string;
    taskId?: string;
    region?: { x: number; y: number; w: number; h: number };
  }> {
    let states = this.workerStates.get(board);
    if (!states) {
      states = Array.from({ length: 4 }, (_, i) => ({ id: `worker-${i + 1}`, status: "idle" }));
      this.workerStates.set(board, states);
    }
    return states;
  }
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
    return [...names].sort().map((name) => {
      const board = this.getBoard(name);
      const elementCount = board.elements.length;
      return {
        name,
        elementCount,
        dir: this.boardDir(name),
        active: name === this.activeBoard,
        // 有内容就给缩略图 URL；空画板=null（前端显示空白占位）
        thumbnail: elementCount > 0 ? `/api/boards/${encodeURIComponent(name)}/thumb` : null,
        lastEdited: this.boardMtime(name),
      };
    });
  }

  /** 画板最近编辑时间：state.json 的 mtime；不存在则目录 mtime；都没有则 0 */
  private boardMtime(name: string): number {
    try {
      return statSync(this.stateFile(name)).mtimeMs;
    } catch {
      try {
        return statSync(this.boardDir(name)).mtimeMs;
      } catch {
        return 0;
      }
    }
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
          if (url.pathname.startsWith("/images/") && req.method === "GET") {
            // 画板 images/ 目录静态服务：/images/<画板>/<文件>
            const parts = url.pathname.slice("/images/".length).split("/").map(decodeURIComponent);
            const fileName = parts.length === 2 ? parts[1] : "";
            const okName = /^[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName) && !fileName.startsWith(".");
            if (parts.length === 2 && isValidBoardName(parts[0]) && okName) {
              try {
                const data = readFileSync(join(this.boardDir(parts[0]), "images", fileName));
                const mime = IMAGE_MIME[fileName.slice(fileName.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
                res.writeHead(200, { "Content-Type": mime });
                res.end(data);
              } catch {
                res.writeHead(404);
                res.end();
              }
            } else {
              res.writeHead(404);
              res.end();
            }
            return;
          }
          if (url.pathname.startsWith("/ant/") && req.method === "GET") {
            // 蚂蚁素材：/ant/<文件>（已做透明处理，从 transparent/ 提供）
            const fileName = decodeURIComponent(url.pathname.slice("/ant/".length));
            const okName = /^[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp|svg)$/i.test(fileName) && !fileName.startsWith(".");
            if (okName) {
              try {
                const data = readFileSync(join(__dirname, "assets", "ant", "transparent", fileName));
                const mime = IMAGE_MIME[fileName.slice(fileName.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
                res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600" });
                res.end(data);
              } catch {
                res.writeHead(404);
                res.end();
              }
            } else {
              res.writeHead(404);
              res.end();
            }
            return;
          }
          if (url.pathname === "/api/boards" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ active: this.activeBoard, boards: this.listBoards() }));
            return;
          }
          if (req.method === "GET" && url.pathname.startsWith("/api/boards/") && url.pathname.endsWith("/thumb")) {
            const raw = decodeURIComponent(url.pathname.slice("/api/boards/".length, -"/thumb".length));
            if (!isValidBoardName(raw)) {
              res.writeHead(400); res.end(); return;
            }
            if (!this.boardExists(raw)) {
              res.writeHead(404); res.end(); return;
            }
            const svg = this.renderThumbnail(raw);
            if (!svg) {
              // 空画板：返回一张空白卡片 SVG（前端不显示 broken image）
              const empty =
                `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">` +
                `<rect width="240" height="160" fill="#f6f7f9"/>` +
                `<text x="120" y="80" font-size="13" fill="#9ca3af" text-anchor="middle" dominant-baseline="middle" font-family="ui-sans-serif,system-ui">空白画板</text>` +
                `</svg>`;
              res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" });
              res.end(empty);
              return;
            }
            res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" });
            res.end(svg);
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
            } catch (error) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
            }
            return;
          }
          if (req.method === "GET" && url.pathname === "/api/workers") {
            const board = this.boardOf(url);
            const workers = this.getWorkerStates(board);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ board, workers }));
            return;
          }
          if (req.method === "POST" && url.pathname === "/api/workers/status") {
            const body = (await this.readBody(req).catch(() => ({}))) as {
              id?: string;
              status?: string;
              taskId?: string;
              board?: string;
              region?: { x: number; y: number; w: number; h: number };
            };
            const board = this.boardOf(url, body);
            const workers = this.getWorkerStates(board);
            const worker = workers.find((w) => w.id === body.id);
            if (worker) {
              worker.status = body.status ?? worker.status;
              worker.taskId = body.taskId;
              worker.region = body.region;
              this.broadcast(board, JSON.stringify({ type: "workers", workers }));
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: Boolean(worker), board, workers }));
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
        // 同步四个异步工蚁的当前状态
        ws.send(JSON.stringify({ type: "workers", workers: this.getWorkerStates(board) }));
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

  private rectContains(
    outer: { x: number; y: number; w: number; h: number },
    inner: { x: number; y: number; w: number; h: number },
    tolerance = 2
  ): boolean {
    return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance &&
      inner.x + inner.w <= outer.x + outer.w + tolerance && inner.y + inner.h <= outer.y + outer.h + tolerance;
  }

  private validateWorkerPush(board: string, strokes: StrokeMsg[], elements: CanvasElementInfo[]): void {
    const workerIds = new Set(strokes.map((s) => s.workerId).filter((id): id is string => Boolean(id)));
    for (const workerId of workerIds) {
      const worker = this.getWorkerStates(board).find((w) => w.id === workerId);
      if (!worker || worker.status !== "drawing" || !worker.taskId || !worker.region) {
        throw new Error(`工蚁 ${workerId} 没有可用的活动任务区域`);
      }
      for (const stroke of strokes) {
        if (stroke.taskId !== worker.taskId) throw new Error(`工蚁 ${workerId} 的任务 ID 不匹配`);
      }
      for (const info of elements) {
        if (!this.rectContains(worker.region, info)) {
          throw new Error(`工蚁 ${workerId} 的元素超出任务区域`);
        }
      }
    }
  }

  /** 追加元素并推送笔画（工具每次调用） */
  pushStrokes(board: string, strokes: StrokeMsg[], elements: CanvasElementInfo[]): void {
    this.validateWorkerPush(board, strokes, elements);
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
    this.validateWorkerPush(board, strokes, [newInfo]);
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

  /** Agent 文本流：只广播给目标画板，驱动蚁后/工蚁气泡（增量 delta 由调用方决定节流粒度）。
   * kind: 'text' 默认蚁后文本；'thinking' 蚁后/工蚁思考增（带 workerId 时表示该工蚁在思考）。
   * workerId: 'worker-1'..'worker-4'，用于前端路由到对应工蚁独立气泡。 */
  broadcastSpeech(payload: {
    board?: string;
    delta?: string;
    full?: string;
    done?: boolean;
    kind?: "text" | "thinking";
    workerId?: string;
  }): void {
    const { board, ...message } = payload;
    const msg = JSON.stringify({ type: "speech", ...message });
    for (const [ws, subscribedBoard] of this.clients) {
      if ((!board || subscribedBoard === board) && ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  private broadcast(board: string, msg: string): void {
    for (const [ws, b] of this.clients) {
      if (b === board && ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  private broadcastAll(msg: string): void {
    for (const [ws] of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
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
      const gap = 40;
      // 行带聚类：y 区间有交叠的元素算同一行（同层级），帮助同级元素对齐排布
      const bands: Array<{ minY: number; maxY: number; minX: number; maxX: number; count: number }> = [];
      for (const el of [...b.elements].sort((a, e2) => a.y - e2.y)) {
        const last = bands[bands.length - 1];
        if (last && el.y <= last.maxY) {
          last.minY = Math.min(last.minY, el.y);
          last.maxY = Math.max(last.maxY, el.y + el.h);
          last.minX = Math.min(last.minX, el.x);
          last.maxX = Math.max(last.maxX, el.x + el.w);
          last.count++;
        } else {
          bands.push({ minY: el.y, maxY: el.y + el.h, minX: el.x, maxX: el.x + el.w, count: 1 });
        }
      }
      const lastBand = bands[bands.length - 1];
      // 同行右侧延伸：与最后一行同级对齐（同级元素接着往右排）
      freeSpots.push({
        x: lastBand.maxX + gap,
        y: lastBand.minY,
        w: 300,
        h: lastBand.maxY - lastBand.minY,
        hint: `最后一行右侧延伸（与该行 ${lastBand.count} 个同级元素对齐，y≈${Math.round(lastBand.minY)}）`,
      });
      // 新行起点：对齐内容最左，换行往下排
      freeSpots.push({
        x: bounds.minX,
        y: bounds.maxY + pad,
        w: Math.max(bounds.maxX - bounds.minX, 300),
        h: 80,
        hint: `新行起点（对齐内容最左 x≈${Math.round(bounds.minX)}）`,
      });
      // 整体右侧
      freeSpots.push({
        x: bounds.maxX + pad,
        y: bounds.minY,
        w: 300,
        h: Math.max(bounds.maxY - bounds.minY, 200),
        hint: "内容右侧（整体新区块）",
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

  // ---- 缩略图：从 replayCache 的 strokes 重画为固定尺寸 SVG ----

  /** 单画板缩略图 SVG（固定 240×160，内容按 bbox 等比缩放进窗口）。空画板返回 null 字符串 */
  renderThumbnail(board: string): string | null {
    const cache = this.getBoard(board).replayCache;
    if (cache.length === 0) return null;
    const W = 240;
    const H = 160;
    const PAD = 8;

    // 只统计"有真实几何位置"的笔画（path / image）参与 bbox；
    // text / hatch 都按其归属元素的几何兜底跳过（缩略图忽略文字细节，避免 10MB 输出）
    const WALKABLE: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const s of cache) {
      if (s.isText) continue;
      if (s.image) {
        WALKABLE.push({ x: s.image.x, y: s.image.y, w: s.image.w, h: s.image.h });
        continue;
      }
      const nums = (s.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      if (nums.length < 2) continue;
      let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
      for (let i = 0; i < nums.length; i += 2) {
        const x = nums[i], y = nums[i + 1] ?? nums[i];
        if (x < mnX) mnX = x;
        if (y < mnY) mnY = y;
        if (x > mxX) mxX = x;
        if (y > mxY) mxY = y;
      }
      if (Number.isFinite(mnX)) WALKABLE.push({ x: mnX, y: mnY, w: mxX - mnX, h: mxY - mnY });
    }
    if (WALKABLE.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of WALKABLE) {
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x + r.w > maxX) maxX = r.x + r.w;
      if (r.y + r.h > maxY) maxY = r.y + r.h;
    }

    // 缩略图笔画密度上限：按 elementId 取样，每元素最多 1-2 条代表笔画
    // 避免几百条 stroke 把 240x160 缩略图撑到几 MB
    const STROKE_LIMIT = 80;
    let strokesToRender = cache;
    if (cache.length > STROKE_LIMIT) {
      const seenIds = new Map<string, number>();
      const sampled: typeof cache = [];
      for (const s of cache) {
        const id = s.elementId ?? "_";
        const seen = seenIds.get(id) ?? 0;
        if (seen >= 2) continue;
        seenIds.set(id, seen + 1);
        sampled.push(s);
        if (sampled.length >= STROKE_LIMIT) break;
      }
      strokesToRender = sampled;
    }
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const availW = W - PAD * 2;
    const availH = H - PAD * 2;
    const scale = Math.min(availW / bw, availH / bh);
    const offsetX = PAD + (availW - bw * scale) / 2 - minX * scale;
    const offsetY = PAD + (availH - bh * scale) / 2 - minY * scale;
    const tx = `translate(${offsetX.toFixed(2)} ${offsetY.toFixed(2)}) scale(${scale.toFixed(4)})`;
    const sw = (s: typeof cache[number]) => Math.max((s.width || 2) / scale, 0.5);

    const parts: string[] = [];
    for (const s of strokesToRender) {
      if (s.isText || s.image) continue;
      // 防御：d 里若含 "<" 说明是 text/html 串，跳过
      if (s.d.includes("<")) continue;
      parts.push(
        `<path d="${s.d}" transform="${tx}" fill="${s.fill ?? "none"}" stroke="${s.fill ? "none" : (s.color || "#37474f")}" stroke-width="${sw(s)}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<rect width="${W}" height="${H}" fill="#fdf6e3"/>` +
      parts.join("") +
      `</svg>`
    );
  }
}

let instance: CanvasServer | null = null;

export function getCanvasServer(): CanvasServer {
  if (!instance) instance = new CanvasServer();
  return instance;
}
