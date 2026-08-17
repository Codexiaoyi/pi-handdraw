/**
 * core.ts — handdraw_canvas / handdraw_board 工具的 agent 无关核心
 *
 * 包含：
 * - 工具参数 JSON Schema（pi 扩展和 MCP server 共用同一份定义）
 * - 工具描述/指导语（i18n，见 i18n.ts）
 * - 画布服务器生命周期 + 推送/查询/修改/画板管理逻辑
 * - executeCanvasAction / executeBoardAction：工具主逻辑，返回纯文本 + 结构化 details
 *
 * pi 扩展（index.ts）和 MCP server（mcp-server.ts）都只是这一层的薄壳。
 */
import { exec } from "node:child_process";
import { svgPathProperties } from "svg-path-properties";
import {
  buildStrokeSequence,
  layoutParagraph,
  measureText,
  type BuildOptions,
  type HandDrawElement,
  type ImageElement,
} from "./draw";
import {
  getCanvasServer,
  isValidBoardName,
  type BoardListItem,
  type StrokeMsg,
  type CanvasElementInfo,
} from "./canvas-server";
import { STICKERS, stickerList } from "./stickers";
import { t, tArr, getLang, type Lang } from "./i18n";

// ---------------------------------------------------------------------------
// 参数 JSON Schema（pi 的 typebox 和 MCP 的 inputSchema 都兼容纯 JSON Schema）
// ---------------------------------------------------------------------------

const zProp = { type: "number", description: "叠放层次：小的在下面；不设则后画的在上" };
const descProp = {
  type: "string",
  description:
    "该对象的详细说明（1~2 句）：架构图写节点职责/关键交互；手帐/旅行规划写描述或小 tips。双击浮窗展示，必填",
};

const boxLike = (literal: "box" | "ellipse" | "diamond") => ({
  type: "object",
  properties: {
    type: { const: literal },
    x: { type: "number", description: "左上角 x（画布绝对坐标）" },
    y: { type: "number", description: "左上角 y（画布绝对坐标）" },
    w: { type: "number", description: "宽度，默认 160" },
    h: { type: "number", description: "高度，默认 70" },
    text: { type: "string", description: "形状内文字，默认居中" },
    textPosition: {
      anyOf: [{ const: "center" }, { const: "top" }],
      description:
        "文字位置：center=居中（默认，叶子节点用）；top=框内顶部（容器/模块框的标题用，此时框内其他内容从 y+50 以下开始排，不要覆盖标题）",
    },
    color: { type: "string", description: "描边颜色，如 #c0392b" },
    fill: { type: "string", description: "填充颜色，如 #fdebd0" },
    fillStyle: {
      type: "string",
      description: "填充风格：hachure(手绘斜线)/solid/zigzag/cross-hatch，默认 hachure",
    },
    textSize: { type: "number", description: "文字大小，默认 16" },
    desc: descProp,
    z: zProp,
  },
  required: ["type", "x", "y"],
});

export const ELEMENT_SCHEMA = {
  anyOf: [
    boxLike("box"),
    boxLike("ellipse"),
    boxLike("diamond"),
    {
      type: "object",
      properties: {
        type: { const: "line" },
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        color: { type: "string" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "x1", "y1", "x2", "y2"],
    },
    {
      type: "object",
      properties: {
        type: { const: "arrow" },
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        text: { type: "string", description: "箭头上的说明文字" },
        color: { type: "string" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "x1", "y1", "x2", "y2"],
    },
    {
      type: "object",
      properties: {
        type: { const: "text" },
        x: { type: "number", description: "单行：文字中心 x；多行（含 \\n 或设了 w）：段落左上角 x" },
        y: { type: "number", description: "单行：文字中心 y；多行：段落左上角 y" },
        text: { type: "string", description: "文字内容，\\n 分行" },
        size: { type: "number", description: "字号，默认 16" },
        color: { type: "string" },
        w: { type: "number", description: "段落宽度：设置后开启自动换行（多行模式）" },
        lineHeight: { type: "number", description: "行距（字号倍数，默认 1.6，仅多行）" },
        align: { anyOf: [{ const: "left" }, { const: "center" }, { const: "right" }], description: "对齐（仅多行，默认 left）" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "x", "y", "text"],
    },
    {
      type: "object",
      properties: {
        type: { const: "sticker" },
        name: { type: "string", description: "贴纸名（从 status 返回的 stickers 列表里选，不要编造）" },
        x: { type: "number", description: "左上角 x" },
        y: { type: "number", description: "左上角 y" },
        size: { type: "number", description: "边长，默认 80" },
        color: { type: "string", description: "整体覆盖描边色（不设用贴纸自带配色）" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "name", "x", "y"],
    },
    {
      type: "object",
      properties: {
        type: { const: "image" },
        src: {
          type: "string",
          description:
            "图片来源：http(s):// URL、data:image/...;base64,...、或画板 images/ 目录下的文件名（如 photo.png，文件需已存在）",
        },
        x: { type: "number", description: "左上角 x" },
        y: { type: "number", description: "左上角 y" },
        w: { type: "number", description: "显示宽度" },
        h: { type: "number", description: "显示高度" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "src", "x", "y", "w", "h"],
    },
    {
      type: "object",
      properties: {
        type: { const: "path" },
        d: { type: "string", description: "SVG path 数据" },
        color: { type: "string" },
        fill: { type: "string" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "d"],
    },
  ],
};

export const PARAMS_SCHEMA = {
  type: "object",
  properties: {
    action: {
      anyOf: [{ const: "draw" }, { const: "update" }, { const: "remove" }, { const: "status" }, { const: "clear" }],
      description:
        "draw=画新元素（默认）；update=修改已有元素（用 elementId）；remove=删除元素；status=只查询画布状态；clear=清空整个画布（仅用户明确要求时用）",
    },
    board: { type: "string", description: "目标画板名（默认当前画板；画板管理用 handdraw_board 工具）" },
    elementId: { type: "string", description: "要修改/删除的元素 ID（从上次返回的摘要或 occupied 列表获取）" },
    elements: { type: "array", items: ELEMENT_SCHEMA, description: "本次要画的元素（draw 用）或新元素（update 用）" },
    allowOverlap: {
      type: "boolean",
      description:
        "是否允许覆盖已有内容（默认 false：新元素与已占用区域部分重叠会被直接拒绝；完全包含关系如容器装子元素/底色块垫文字不受限。仅当确实需要有意的叠加效果时设 true）",
    },
  },
  required: ["elements"],
};

export const BOARD_PARAMS_SCHEMA = {
  type: "object",
  properties: {
    action: {
      anyOf: [{ const: "list" }, { const: "create" }, { const: "switch" }, { const: "delete" }],
      description: "list=列出所有画板；create=新建画板（并设为当前）；switch=切换当前画板；delete=删除画板画布数据",
    },
    name: { type: "string", description: "画板名（create/switch/delete 必填）；会建成 boards/<画板名>/ 目录" },
  },
  required: ["action"],
};

// ---------------------------------------------------------------------------
// 工具文案（i18n）
// ---------------------------------------------------------------------------

export function toolDescription(lang: Lang = getLang()): string {
  return t("tool.desc", undefined, lang);
}
export function toolGuidelines(lang: Lang = getLang()): string[] {
  return tArr("tool.guidelines", lang);
}
/** MCP 用：描述 + 指导语合并（MCP 没有 promptGuidelines，全部放进 description） */
export function toolDescriptionFull(lang: Lang = getLang()): string {
  return t("tool.desc", undefined, lang) + "\n\n" + toolGuidelines(lang).map((g) => `- ${g}`).join("\n");
}
export function boardToolDescription(lang: Lang = getLang()): string {
  return t("board.desc", undefined, lang);
}
export function boardToolDescriptionFull(lang: Lang = getLang()): string {
  return t("board.desc", undefined, lang) + "\n\n" + tArr("board.guidelines", lang).map((g) => `- ${g}`).join("\n");
}
export function boardToolGuidelines(lang: Lang = getLang()): string[] {
  return tArr("board.guidelines", lang);
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface CanvasActionParams {
  action?: "draw" | "update" | "remove" | "status" | "clear";
  board?: string;
  elementId?: string;
  elements?: Array<{ type: string } & Record<string, unknown>>;
  /** 允许覆盖已有内容（默认禁止：部分重叠会被拒绝） */
  allowOverlap?: boolean;
}

export interface BoardActionParams {
  action: "list" | "create" | "switch" | "delete";
  name?: string;
}

export interface ToolResult {
  text: string;
  details: Record<string, unknown>;
}

export interface ExecuteOptions {
  /** 首次启动画布服务器时是否自动打开浏览器页面 */
  openBrowser?: boolean;
}

// ---------------------------------------------------------------------------
// 工具辅助
// ---------------------------------------------------------------------------

function toElement(raw: { type: string } & Record<string, unknown>): HandDrawElement {
  return raw as unknown as HandDrawElement;
}

/** 图片 src → 页面可访问 URL；画板 images/ 目录下的文件名映射到静态路由。不合法返回 null */
function resolveImageSrc(src: string, board: string): string | null {
  if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) return src;
  if (/^[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(src) && !src.startsWith(".")) {
    return `/images/${encodeURIComponent(board)}/${encodeURIComponent(src)}`;
  }
  return null;
}

/** 图片元素不是笔画：构造一条带 image 字段的消息，页面直接渲染 <image> */
function imageStrokeMsg(el: ImageElement, board: string, elementId: string, z?: number): StrokeMsg {
  return {
    type: "stroke",
    d: "",
    color: "",
    width: 0,
    dur: 0,
    penUp: true,
    label: el.desc ?? el.src.split("/").pop() ?? "image",
    elementId,
    z,
    image: { src: resolveImageSrc(el.src, board)!, x: el.x, y: el.y, w: el.w, h: el.h },
  };
}

// ---- 覆盖保护：禁止新元素部分覆盖已有内容 ----

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 向内缩 inset 像素：容忍贴边连接（箭头连到框边缘）等轻微接触 */
function shrinkRect(r: Rect, inset: number): Rect {
  const w = Math.max(r.w - inset * 2, 1);
  const h = Math.max(r.h - inset * 2, 1);
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

function rectHit(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}

/** 部分重叠=覆盖（拦截）；完全包含（容器装子元素/底色块垫文字）放行 */
export function isCovering(a: Rect, b: Rect, inset = 6): boolean {
  if (!rectHit(shrinkRect(a, inset), shrinkRect(b, inset))) return false;
  if (rectContains(a, b) || rectContains(b, a)) return false;
  return true;
}

interface OverlapItem extends Rect {
  tag: string;
}

/** 新元素 vs 已有元素 + 同批元素之间的覆盖冲突清单 */
function findOverlapHits(incoming: OverlapItem[], existing: OverlapItem[]): string[] {
  const hits: string[] = [];
  const placed: OverlapItem[] = [];
  for (const inc of incoming) {
    for (const ex of existing) {
      if (isCovering(inc, ex)) hits.push(`${inc.tag} 盖上 ${ex.tag}`);
    }
    for (const p of placed) {
      if (isCovering(inc, p)) hits.push(`${inc.tag} 与同批的 ${p.tag} 重叠`);
    }
    placed.push(inc);
  }
  return [...new Set(hits)];
}

function unionRects(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** 从笔画路径采样真实渲染 bbox（含描边宽度与手绘抖动余量）；无路径笔画（纯文字）返回 null */
function strokesBBox(msgs: StrokeMsg[]): Rect | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let pad = 0;
  let found = false;
  for (const s of msgs) {
    if (s.image) {
      minX = Math.min(minX, s.image.x);
      minY = Math.min(minY, s.image.y);
      maxX = Math.max(maxX, s.image.x + s.image.w);
      maxY = Math.max(maxY, s.image.y + s.image.h);
      found = true;
      continue;
    }
    if (s.isText || !s.d) continue; // 文字笔画是 SVG 片段，边界用排版估算
    try {
      const props = new svgPathProperties(s.d);
      const len = props.getTotalLength();
      if (!(len > 0)) continue;
      const n = Math.min(48, Math.max(8, Math.ceil(len / 20)));
      for (let i = 0; i <= n; i++) {
        const p = props.getPointAtLength((len * i) / n);
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      pad = Math.max(pad, (s.width || 2) / 2 + 3);
      found = true;
    } catch {
      /* 跳过无法解析的笔画 */
    }
  }
  if (!found) return null;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/** path 元素 bbox（采样估算） */
function pathBBox(d: string): { x: number; y: number; w: number; h: number } {
  try {
    const props = new svgPathProperties(d);
    const len = props.getTotalLength();
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i <= 24; i++) {
      const p = props.getPointAtLength((len * i) / 24);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    if (minX > maxX) throw new Error("empty");
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  } catch {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
}

function compactMeta(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 元素 → 位置与元数据摘要（AI 判断空位、status 展示用） */
function toElementInfo(el: HandDrawElement): CanvasElementInfo {
  const z = el.z;
  // 取出 agent 写入时填的说明（任意元素都可带 desc，没有时 fallback 到 text）
  const anyEl = el as { desc?: string };
  const desc = anyEl.desc ?? ("text" in el && el.text) ?? ("name" in el && el.name) ?? undefined;
  if (el.type === "box" || el.type === "ellipse" || el.type === "diamond") {
    return {
      type: el.type,
      label: desc,
      x: el.x ?? 0,
      y: el.y ?? 0,
      w: el.w ?? 160,
      h: el.h ?? 70,
      z,
      meta: compactMeta({ desc, text: el.text, color: el.color, fill: el.fill, textSize: el.textSize, textPosition: el.textPosition }),
    } as CanvasElementInfo;
  }
  if (el.type === "line" || el.type === "arrow") {
    return {
      type: el.type,
      label: desc,
      x: Math.min(el.x1, el.x2),
      y: Math.min(el.y1, el.y2),
      w: Math.abs(el.x2 - el.x1),
      h: Math.abs(el.y2 - el.y1),
      z,
      meta: compactMeta({ desc, text: el.text, color: el.color, from: [el.x1, el.y1], to: [el.x2, el.y2] }),
    } as CanvasElementInfo;
  }
  if (el.type === "text") {
    const size = el.size ?? 16;
    if (el.text.includes("\n") || el.w) {
      const layout = layoutParagraph(el.text, size, el.w, el.lineHeight ?? 1.6);
      return {
        type: "text",
        label: desc,
        x: el.x,
        y: el.y,
        w: el.w ?? layout.width,
        h: layout.height,
        z,
        meta: compactMeta({ desc, text: el.text, size, color: el.color, align: el.align, lineHeight: el.lineHeight, lines: layout.lines.length }),
      };
    }
    const w = measureText(el.text, size);
    const h = size * 1.35;
    return {
      type: "text",
      label: desc,
      x: el.x - w / 2,
      y: el.y - h / 2,
      w,
      h,
      z,
      meta: compactMeta({ desc, text: el.text, size, color: el.color }),
    };
  }
  if (el.type === "sticker") {
    const size = el.size ?? 80;
    return {
      type: "sticker",
      label: el.name,
      x: el.x,
      y: el.y,
      w: size,
      h: size,
      z,
      meta: compactMeta({ desc, name: el.name, size, color: el.color }),
    };
  }
  if (el.type === "image") {
    return {
      type: "image",
      label: desc ?? el.src.split("/").pop(),
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      z,
      meta: compactMeta({ desc, src: el.src }),
    };
  }
  // path
  const bb = pathBBox(el.d);
  return { type: "path", label: desc, x: bb.x, y: bb.y, w: bb.w, h: bb.h, z, meta: compactMeta({ desc, color: el.color, fill: el.fill }) };
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

// ---------------------------------------------------------------------------
// 画布服务器生命周期（local = 本进程监听；remote = 复用已有进程，走 HTTP）
// ---------------------------------------------------------------------------

let canvasServerMode: "local" | "remote" | null = null;

/** 最近一次 agent 工作状态：服务器未启动时先挂起，启动成功后补发 */
let pendingAgentWorking = false;

/**
 * 上报 agent 工作状态（思考+作画中），驱动画布页面呼吸灯。
 * 服务器未启动时仅记录状态；失败静默，不影响主流程。
 */
export async function setAgentWorking(working: boolean): Promise<void> {
  pendingAgentWorking = working;
  const server = getCanvasServer();
  if (!server.isRunning()) return;
  try {
    if (canvasServerMode === "remote") {
      await fetch(`http://localhost:${server.getPort()}/api/agent-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ working }),
      });
    } else {
      server.setAgentWorking(working);
    }
  } catch {
    /* 呼吸灯失败不影响主流程 */
  }
}

async function ensureCanvasServer(openBrowser: boolean): Promise<string | null> {
  const server = getCanvasServer();
  try {
    if (!server.isRunning()) {
      try {
        canvasServerMode = await server.start();
      } catch (err) {
        canvasServerMode = null;
        throw err;
      }
      if (openBrowser && canvasServerMode === "local") {
        openInBrowser(`http://localhost:${server.getPort()}`);
      }
    } else {
      canvasServerMode = "local";
    }
    // 补发挂起的 agent 工作状态（agent 可能在首次动笔前就开始思考）
    if (pendingAgentWorking) void setAgentWorking(true);
    return `http://localhost:${server.getPort()}`;
  } catch {
    canvasServerMode = null;
    return null;
  }
}

/** 推送笔画：本地直推或远程 HTTP */
async function pushToCanvas(board: string, msgs: StrokeMsg[], infos: CanvasElementInfo[]): Promise<void> {
  const server = getCanvasServer();
  if (canvasServerMode === "remote") {
    await fetch(`http://localhost:${server.getPort()}/api/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board, strokes: msgs, elements: infos }),
    });
  } else {
    server.pushStrokes(board, msgs, infos);
  }
}

async function canvasSummary(board: string): Promise<Record<string, unknown>> {
  const server = getCanvasServer();
  if (canvasServerMode === "remote") {
    try {
      const res = await fetch(`http://localhost:${server.getPort()}/state?board=${encodeURIComponent(board)}`);
      return (await res.json()) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return server.getSummary(board) as unknown as Record<string, unknown>;
}

/** 修改元素（update/remove）：本地直调或远程 HTTP */
async function modifyCanvas(
  board: string,
  action: "update" | "remove",
  elementId: string,
  strokes?: StrokeMsg[],
  info?: CanvasElementInfo
): Promise<boolean> {
  const server = getCanvasServer();
  if (canvasServerMode === "remote") {
    try {
      const res = await fetch(`http://localhost:${server.getPort()}/api/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board, elementId, strokes, info }),
      });
      const data = (await res.json()) as { ok?: boolean };
      return data.ok !== false;
    } catch {
      return false;
    }
  }
  return action === "update"
    ? server.updateElement(board, elementId, strokes ?? [], info!)
    : server.removeElement(board, elementId);
}

/** 画板列表：本地直调或远程 HTTP */
async function boardsList(): Promise<{ active: string; boards: BoardListItem[] }> {
  const server = getCanvasServer();
  if (canvasServerMode === "remote") {
    try {
      const res = await fetch(`http://localhost:${server.getPort()}/api/boards`);
      return (await res.json()) as { active: string; boards: BoardListItem[] };
    } catch {
      return { active: "default", boards: [] };
    }
  }
  return { active: server.getActiveBoard(), boards: server.listBoards() };
}

/** 画板操作（create/switch/delete）：本地直调或远程 HTTP */
async function boardOp(action: "create" | "switch" | "delete", name: string): Promise<{ ok: boolean; created?: boolean }> {
  const server = getCanvasServer();
  if (canvasServerMode === "remote") {
    try {
      const res = await fetch(`http://localhost:${server.getPort()}/api/boards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name }),
      });
      const data = (await res.json()) as { ok?: boolean; created?: boolean };
      return { ok: data.ok !== false, created: data.created };
    } catch {
      return { ok: false };
    }
  }
  switch (action) {
    case "create":
      return { ok: true, created: server.createBoard(name) };
    case "switch":
      return { ok: server.switchBoard(name) };
    case "delete":
      return { ok: server.deleteBoard(name) };
  }
}

/** 进程退出时停止本进程监听的画布服务器（remote 模式不动） */
export function shutdownCanvasServer(): void {
  if (canvasServerMode === "local") {
    getCanvasServer().stop();
  }
  canvasServerMode = null;
}

// ---------------------------------------------------------------------------
// handdraw_canvas 主逻辑
// ---------------------------------------------------------------------------

interface Summary {
  board: string;
  dir: string;
  elementCount: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  occupied: Array<{ id: string; type: string; label?: string; x: number; y: number; w: number; h: number; z?: number }>;
  freeSpots: Array<{ x: number; y: number; w: number; h: number; hint: string }>;
}

function formatFreeSpots(summary: Summary): string {
  return (summary.freeSpots ?? []).map((f) => `${f.hint} @(${Math.round(f.x)},${Math.round(f.y)})`).join("; ");
}

function formatOccupied(summary: Summary): string {
  return (summary.occupied ?? [])
    .map((e) => `${e.label ?? e.type}[${e.id}]@(${Math.round(e.x)},${Math.round(e.y)})${e.z != null ? ` z=${e.z}` : ""}`)
    .join("; ");
}

function formatBounds(summary: Summary): string {
  const b = summary.bounds;
  if (!b) return "";
  return t("tool.bounds", {
    minX: Math.round(b.minX),
    maxX: Math.round(b.maxX),
    minY: Math.round(b.minY),
    maxY: Math.round(b.maxY),
  });
}

export async function executeCanvasAction(
  params: CanvasActionParams,
  opts: ExecuteOptions = {}
): Promise<ToolResult> {
  const action = params.action ?? "draw";
  const url = await ensureCanvasServer(opts.openBrowser ?? true);
  if (!url) {
    return { text: t("tool.serverFail"), details: { ok: false } };
  }
  const server = getCanvasServer();
  const board = params.board && isValidBoardName(params.board) ? params.board : server.getActiveBoard();

  if (action === "clear") {
    if (canvasServerMode === "remote") {
      await fetch(`http://localhost:${server.getPort()}/api/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board }),
      });
    } else {
      server.clear(board);
    }
    return { text: t("tool.cleared"), details: { ok: true, board, elementCount: 0 } };
  }

  if (action === "status" || (action === "draw" && (params.elements ?? []).length === 0)) {
    const summary = (await canvasSummary(board)) as unknown as Summary;
    const lang = getLang();
    const stickers = stickerList(lang);
    const boards = await boardsList();
    return {
      text: t("tool.status", {
        board: summary.board ?? board,
        dir: summary.dir ?? "",
        count: summary.elementCount,
        occupied: formatOccupied(summary),
        spots: formatFreeSpots(summary),
        stickers: stickers.map((s) => `${s.name}(${s.label})`).join(", "),
      }),
      details: {
        ...summary,
        stickers,
        boards: boards.boards.map((b) => b.name),
        activeBoard: boards.active,
      } as unknown as Record<string, unknown>,
    };
  }

  const elements = (params.elements ?? []).map(toElement);

  // 贴纸名校验：未知贴纸跳过并提示
  const warnings: string[] = [];
  const validElements = elements.filter((el) => {
    if (el.type === "sticker" && !STICKERS[el.name]) {
      warnings.push(t("tool.stickerUnknown", { name: el.name }));
      return false;
    }
    if (el.type === "image" && !resolveImageSrc(el.src, board)) {
      warnings.push(t("tool.imageBadSrc", { src: String(el.src).slice(0, 60) }));
      return false;
    }
    return true;
  });

  // 每个元素独立生成笔画并标记 elementId（可单独修改/删除）
  const buildOpts = (el: HandDrawElement): BuildOptions => ({
    layout: "manual",
    background: "#fdf6e3",
    title: undefined,
    elements: [el],
  });

  if (action === "update") {
    if (!params.elementId || validElements.length === 0) {
      return { text: t("tool.updateNeedId"), details: {} };
    }
    const el = validElements[0];
    let info = toElementInfo(el);
    let msgs: StrokeMsg[];
    if (el.type === "image") {
      msgs = [imageStrokeMsg(el, board, params.elementId, info.z)];
    } else {
      const { strokes } = buildStrokeSequence(buildOpts(el), "fast");
      msgs = strokes.map((s) => ({
        type: "stroke",
        d: s.d,
        color: s.color,
        width: s.width,
        dur: Math.round(s.dur * 1000),
        fill: s.fillOnly,
        isText: s.isText,
        hatch: s.hatch,
        penUp: false,
        label: s.label,
        elementId: params.elementId,
      }));
      // 真实边界回写：笔画采样 bbox ∪ 声明估算
      const real = strokesBBox(msgs);
      if (real) info = { ...info, ...unionRects(real, info) };
    }
    // 覆盖保护（排除被更新的元素自身）
    if (!params.allowOverlap) {
      const preSummary = (await canvasSummary(board)) as unknown as Summary;
      const existing: OverlapItem[] = (preSummary.occupied ?? [])
        .filter((o) => o.id !== params.elementId)
        .map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h, tag: `${o.label ?? o.type}[${o.id}]` }));
      const hits = findOverlapHits(
        [{ x: info.x, y: info.y, w: info.w, h: info.h, tag: `${info.label ?? info.type}(更新)` }],
        existing
      );
      if (hits.length > 0) {
        return {
          text: t("tool.overlap", { hits: hits.join("；"), spots: formatFreeSpots(preSummary) }),
          details: { ok: false, collisions: hits },
        };
      }
    }
    const ok = await modifyCanvas(board, "update", params.elementId, msgs, info);
    const summary = (await canvasSummary(board)) as unknown as Summary;
    return {
      text: ok
        ? t("tool.updated", {
            id: params.elementId,
            label: String(info.label ?? el.type),
            strokes: msgs.length,
            count: summary.elementCount,
          })
        : t("tool.elNotFound", { id: params.elementId }),
      details: { ok, board },
    };
  }

  if (action === "remove") {
    if (!params.elementId) {
      return { text: t("tool.removeNeedId"), details: {} };
    }
    const ok = await modifyCanvas(board, "remove", params.elementId);
    const summary = (await canvasSummary(board)) as unknown as Summary;
    return {
      text: ok
        ? t("tool.removed", { id: params.elementId, count: summary.elementCount })
        : t("tool.elNotFound", { id: params.elementId }),
      details: { ok, board },
    };
  }

  // draw：先生成全部笔画（纯计算无副作用）→ 采样真实 bbox → 覆盖检查 → 通过才推送
  const built: Array<{ info: CanvasElementInfo; msgs: StrokeMsg[] }> = [];
  for (const el of validElements) {
    const elId = `el${Math.floor(Math.random() * 1e9).toString(36)}`;
    let info = toElementInfo(el);
    info.id = elId;
    let msgs: StrokeMsg[];
    if (el.type === "image") {
      // 图片不是笔画：直接推 image 消息，页面即时渲染
      msgs = [imageStrokeMsg(el, board, elId, info.z)];
    } else {
      const { strokes } = buildStrokeSequence(buildOpts(el), "fast");
      msgs = strokes.map((s) => ({
        type: "stroke",
        d: s.d,
        color: s.color,
        width: s.width,
        dur: Math.round(s.dur * 1000),
        fill: s.fillOnly,
        isText: s.isText,
        hatch: s.hatch,
        penUp: false,
        label: s.label,
        elementId: elId,
        z: info.z,
      }));
      // 真实边界回写：笔画采样 bbox ∪ 声明估算（文字估算仍覆盖文字区域）
      const real = strokesBBox(msgs);
      if (real) info = { ...info, ...unionRects(real, info) };
    }
    built.push({ info, msgs });
  }

  // 覆盖保护：真实 bbox vs 已有元素 + 同批互查，拒绝则整批不画
  if (!params.allowOverlap && built.length > 0) {
    const preSummary = (await canvasSummary(board)) as unknown as Summary;
    const existing: OverlapItem[] = (preSummary.occupied ?? []).map((o) => ({
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      tag: `${o.label ?? o.type}[${o.id}]`,
    }));
    const incoming: OverlapItem[] = built.map((b, i) => ({
      x: b.info.x,
      y: b.info.y,
      w: b.info.w,
      h: b.info.h,
      tag: `${b.info.label ?? b.info.type}(新${i + 1})`,
    }));
    const hits = findOverlapHits(incoming, existing);
    if (hits.length > 0) {
      return {
        text: t("tool.overlap", { hits: hits.join("；"), spots: formatFreeSpots(preSummary) }),
        details: { ok: false, collisions: hits },
      };
    }
  }

  const allMsgs = built.flatMap((b) => b.msgs);
  const infos = built.map((b) => b.info);
  if (infos.length > 0) await pushToCanvas(board, allMsgs, infos);

  const summary = (await canvasSummary(board)) as unknown as Summary;
  return {
    text:
      (warnings.length ? warnings.join("\n") + "\n" : "") +
      t("tool.drew", {
        n: infos.length,
        strokes: allMsgs.length,
        board: summary.board ?? board,
        url,
        ids: infos.map((i) => `${i.label ?? i.type}[${i.id}]@(${Math.round(i.x)},${Math.round(i.y)})`).join("; "),
        count: summary.elementCount,
        bounds: formatBounds(summary),
        spots: formatFreeSpots(summary),
      }),
    details: summary as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// handdraw_board 主逻辑
// ---------------------------------------------------------------------------

export async function executeBoardAction(
  params: BoardActionParams,
  opts: ExecuteOptions = {}
): Promise<ToolResult> {
  const url = await ensureCanvasServer(opts.openBrowser ?? false);
  if (!url) {
    return { text: t("tool.serverFail"), details: { ok: false } };
  }
  const { action, name } = params;

  if (action === "list") {
    const { active, boards } = await boardsList();
    const text =
      boards.length === 0
        ? t("board.listEmpty")
        : t("board.list", {
            active,
            boards: boards
              .map((b) =>
                t("board.item", {
                  name: b.name,
                  count: b.elementCount,
                  dir: b.dir,
                  current: b.active ? t("board.currentMark") : "",
                })
              )
              .join("\n"),
          });
    return { text, details: { ok: true, active, boards } as unknown as Record<string, unknown> };
  }

  if (!name) {
    return { text: t("board.needName", { action }), details: { ok: false } };
  }
  if (!isValidBoardName(name)) {
    return { text: t("board.invalidName", { name }), details: { ok: false } };
  }

  if (action === "create") {
    const r = await boardOp("create", name);
    const { boards } = await boardsList();
    const dir = boards.find((b) => b.name === name)?.dir ?? "";
    return {
      text: r.created === false ? t("board.exists", { name }) : t("board.created", { name, dir }),
      details: { ok: r.ok, board: name, dir, created: r.created ?? true },
    };
  }

  if (action === "switch") {
    const r = await boardOp("switch", name);
    if (!r.ok) return { text: t("board.notFound", { name }), details: { ok: false } };
    const { boards } = await boardsList();
    const count = boards.find((b) => b.name === name)?.elementCount ?? 0;
    return { text: t("board.switched", { name, count }), details: { ok: true, board: name } };
  }

  // delete
  const r = await boardOp("delete", name);
  if (!r.ok) return { text: t("board.notFound", { name }), details: { ok: false } };
  return { text: t("board.deleted", { name }), details: { ok: true, board: name } };
}
