/**
 * core/geometry.ts — 矩形几何 + bbox 采样 + 覆盖检测（纯函数，无副作用）
 */
import { svgPathProperties } from "svg-path-properties";
import type { StrokeMsg, CanvasElementInfo } from "./domain";
import type { CanvasActionParams } from "./domain";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlapItem extends Rect {
  tag: string;
}

/** 向内缩 inset 像素：容忍贴边连接（箭头连到框边缘）等轻微接触 */
export function shrinkRect(r: Rect, inset: number): Rect {
  const w = Math.max(r.w - inset * 2, 1);
  const h = Math.max(r.h - inset * 2, 1);
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

export function rectHit(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectContains(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    outer.x <= inner.x + tolerance &&
    outer.y <= inner.y + tolerance &&
    outer.x + outer.w >= inner.x + inner.w - tolerance &&
    outer.y + outer.h >= inner.y + inner.h - tolerance
  );
}

/** 部分重叠=覆盖（拦截）；完全包含（容器装子元素/底色块垫文字）放行 */
export function isCovering(a: Rect, b: Rect, inset = 6): boolean {
  if (!rectHit(shrinkRect(a, inset), shrinkRect(b, inset))) return false;
  if (rectContains(a, b) || rectContains(b, a)) return false;
  return true;
}

/** 新元素 vs 已有元素 + 同批元素之间的覆盖冲突清单 */
export function findOverlapHits(incoming: OverlapItem[], existing: OverlapItem[]): string[] {
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

export function unionRects(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** 从笔画路径采样真实渲染 bbox（含描边宽度与手绘抖动余量）；无路径笔画（纯文字）返回 null */
export function strokesBBox(msgs: StrokeMsg[]): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
    if (s.isText || !s.d) continue;
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
export function pathBBox(d: string): Rect {
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

/** 工蚁任务必须落在蚁后分配的 region 内；返回错误文案或 null。workerId 为空（蚁后）时跳过校验 */
export function taskRegionError(workerId: string | undefined, params: CanvasActionParams, info: CanvasElementInfo): string | null {
  if (!workerId) return null;
  if (!params.taskId || !params.region) return `工蚁 ${workerId} 必须在 handdraw_canvas 中携带 taskId 和 region。`;
  if (!rectContains(params.region, info)) return `工蚁任务 ${params.taskId} 的元素超出允许区域。`;
  return null;
}