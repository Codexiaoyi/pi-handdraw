/**
 * core/canvas.ts — handdraw_canvas 工具主逻辑
 *
 * 流程：参数校验 → 角色门控 → 贴纸/图片预检 → 生成笔画 → 真实 bbox 回写 →
 * 覆盖保护 → 推送 → 返回文本摘要 + 结构化 details。
 */
import {
  buildStrokeSequence,
  layoutParagraph,
  measureText,
  type BuildOptions,
  type HandDrawElement,
  type ImageElement,
} from "../draw";
import { getCanvasServer, isValidBoardName, type StrokeMsg, type CanvasElementInfo } from "../canvas-server";
import { STICKERS, stickerList } from "../stickers";
import { t, getLang } from "../i18n";
import type { CanvasActionParams, ExecuteOptions, ToolResult } from "./domain";
import { DRAW_WORKER_ID, IS_QUEEN, isStatusRequest } from "./role";
import {
  findOverlapHits,
  pathBBox,
  strokesBBox,
  taskRegionError,
  unionRects,
  type OverlapItem,
} from "./geometry";
import { ensureCanvasServer, getBridge } from "./bridge";

/** 实时画布默认采用 turbo：相对旧 fast 时序约 2×，尤其降低中文逐笔画的累计等待。 */
const LIVE_ANIM_SPEED = "turbo" as const;

// ---------------------------------------------------------------------------
// 元素 → 笔画/摘要 辅助
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
function imageStrokeMsg(el: ImageElement, board: string, elementId: string, z?: number, taskId?: string): StrokeMsg {
  return {
    type: "stroke",
    d: "",
    color: "",
    width: 0,
    dur: 0,
    desc: el.desc,
    penUp: true,
    label: el.desc ?? el.src.split("/").pop() ?? "image",
    elementId,
    z,
    workerId: DRAW_WORKER_ID,
    taskId,
    image: { src: resolveImageSrc(el.src, board)!, x: el.x, y: el.y, w: el.w, h: el.h },
  };
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

// ---------------------------------------------------------------------------
// status 摘要格式化
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

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function executeCanvasAction(
  params: CanvasActionParams,
  opts: ExecuteOptions = {}
): Promise<ToolResult> {
  const action = params.action ?? "draw";
  const statusOnly = isStatusRequest(action, (params.elements ?? []).length > 0);
  // 严格蚁后模式：蚁后只负责理解、拆分、调度和验收，所有画布写操作必须由工蚁完成。
  if (IS_QUEEN && !statusOnly) {
    return {
      text: "❌ 蚁后不能直接修改画布。请先把绘图拆成互不重叠的区域任务，再调用 handdraw_delegate；蚁后只能用 handdraw_canvas 查看 status。",
      details: { ok: false, role: "queen", action },
    };
  }
  const url = await ensureCanvasServer(opts.openBrowser ?? true);
  if (!url) {
    return { text: t("tool.serverFail"), details: { ok: false } };
  }
  const server = getCanvasServer();
  const board = params.board && isValidBoardName(params.board) ? params.board : server.getActiveBoard();

  if (action === "clear") {
    if (DRAW_WORKER_ID) {
      return { text: "❌ 工蚁不能清空画板，只能绘制蚁后分配的区域。", details: { ok: false, workerId: DRAW_WORKER_ID } };
    }
    await getBridge().clear(board);
    return { text: t("tool.cleared"), details: { ok: true, board, elementCount: 0 } };
  }

  if (statusOnly) {
    const summary = (await getBridge().summary(board)) as unknown as Summary;
    const lang = getLang();
    const stickers = stickerList(lang);
    const boards = await getBridge().listBoards();
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
    const scopeError = taskRegionError(DRAW_WORKER_ID, params, info);
    if (scopeError) return { text: `❌ ${scopeError}`, details: { ok: false, taskId: params.taskId } };
    let msgs: StrokeMsg[];
    if (el.type === "image") {
      msgs = [imageStrokeMsg(el, board, params.elementId, info.z, params.taskId)];
    } else {
      const { strokes } = buildStrokeSequence(buildOpts(el), LIVE_ANIM_SPEED);
      msgs = strokes.map((s) => ({
        type: "stroke",
        d: s.d,
        color: s.color,
        width: s.width,
        dur: Math.round(s.dur * 1000),
        desc: typeof info.meta?.desc === "string" ? info.meta.desc : undefined,
        fill: s.fillOnly,
        isText: s.isText,
        hatch: s.hatch,
        penUp: false,
        label: s.label,
        elementId: params.elementId,
        workerId: DRAW_WORKER_ID,
        taskId: params.taskId,
      }));
      // 真实边界回写：笔画采样 bbox ∪ 声明估算
      const real = strokesBBox(msgs);
      if (real) info = { ...info, ...unionRects(real, info) };
    }
    // 覆盖保护（排除被更新的元素自身）
    if (!params.allowOverlap) {
      const preSummary = (await getBridge().summary(board)) as unknown as Summary;
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
    const ok = await getBridge().modify(board, "update", params.elementId, msgs, info);
    const summary = (await getBridge().summary(board)) as unknown as Summary;
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
    if (DRAW_WORKER_ID) {
      return { text: "❌ 工蚁不能删除元素，只能绘制蚁后分配的区域。", details: { ok: false, workerId: DRAW_WORKER_ID } };
    }
    if (!params.elementId) {
      return { text: t("tool.removeNeedId"), details: {} };
    }
    const ok = await getBridge().modify(board, "remove", params.elementId);
    const summary = (await getBridge().summary(board)) as unknown as Summary;
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
    const scopeError = taskRegionError(DRAW_WORKER_ID, params, info);
    if (scopeError) return { text: `❌ ${scopeError}`, details: { ok: false, taskId: params.taskId } };
    let msgs: StrokeMsg[];
    if (el.type === "image") {
      // 图片不是笔画：直接推 image 消息，页面即时渲染
      msgs = [imageStrokeMsg(el, board, elId, info.z, params.taskId)];
    } else {
      const { strokes } = buildStrokeSequence(buildOpts(el), LIVE_ANIM_SPEED);
      msgs = strokes.map((s) => ({
        type: "stroke",
        d: s.d,
        color: s.color,
        width: s.width,
        dur: Math.round(s.dur * 1000),
        desc: typeof info.meta?.desc === "string" ? info.meta.desc : undefined,
        fill: s.fillOnly,
        isText: s.isText,
        hatch: s.hatch,
        penUp: false,
        label: s.label,
        elementId: elId,
        z: info.z,
        workerId: DRAW_WORKER_ID,
        taskId: params.taskId,
      }));
      // 真实边界回写：笔画采样 bbox ∪ 声明估算（文字估算仍覆盖文字区域）
      const real = strokesBBox(msgs);
      if (real) info = { ...info, ...unionRects(real, info) };
    }
    built.push({ info, msgs });
  }

  // 覆盖保护：真实 bbox vs 已有元素 + 同批互查，拒绝则整批不画
  if (!params.allowOverlap && built.length > 0) {
    const preSummary = (await getBridge().summary(board)) as unknown as Summary;
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
  if (infos.length > 0) await getBridge().push(board, allMsgs, infos);

  const summary = (await getBridge().summary(board)) as unknown as Summary;
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
