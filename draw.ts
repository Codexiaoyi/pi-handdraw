/**
 * draw.ts — 手绘风 SVG 生成器
 *
 * 基于 rough.js 的 generator（无需 DOM），把结构化的图形描述
 * （方框/椭圆/菱形/箭头/文字/路径）渲染成手绘风 SVG。
 * 中文文字使用楷体（Kaiti SC），配合 rough 的抖动笔画形成手绘质感。
 */
import rough from "roughjs";
import type { Options } from "roughjs/bin/core";
import { svgPathProperties } from "svg-path-properties";
import { charStrokeParts, charDrawInfo } from "./handwriting";
import { STICKERS } from "./stickers";

const gen = rough.generator();

// ---------------------------------------------------------------------------
// 元素类型
// ---------------------------------------------------------------------------

export interface BoxLikeElement {
  type: "box" | "ellipse" | "diamond";
  /** 坐标（flow 布局下可省略，自动排布） */
  x?: number;
  y?: number;
  /** 尺寸（默认 160x70） */
  w?: number;
  h?: number;
  /** 形状内文字，默认居中；textPosition="top" 时贴框内顶部（容器/模块框的标题用） */
  text?: string;
  /** 文字位置：center=居中（默认，叶子节点用）；top=框内顶部（容器/模块框用，内容从标题下方开始排） */
  textPosition?: "center" | "top";
  /** 描边颜色 */
  color?: string;
  /** 填充颜色 */
  fill?: string;
  /** 填充风格：hachure(手绘斜线) | solid | zigzag | cross-hatch */
  fillStyle?: string;
  textSize?: number;
  /** agent 画这个对象时写的说明（自然语言描述，如"用户登录入口"），双击浮窗展示 */
  desc?: string;
  /** 叠放层次：小的在下面；不设则后画的在上 */
  z?: number;
}

export interface LineLikeElement {
  type: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 连线标签（箭头中点的说明文字） */
  text?: string;
  color?: string;
  /** 叠放层次：小的在下面；不设则后画的在上 */
  z?: number;
}

export interface TextElement {
  type: "text";
  x: number;
  y: number;
  text: string;
  size?: number;
  color?: string;
  /** 段落宽度：设置后开启自动换行（此时 x,y 为段落左上角）；不设且文本无 \n 时为单行（x,y 为文字中心，旧行为） */
  w?: number;
  /** 行距（字号倍数，默认 1.6，仅多行有效） */
  lineHeight?: number;
  /** 对齐（仅多行有效，默认 left） */
  align?: "left" | "center" | "right";
  /** 叠放层次：小的在下面；不设则后画的在上 */
  z?: number;
}

export interface StickerElement {
  type: "sticker";
  /** 贴纸名（见 stickers.ts，status 返回清单） */
  name: string;
  /** 左上角 */
  x: number;
  y: number;
  /** 边长（默认 80） */
  size?: number;
  /** 整体覆盖描边色（不设用贴纸自带配色） */
  color?: string;
  /** 叠放层次：小的在下面；不设则后画的在上 */
  z?: number;
}

export interface PathElement {
  type: "path";
  /** SVG path 数据 */
  d: string;
  color?: string;
  fill?: string;
  /** 叠放层次：小的在下面；不设则后画的在上 */
  z?: number;
}

export interface ImageElement {
  type: "image";
  /** 图片来源：http(s) URL、data:image/...;base64,...、或画板 images/ 目录下的文件名 */
  src: string;
  /** 左上角 */
  x: number;
  y: number;
  /** 显示宽高 */
  w: number;
  h: number;
  /** agent 写的说明，双击浮窗展示 */
  desc?: string;
  /** 叠放层次：小的在下面；不设则后画的在上 */
  z?: number;
}

export type HandDrawElement = BoxLikeElement | LineLikeElement | TextElement | StickerElement | PathElement | ImageElement;

export interface BuildOptions {
  title?: string;
  width?: number;
  height?: number;
  background?: string;
  /** flow = 自动流式布局（形状自动排布+自动画箭头）；manual = 完全手动指定坐标 */
  layout?: "flow" | "manual";
  /** 无论布局模式都渲染标题（live 预览用） */
  showTitle?: boolean;
  elements: HandDrawElement[];
}

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

/** 楷体：中文手写/书法质感；macOS 上 resvg 可直接加载 */
const FONT_FAMILY = `'Kaiti SC','Xingkai SC','Songti SC',cursive`;
/** 手写英文字体（浏览器系统字体） */
const LATIN_FONT = `'Marker Felt','Apple Chancery','Noteworthy','Bradley Hand','Snell Roundhand',cursive`;
const NOS = "none";
const MARGIN = 40;
const HGAP = 120; // 形状间距（放置箭头）
const VGAP = 110; // 行间距（放置箭头）

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 由元素内容生成确定性随机种子，保证同一描述反复生成时画面稳定 */
function seedFor(index: number): number {
  return (index * 7919 + 17) % 2147483647;
}

function roughOptions(color: string | undefined, fill: string | undefined, fillStyle: string | undefined, seed: number): Options {
  const opts: Options = {
    roughness: 1.8,
    bowing: 1.2,
    stroke: color ?? "#37474f",
    strokeWidth: 2,
    seed,
  };
  if (fill && fill !== NOS) {
    opts.fill = fill;
    opts.fillStyle = fillStyle ?? "hachure";
    opts.fillWeight = 1.2;
    opts.hachureGap = 6;
    opts.hachureAngle = -41;
  }
  return opts;
}

function pathsToSvg(drawable: unknown): string {
  const d = drawable as { sets?: Array<{ type: string; ops: Array<{ op: string; data: number[] }> }>; options: Options };
  return (d.sets ?? [])
    .map((set) => {
      const pathData = gen.opsToPath(set as never);
      const attrs: string[] = [`d="${pathData}"`];
      const isFill = set.type === "fillPath" || set.type === "fillSketch";
      const stroke = isFill ? (d.options.fill ?? NOS) : d.options.stroke ?? "#000";
      const sw = isFill ? Math.max(1, (d.options.fillWeight ?? 1) / 2) : (d.options.strokeWidth ?? 2);
      if (stroke !== NOS) attrs.push(`stroke="${stroke}"`);
      if (set.type === "fillPath") attrs.push(`fill="${d.options.fill ?? NOS}"`);
      else attrs.push(`fill="${NOS}"`);
      attrs.push(`stroke-width="${sw}"`);
      attrs.push('stroke-linecap="round"');
      attrs.push('stroke-linejoin="round"');
      return `<path ${attrs.join(" ")}/>`;
    })
    .join("");
}

function textSvg(x: number, y: number, text: string, size: number, color: string, anchor: "middle" | "start" | "end" = "middle"): string {
  return (
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" ` +
    `font-family="${FONT_FAMILY}" font-size="${size}" fill="${color}">${esc(text)}</text>`
  );
}

// ---------------------------------------------------------------------------
// 图形渲染
// ---------------------------------------------------------------------------

/** 盒内文字的中心 y：center=几何中心；top=容器标题（贴框内顶部，下方留内容区） */
function boxTextCY(el: BoxLikeElement, y: number, h: number, size: number): number {
  return el.textPosition === "top" ? y + 10 + size * 0.7 : y + h / 2;
}

function renderBox(el: BoxLikeElement, seed: number): string {
  const x = el.x ?? 0;
  const y = el.y ?? 0;
  const w = el.w ?? 160;
  const h = el.h ?? 70;
  const color = el.color ?? "#37474f";
  const parts: string[] = [];
  if (el.type === "box") {
    parts.push(pathsToSvg(gen.rectangle(x, y, w, h, roughOptions(color, el.fill, el.fillStyle, seed))));
  } else if (el.type === "ellipse") {
    parts.push(pathsToSvg(gen.ellipse(x + w / 2, y + h / 2, w, h, roughOptions(color, el.fill, el.fillStyle, seed))));
  } else {
    // diamond
    const pts: [number, number][] = [
      [x + w / 2, y],
      [x + w, y + h / 2],
      [x + w / 2, y + h],
      [x, y + h / 2],
    ];
    parts.push(pathsToSvg(gen.polygon(pts, roughOptions(color, el.fill, el.fillStyle, seed))));
  }
  if (el.text) {
    // 文字用笔画书写（汉字按笔顺渲染，无笔画数据的字符 fallback 字体）；超出盒子自动缩小
    const size = fitTextSize(el.text, w, h, el.textSize ?? 22);
    const strokeParts = textParts(el.text, x + w / 2, boxTextCY(el, y, h, size), size, el.color ?? "#263238", 1, 0);
    strokeParts.forEach((p) => parts.push(p.render(1)));
  }
  return parts.join("");
}

function renderArrow(x1: number, y1: number, x2: number, y2: number, color: string, seed: number): string {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const headLen = Math.min(16, len / 2);
  const bx = x2 - headLen * Math.cos(ang - Math.PI / 6);
  const by = y2 - headLen * Math.sin(ang - Math.PI / 6);
  const cx = x2 - headLen * Math.cos(ang + Math.PI / 6);
  const cy = y2 - headLen * Math.sin(ang + Math.PI / 6);
  const shaftEndX = x2 - headLen * Math.cos(ang);
  const shaftEndY = y2 - headLen * Math.sin(ang);
  const line = pathsToSvg(
    gen.linearPath(
      [
        [x1, y1],
        [shaftEndX, shaftEndY],
      ],
      roughOptions(color, undefined, undefined, seed)
    )
  );
  const head = pathsToSvg(
    gen.polygon(
      [
        [x2, y2],
        [bx, by],
        [cx, cy],
      ],
      roughOptions(color, color, "solid", seed + 1)
    )
  );
  return line + head;
}

function renderElement(el: HandDrawElement, seed: number): string {
  switch (el.type) {
    case "box":
    case "ellipse":
    case "diamond": {
      return renderBox(el, seed);
    }
    case "line": {
      return pathsToSvg(
        gen.linearPath(
          [
            [el.x1, el.y1],
            [el.x2, el.y2],
          ],
          roughOptions(el.color, undefined, undefined, seed)
        )
      );
    }
    case "arrow": {
      const color = el.color ?? "#37474f";
      let out = renderArrow(el.x1, el.y1, el.x2, el.y2, color, seed);
      if (el.text) {
        out += textSvg((el.x1 + el.x2) / 2, (el.y1 + el.y2) / 2 - 8, el.text, 13, color, "middle");
      }
      return out;
    }
    case "text": {
      return textSvg(el.x, el.y, el.text, el.size ?? 16, el.color ?? "#263238", "middle");
    }
    case "path": {
      return pathsToSvg(gen.path(el.d, roughOptions(el.color, el.fill, "hachure", seed)));
    }
  }
}

// ---------------------------------------------------------------------------
// flow 布局：形状自动排布 + 自动箭头
// ---------------------------------------------------------------------------

function isShape(el: HandDrawElement): el is BoxLikeElement {
  return el.type === "box" || el.type === "ellipse" || el.type === "diamond";
}

function computeFlowSize(shapes: BoxLikeElement[], width: number): { width: number; height: number } {
  let x = MARGIN;
  let y = MARGIN + 20;
  let maxExtent = MARGIN;
  for (const s of shapes) {
    const w = s.w ?? 160;
    const h = s.h ?? 70;
    if (x + w > width - MARGIN && x > MARGIN) {
      x = MARGIN;
      y += h + VGAP;
    }
    x += w + HGAP;
    maxExtent = Math.max(maxExtent, x);
  }
  const lastH = shapes.length ? (shapes[shapes.length - 1].h ?? 70) : 0;
  return { width: Math.min(Math.max(maxExtent + MARGIN, 420), 2000), height: y + lastH + MARGIN + 10 };
}

function layoutFlow(elements: HandDrawElement[], width: number): HandDrawElement[] {
  const out: HandDrawElement[] = [...elements];
  const shapes = elements.filter(isShape);
  let x = MARGIN;
  let y = MARGIN + 20;
  for (const s of shapes) {
    const w = s.w ?? 160;
    const h = s.h ?? 70;
    if (x + w > width - MARGIN && x > MARGIN) {
      x = MARGIN;
      y += h + VGAP;
    }
    s.x = x;
    s.y = y;
    x += w + HGAP;
  }
  // 相邻形状之间自动加箭头
  for (let i = 0; i < shapes.length - 1; i++) {
    const a = shapes[i];
    const b = shapes[i + 1];
    const aw = a.w ?? 160;
    const ah = a.h ?? 70;
    const bw = b.w ?? 160;
    const bh = b.h ?? 70;
    const sameRow = Math.abs((b.y ?? 0) - (a.y ?? 0)) < 1;
    const arrow: LineLikeElement = sameRow
      ? { type: "arrow", x1: (a.x ?? 0) + aw, y1: (a.y ?? 0) + ah / 2, x2: b.x ?? 0, y2: (b.y ?? 0) + bh / 2 }
      : { type: "arrow", x1: (a.x ?? 0) + aw / 2, y1: (a.y ?? 0) + ah, x2: (b.x ?? 0) + bw / 2, y2: b.y ?? 0 };
    out.push(arrow);
  }
  return out;
}

/**
 * 布局：返回已定位的元素（flow 下含自动箭头）和画布尺寸。
 * 用于 live 绘制——先用最终布局固定坐标，再逐步渲染保证位置一致。
 */
/** 计算所有元素的内容包围盒（用于 manual 布局自动扩展画布） */
function computeContentBBox(elements: HandDrawElement[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const el of elements) {
    if (el.type === "box" || el.type === "ellipse" || el.type === "diamond") {
      const x = el.x ?? 0;
      const y = el.y ?? 0;
      const w = el.w ?? 160;
      const h = el.h ?? 70;
      add(x, y);
      add(x + w, y + h);
    } else if (el.type === "line" || el.type === "arrow") {
      add(el.x1, el.y1);
      add(el.x2, el.y2);
      // 箭头文字
      if (el.type === "arrow" && el.text) {
        add((el.x1 + el.x2) / 2, (el.y1 + el.y2) / 2);
      }
    } else if (el.type === "text") {
      add(el.x, el.y);
    }
  }
  if (!isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 300, maxY: 200 };
  }
  return { minX, minY, maxX, maxY };
}

export function layoutElements(opts: BuildOptions): {
  elements: HandDrawElement[];
  width: number;
  height: number;
} {
  let elements = opts.elements ?? [];
  let width = opts.width ?? 800;
  let height = opts.height ?? 500;

  if (opts.layout === "flow") {
    const shapes = elements.filter(isShape);
    const size = computeFlowSize(shapes, width);
    width = opts.width ?? size.width;
    height = opts.height ?? size.height;
    elements = layoutFlow(elements, width);
  } else {
    // manual：画布自动适应内容（不裁剪），可指定 width/height 覆盖
    if (!opts.width || !opts.height) {
      const box = computeContentBBox(elements);
      const titleHead = opts.title ? 60 : 20; // 顶部标题空间
      width = opts.width ?? Math.max(box.maxX + MARGIN, 300);
      height = opts.height ?? Math.max(box.maxY + MARGIN, titleHead);
    }
  }

  return { elements, width, height };
}

// ---------------------------------------------------------------------------
// 手写动画：笔画级书写脚本（模拟人一笔一笔写画）
// ---------------------------------------------------------------------------

export interface AnimPart {
  /** 该片段绘制到 progress(0..1) 时的 SVG 片段；progress=1 为完整 */
  render: (progress: number) => string;
  /** 播放帧数（1 = 一帧直接出现，如填充线） */
  frames: number;
  /** 每帧间隔 ms */
  interval: number;
  /** 进度提示文字（如 "写 登"） */
  label: string;
}

export interface AnimScript {
  width: number;
  height: number;
  background?: string;
  /** 按书写顺序排列的所有笔画片段 */
  parts: AnimPart[];
}

export type AnimSpeed = "real" | "fast";

interface SpeedTiming {
  edgeFrames: number;
  edgeInterval: number;
  strokeFrames: number;
  strokeInterval: number;
  fillInterval: number;
}

const SPEED: Record<AnimSpeed, SpeedTiming> = {
  // 正常手写速度：一笔约 0.2-0.3 秒
  real: { edgeFrames: 6, edgeInterval: 42, strokeFrames: 4, strokeInterval: 48, fillInterval: 8 },
  // 快速：总时长约减半
  fast: { edgeFrames: 3, edgeInterval: 26, strokeFrames: 2, strokeInterval: 26, fillInterval: 6 },
};

function growingPart(pathD: string, color: string, strokeWidth: number, frames: number, interval: number, label: string): AnimPart {
  let length = -1;
  const attrs = `fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`;
  return {
    label,
    frames,
    interval,
    render: (progress: number) => {
      if (progress >= 1) return `<path d="${pathD}" ${attrs}/>`;
      if (length < 0) length = new svgPathProperties(pathD).getTotalLength();
      const shown = length * Math.min(1, Math.max(0, progress));
      return `<path d="${pathD}" ${attrs} stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${(length - shown).toFixed(1)}"/>`;
    },
  };
}

/** 把 rough 的 fillSketch 填充拆成单条线（快速逐条涂色） */
function fillLineParts(drawable: unknown, fillColor: string, interval: number): AnimPart[] {
  const d = drawable as { sets?: Array<{ type: string; ops: Array<{ op: string; data: number[] }> }> };
  const set = d.sets?.find((s) => s.type === "fillSketch");
  if (!set) return [];
  const lines: Array<Array<{ op: string; data: number[] }>> = [];
  let current: Array<{ op: string; data: number[] }> = [];
  for (const op of set.ops) {
    if (op.op === "move" && current.length > 0) {
      lines.push(current);
      current = [];
    }
    current.push(op);
  }
  if (current.length) lines.push(current);
  const sw = Math.max(0.8, 1.2);
  return lines.map((ops) => {
    const dAttr = gen.opsToPath({ type: "fillSketch", ops } as never);
    return {
      label: "涂色",
      frames: 1,
      interval,
      render: () =>
        `<path d="${dAttr}" fill="none" stroke="${fillColor}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`,
    };
  });
}

/** 文字拆成逐字逐笔画（汉字用笔顺数据，非汉字整段出现） */
/** 从 StrokePart.full（完整 path 字符串）提取 d 属性 */
function extractPathD(full: string): string {
  return full.match(/d="([^"]*)"/)?.[1] ?? "";
}

/**
 * 文字自适应字号：估算文字总宽（含字符间距），超出盒子可用空间时自动缩小。
 */
function fitTextSize(text: string, boxW: number, boxH: number, requested: number): number {
  let size = requested;
  for (let attempt = 0; attempt < 5; attempt++) {
    const totalW = layoutSegments(text, 0, size).reduce((s, seg) => s + seg.width, 0);
    const maxH = size * 1.35; // 含上升/下降部
    if (totalW <= boxW * 0.92 && maxH <= boxH * 0.92) return size;
    size *= 0.82;
  }
  return Math.max(8, size);
}

interface TextSegment {
  kind: "hanzi" | "latin" | "fallback";
  text: string;
  width: number;
}

/** 汉字段内逐字 x 位置（段中心向两侧等分，带字距） */
function hanziCharXs(text: string, segCx: number, size: number): number[] {
  const chars = Array.from(text);
  const n = chars.length;
  const gap = size * 1.06; // 字距略大于字号，避免笔画重叠
  return chars.map((_, i) => segCx + (i - (n - 1) / 2) * gap);
}

/** 按字符类型连续分段（汉字段逐笔画，拉丁/符号段用字体渲染） */
function segmentText(text: string, size: number): TextSegment[] {
  const chars = Array.from(text);
  const segments: TextSegment[] = [];
  let cur: TextSegment | null = null;
  for (const c of chars) {
    const kind = charDrawInfo(c, 0, 0, size).kind;
    if (!cur || cur.kind !== kind) {
      cur = { kind, text: c, width: 0 };
      segments.push(cur);
    } else {
      cur.text += c;
    }
  }
  for (const seg of segments) {
    const n = seg.text.length;
    seg.width =
      seg.kind === "hanzi" ? n * size * 1.06 : n * (seg.kind === "latin" ? 0.55 : 0.6) * size;
  }
  return segments;
}

/** 单行文字宽度估算（与 layoutSegments 一致的分段宽度模型） */
export function measureText(text: string, size: number): number {
  const segs = segmentText(text, size);
  const gap = size * 0.15;
  return segs.reduce((s, seg) => s + seg.width, 0) + gap * Math.max(0, segs.length - 1);
}

export interface ParagraphLayout {
  lines: string[];
  /** 最宽行宽度 */
  width: number;
  /** 总高 = 行数 × 行距 */
  height: number;
  lineHeightPx: number;
}

/** 段落排版：\n 分行 + 可选自动换行（拉丁按词、其余按字，贪心装行） */
export function layoutParagraph(text: string, size: number, maxW?: number, lineHeightMul = 1.6): ParagraphLayout {
  const lineHeightPx = size * lineHeightMul;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!maxW || measureText(para, size) <= maxW) {
      out.push(para);
      continue;
    }
    const tokens = para.match(/[A-Za-z0-9''_-]+\s*|\S|\s+/g) ?? [para];
    let line = "";
    for (const tok of tokens) {
      if (line !== "" && measureText(line + tok, size) > maxW) {
        out.push(line.trimEnd());
        line = tok.trimStart();
      } else {
        line += tok;
      }
    }
    if (line !== "") out.push(line.trimEnd());
  }
  const lines = out.length ? out : [""];
  const width = Math.max(...lines.map((l) => measureText(l, size)), 1);
  return { lines, width, height: lines.length * lineHeightPx, lineHeightPx };
}

/** 分段布局：总宽居中，返回每段的中心 x */
function layoutSegments(text: string, cx: number, size: number): Array<TextSegment & { cx: number }> {
  const segs = segmentText(text, size);
  const gap = size * 0.15;
  const totalW = segs.reduce((s, seg) => s + seg.width, 0) + gap * Math.max(0, segs.length - 1);
  let cursor = cx - totalW / 2;
  return segs.map((seg) => {
    const segCx = cursor + seg.width / 2;
    cursor += seg.width + gap;
    return { ...seg, cx: segCx };
  });
}

function textParts(text: string, cx: number, cy: number, size: number, color: string, frames: number, interval: number): AnimPart[] {
  const parts: AnimPart[] = [];
  for (const seg of layoutSegments(text, cx, size)) {
    if (seg.kind === "hanzi") {
      // 汉字逐笔画（段内逐字排开）
      const chars = Array.from(seg.text);
      const xs = hanziCharXs(seg.text, seg.cx, size);
      chars.forEach((c, i) => {
        const strokes = charStrokeParts(c, xs[i], cy, size, color);
        if (strokes) {
          strokes.forEach((sp) => {
            parts.push({ label: `写 ${c}`, frames, interval, render: sp.render });
          });
        }
      });
    } else {
      // 拉丁/符号：手写字体整段渲染
      parts.push({
        label: `写 ${seg.text}`,
        frames: 1,
        interval: 0,
        render: () =>
          `<text x="${seg.cx.toFixed(1)}" y="${(cy + size * 0.22).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="${LATIN_FONT}" font-size="${size}" fill="${color}">${esc(seg.text)}</text>`,
      });
    }
  }
  return parts;
}

/** 盒子中心文字（逐笔画，自动适配字号） */
function boxTextParts(el: BoxLikeElement, t: SpeedTiming): AnimPart[] {
  if (!el.text) return [];
  const x = el.x ?? 0;
  const y = el.y ?? 0;
  const w = el.w ?? 160;
  const h = el.h ?? 70;
  const size = fitTextSize(el.text, w, h, el.textSize ?? 22);
  const cx = x + w / 2;
  const cy = boxTextCY(el, y, h, size);
  const color = el.color ?? "#263238";
  return textParts(el.text, cx, cy, size, color, t.strokeFrames, t.strokeInterval);
}

/** 生成一个元素的书写片段序列（轮廓 → 涂色 → 写字） */
function elementParts(el: HandDrawElement, t: SpeedTiming, elIndex: number): AnimPart[] {
  const parts: AnimPart[] = [];
  const seed = seedFor(elIndex + 1);

  if (el.type === "box" || el.type === "ellipse" || el.type === "diamond") {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const w = el.w ?? 160;
    const h = el.h ?? 70;
    const color = el.color ?? "#37474f";
    const fill = el.fill;
    const label = el.type === "box" ? "画框" : el.type === "ellipse" ? "画椭圆" : "画菱形";

    if (el.type === "box" || el.type === "diamond") {
      // 四条边逐笔画（顺时针）
      const edges: Array<[number, number, number, number]> =
        el.type === "box"
          ? [
              [x, y, x + w, y],
              [x + w, y, x + w, y + h],
              [x + w, y + h, x, y + h],
              [x, y + h, x, y],
            ]
          : (() => {
              const cx = x + w / 2;
              const cy = y + h / 2;
              return [
                [cx, y, x + w, cy],
                [x + w, cy, cx, y + h],
                [cx, y + h, x, cy],
                [x, cy, cx, y],
              ];
            })();
      const opts = roughOptions(color, undefined, undefined, seed);
      edges.forEach(([x1, y1, x2, y2], i) => {
        const line = gen.linearPath(
          [
            [x1, y1],
            [x2, y2],
          ],
          { ...opts, seed: seed + i }
        );
        const dAttr = gen.opsToPath((line.sets?.[0] ?? line) as never);
        parts.push(growingPart(dAttr, color, 2, t.edgeFrames, t.edgeInterval, label));
      });
      // 填充（hachure）快速逐条涂
      if (fill && fill !== NOS) {
        const filled = gen.rectangle(x, y, w, h, roughOptions(color, fill, el.fillStyle, seed + 100));
        parts.push(...fillLineParts(filled, fill, t.fillInterval));
      }
    } else {
      // 椭圆：上下两笔
      const cx = x + w / 2;
      const cy = y + h / 2;
      const opts = roughOptions(color, undefined, undefined, seed);
      const arc1 = gen.arc(cx, cy, w, h, Math.PI, 2 * Math.PI, false, opts);
      const arc2 = gen.arc(cx, cy, w, h, 0, Math.PI, false, { ...opts, seed: seed + 1 });
      const d1 = gen.opsToPath((arc1.sets?.[0] ?? arc1) as never);
      const d2 = gen.opsToPath((arc2.sets?.[0] ?? arc2) as never);
      parts.push(growingPart(d1, color, 2, t.edgeFrames, t.edgeInterval, label));
      parts.push(growingPart(d2, color, 2, t.edgeFrames, t.edgeInterval, label));
      if (fill && fill !== NOS) {
        const filled = gen.ellipse(cx, cy, w, h, roughOptions(color, fill, el.fillStyle, seed + 100));
        parts.push(...fillLineParts(filled, fill, t.fillInterval));
      }
    }
    // 写字
    parts.push(...boxTextParts(el, t));
    return parts;
  }

  if (el.type === "line") {
    const line = gen.linearPath(
      [
        [el.x1, el.y1],
        [el.x2, el.y2],
      ],
      roughOptions(el.color, undefined, undefined, seed)
    );
    const dAttr = gen.opsToPath((line.sets?.[0] ?? line) as never);
    parts.push(growingPart(dAttr, el.color ?? "#37474f", 2, t.edgeFrames, t.edgeInterval, "画线"));
    return parts;
  }

  if (el.type === "arrow") {
    const color = el.color ?? "#37474f";
    const ang = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
    const len = Math.hypot(el.x2 - el.x1, el.y2 - el.y1);
    const headLen = Math.min(16, len / 2);
    const bx = el.x2 - headLen * Math.cos(ang - Math.PI / 6);
    const by = el.y2 - headLen * Math.sin(ang - Math.PI / 6);
    const cx = el.x2 - headLen * Math.cos(ang + Math.PI / 6);
    const cy = el.y2 - headLen * Math.sin(ang + Math.PI / 6);
    const line = gen.linearPath(
      [
        [el.x1, el.y1],
        [el.x2 - headLen * Math.cos(ang), el.y2 - headLen * Math.sin(ang)],
      ],
      roughOptions(color, undefined, undefined, seed)
    );
    const dAttr = gen.opsToPath((line.sets?.[0] ?? line) as never);
    parts.push(growingPart(dAttr, color, 2, t.edgeFrames, t.edgeInterval, "连线"));
    // 箭头尖：最后快速画
    const head = gen.polygon(
      [
        [el.x2, el.y2],
        [bx, by],
        [cx, cy],
      ],
      roughOptions(color, color, "solid", seed + 1)
    );
    const dHead = gen.opsToPath((head.sets?.[0] ?? head) as never);
    parts.push({
      label: "箭头",
      frames: 2,
      interval: 30,
      render: (p) =>
        `<path d="${dHead}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    });
    if (el.text) {
      parts.push({
        label: "标注",
        frames: 1,
        interval: 0,
        render: () => textSvg((el.x1 + el.x2) / 2, (el.y1 + el.y2) / 2 - 8, el.text, 13, color),
      });
    }
    return parts;
  }

  if (el.type === "sticker") return []; // 贴纸仅实时画布（buildStrokeSequence）支持
  if (el.type === "image") return []; // 图片仅实时画布支持（非笔画，core 直接推 image 消息）

  if (el.type === "text") {
    return textParts(el.text.replace(/\n/g, " "), el.x, el.y, el.size ?? 16, el.color ?? "#263238", t.strokeFrames, t.strokeInterval);
  }

  // path：整条生长
  const opts = roughOptions(el.color, el.fill, "hachure", seed);
  const drawn = gen.path(el.d, opts);
  const dAttr = gen.opsToPath((drawn.sets?.[0] ?? drawn) as never);
  parts.push(growingPart(dAttr, el.color ?? "#37474f", 2, t.edgeFrames, t.edgeInterval, "画路径"));
  return parts;
}

/** 生成完整的书写动画脚本（标题 → 各元素逐笔画） */
export function buildAnimScript(opts: BuildOptions, speed: AnimSpeed): AnimScript {
  const { elements, width, height } = layoutElements(opts);
  const t = SPEED[speed];
  const parts: AnimPart[] = [];

  if (opts.title) {
    parts.push(...textParts(opts.title, width / 2, 22, 24, "#37474f", t.strokeFrames, t.strokeInterval));
  }
  for (const [i, el] of elements.entries()) {
    parts.push(...elementParts(el, t, i));
  }

  return { width, height, background: opts.background, parts };
}

/** 渲染动画第 idx 个片段绘制到 progress 时的完整 SVG */
export function renderAnimFrame(script: AnimScript, idx: number, progress: number): string {
  const chunks: string[] = [];
  if (script.background && script.background !== "transparent") {
    chunks.push(`<rect width="${script.width}" height="${script.height}" fill="${script.background}"/>`);
  }
  for (let i = 0; i < script.parts.length; i++) {
    if (i < idx) {
      chunks.push(script.parts[i].render(1));
    } else if (i === idx) {
      chunks.push(script.parts[i].render(progress));
    } else {
      break;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${script.width}" height="${script.height}" viewBox="0 0 ${script.width} ${script.height}">` +
    chunks.join("") +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// 光栅化书写脚本：把所有笔画转成点序列，供位图增量引擎逐笔绘制
// ---------------------------------------------------------------------------

export interface RasterPart {
  label: string;
  /** #rrggbb */
  color: string;
  /** 布局坐标系线宽 */
  width: number;
  /** 布局坐标系点序列 */
  points: Array<[number, number]>;
  frames: number;
  interval: number;
  /** 三角形填充（箭头尖）：三点 */
  triangle?: Array<[number, number]>;
}

export interface RasterScript {
  width: number;
  height: number;
  background?: string;
  parts: RasterPart[];
}

/** 把 SVG path 采样成点序列（布局坐标系） */
function samplePath(d: string, step = 2): Array<[number, number]> {
  const props = new svgPathProperties(d);
  const len = props.getTotalLength();
  const pts: Array<[number, number]> = [];
  const n = Math.max(2, Math.ceil(len / step));
  for (let i = 0; i <= n; i++) {
    const p = props.getPointAtLength((len * i) / n);
    pts.push([p.x, p.y]);
  }
  return pts;
}

/** 汉字笔画 → 布局坐标系点序列（用 medians 运笔轨迹，书写方向正确） */
function hanziPathPoints(char: string, cx: number, cy: number, size: number): Array<Array<[number, number]>> | null {
  const strokes = charStrokePaths(char, cx, cy, size);
  if (!strokes) return null;
  return strokes.map((s) => samplePath(s.d, 1.5));
}

/** 生成一个元素的全部光栅化笔画片段（轮廓 → 涂色 → 写字） */
function elementRasterParts(el: HandDrawElement, t: SpeedTiming, elIndex: number): RasterPart[] {
  const parts: RasterPart[] = [];
  const seed = seedFor(elIndex + 1);

  if (el.type === "box" || el.type === "ellipse" || el.type === "diamond") {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const w = el.w ?? 160;
    const h = el.h ?? 70;
    const color = el.color ?? "#37474f";
    const fill = el.fill;
    const label = el.type === "box" ? "画框" : el.type === "ellipse" ? "画椭圆" : "画菱形";

    if (el.type === "box" || el.type === "diamond") {
      const edges: Array<[number, number, number, number]> =
        el.type === "box"
          ? [
              [x, y, x + w, y],
              [x + w, y, x + w, y + h],
              [x + w, y + h, x, y + h],
              [x, y + h, x, y],
            ]
          : (() => {
              const cx = x + w / 2;
              const cy = y + h / 2;
              return [
                [cx, y, x + w, cy],
                [x + w, cy, cx, y + h],
                [cx, y + h, x, cy],
                [x, cy, cx, y],
              ];
            })();
      edges.forEach(([x1, y1, x2, y2], i) => {
        const line = gen.linearPath(
          [
            [x1, y1],
            [x2, y2],
          ],
          { ...roughOptions(color, undefined, undefined, seed), seed: seed + i }
        );
        const dAttr = gen.opsToPath((line.sets?.[0] ?? line) as never);
        parts.push({
          label,
          color,
          width: 2,
          points: samplePath(dAttr, 2),
          frames: t.edgeFrames,
          interval: t.edgeInterval,
        });
      });
      if (fill && fill !== NOS) {
        const filled = gen.rectangle(x, y, w, h, roughOptions(color, fill, el.fillStyle, seed + 100));
        const set = (filled.sets ?? []).find((s) => s.type === "fillSketch");
        if (set) {
          let current: Array<{ op: string; data: number[] }> = [];
          for (const op of set.ops) {
            if (op.op === "move" && current.length > 0) {
              const dAttr2 = gen.opsToPath({ type: "fillSketch", ops: current } as never);
              parts.push({ label: "涂色", color: fill, width: 1.4, points: samplePath(dAttr2, 3), frames: 1, interval: t.fillInterval });
              current = [];
            }
            current.push(op);
          }
          if (current.length) {
            const dAttr2 = gen.opsToPath({ type: "fillSketch", ops: current } as never);
            parts.push({ label: "涂色", color: fill, width: 1.4, points: samplePath(dAttr2, 3), frames: 1, interval: t.fillInterval });
          }
        }
      }
    } else {
      // 椭圆：上下两笔
      const cx = x + w / 2;
      const cy = y + h / 2;
      const arc1 = gen.arc(cx, cy, w, h, Math.PI, 2 * Math.PI, false, roughOptions(color, undefined, undefined, seed));
      const arc2 = gen.arc(cx, cy, w, h, 0, Math.PI, false, { ...roughOptions(color, undefined, undefined, seed), seed: seed + 1 });
      parts.push({ label, color, width: 2, points: samplePath(gen.opsToPath((arc1.sets?.[0] ?? arc1) as never), 1.5), frames: t.edgeFrames, interval: t.edgeInterval });
      parts.push({ label, color, width: 2, points: samplePath(gen.opsToPath((arc2.sets?.[0] ?? arc2) as never), 1.5), frames: t.edgeFrames, interval: t.edgeInterval });
      if (fill && fill !== NOS) {
        const filled = gen.ellipse(cx, cy, w, h, roughOptions(color, fill, el.fillStyle, seed + 100));
        const set = (filled.sets ?? []).find((s) => s.type === "fillSketch");
        if (set) {
          let current: Array<{ op: string; data: number[] }> = [];
          for (const op of set.ops) {
            if (op.op === "move" && current.length > 0) {
              parts.push({ label: "涂色", color: fill, width: 1.4, points: samplePath(gen.opsToPath({ type: "fillSketch", ops: current } as never), 3), frames: 1, interval: t.fillInterval });
              current = [];
            }
            current.push(op);
          }
          if (current.length) {
            parts.push({ label: "涂色", color: fill, width: 1.4, points: samplePath(gen.opsToPath({ type: "fillSketch", ops: current } as never), 3), frames: 1, interval: t.fillInterval });
          }
        }
      }
    }

    // 写字：汉字逐笔画（位图引擎），非汉字 fallback 用 opentype 字形路径
    if (el.text) {
      const size = el.textSize ?? 22;
      const cx = x + w / 2;
      const cy = boxTextCY(el, y, h, size);
      parts.push(...textRasterParts(el.text, cx, cy, size, el.color ?? "#263238", t));
    }
    return parts;
  }

  if (el.type === "line") {
    const line = gen.linearPath(
      [
        [el.x1, el.y1],
        [el.x2, el.y2],
      ],
      roughOptions(el.color, undefined, undefined, seed)
    );
    parts.push({
      label: "画线",
      color: el.color ?? "#37474f",
      width: 2,
      points: samplePath(gen.opsToPath((line.sets?.[0] ?? line) as never), 1.5),
      frames: t.edgeFrames,
      interval: t.edgeInterval,
    });
    return parts;
  }

  if (el.type === "arrow") {
    const color = el.color ?? "#37474f";
    const ang = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
    const len = Math.hypot(el.x2 - el.x1, el.y2 - el.y1);
    const headLen = Math.min(16, len / 2);
    const bx = el.x2 - headLen * Math.cos(ang - Math.PI / 6);
    const by = el.y2 - headLen * Math.sin(ang - Math.PI / 6);
    const cx = el.x2 - headLen * Math.cos(ang + Math.PI / 6);
    const cy = el.y2 - headLen * Math.sin(ang + Math.PI / 6);
    const line = gen.linearPath(
      [
        [el.x1, el.y1],
        [el.x2 - headLen * Math.cos(ang), el.y2 - headLen * Math.sin(ang)],
      ],
      roughOptions(color, undefined, undefined, seed)
    );
    parts.push({
      label: "连线",
      color,
      width: 2,
      points: samplePath(gen.opsToPath((line.sets?.[0] ?? line) as never), 1.5),
      frames: t.edgeFrames,
      interval: t.edgeInterval,
    });
    parts.push({
      label: "箭头",
      color,
      width: 2,
      points: [],
      frames: 2,
      interval: 30,
      triangle: [
        [el.x2, el.y2],
        [bx, by],
        [cx, cy],
      ],
    });
    if (el.text) {
      parts.push(...textRasterParts(el.text, (el.x1 + el.x2) / 2, (el.y1 + el.y2) / 2 - 8, 13, color, t));
    }
    return parts;
  }

  if (el.type === "text") {
    return textRasterParts(el.text, el.x, el.y, el.size ?? 16, el.color ?? "#263238", t);
  }

  const opts = roughOptions(el.color, el.fill, "hachure", seed);
  const drawn = gen.path(el.d, opts);
  parts.push({
    label: "画路径",
    color: el.color ?? "#37474f",
    width: 2,
    points: samplePath(gen.opsToPath((drawn.sets?.[0] ?? drawn) as never), 1.5),
    frames: t.edgeFrames,
    interval: t.edgeInterval,
  });
  return parts;
}

/** 文字 → 笔画片段：汉字逐笔画，非汉字字符用 opentype 字形路径 */
function textRasterParts(text: string, cx: number, cy: number, size: number, color: string, t: SpeedTiming): RasterPart[] {
  const parts: RasterPart[] = [];
  for (const seg of layoutSegments(text, cx, size)) {
    if (seg.kind === "hanzi") {
      const chars = Array.from(seg.text);
      const xs = hanziCharXs(seg.text, seg.cx, size);
      chars.forEach((c, i) => {
        const strokes = charStrokeParts(c, xs[i], cy, size, color);
        if (strokes) {
          strokes.forEach((sp) => {
            parts.push({
              label: `写 ${c}`,
              color,
              width: Math.max(1.6, size / 14),
              points: samplePath(extractPathD(sp.full), 1.5),
              frames: t.strokeFrames,
              interval: t.strokeInterval,
            });
          });
        }
      });
    } else {
      // 拉丁/符号：位图引擎无字体，用等宽占位线框
      parts.push({
        label: `写 ${seg.text}`,
        color,
        width: size / 10,
        points: samplePath(placeholderGlyph(seg.text[0] ?? " ", seg.cx, cy, seg.width / Math.max(1, seg.text.length)), 1.5),
        frames: 1,
        interval: 0,
      });
    }
  }
  return parts;
}

/** 非汉字字符占位字形（简单方块/线条），确保布局不塌陷 */
function placeholderGlyph(char: string, cx: number, cy: number, size: number): string {
  const half = size * 0.42;
  return `M ${cx - half} ${cy - half} L ${cx + half} ${cy - half} L ${cx + half} ${cy + half} L ${cx - half} ${cy + half} Z`;
}

/** 生成完整的书写脚本（标题 → 各元素逐笔画），供位图引擎播放 */
export function buildRasterScript(opts: BuildOptions, speed: AnimSpeed): RasterScript {
  const { elements, width, height } = layoutElements(opts);
  const t = SPEED[speed];
  const parts: RasterPart[] = [];

  if (opts.title) {
    parts.push(...textRasterParts(opts.title, width / 2, 22, 24, "#37474f", t));
  }
  for (const [i, el] of elements.entries()) {
    parts.push(...elementRasterParts(el, t, i));
  }
  return { width, height, background: opts.background, parts };
}

// ---------------------------------------------------------------------------
// 浏览器手写动画：生成自包含 HTML（CSS 动画逐笔画书写）
// ---------------------------------------------------------------------------

export interface HtmlStroke {
  /** SVG path 数据（或 text 元素内容） */
  d: string;
  /** path 变换（汉字笔画用） */
  transform?: string;
  color: string;
  width: number;
  dur: number;
  label: string;
  /** true = 是 text 元素（无轨迹字符 fallback 字体） */
  isText?: boolean;
  /** true = 填充斜线（合并为一笔整体快速生长，笔尖不跟随） */
  hatch?: boolean;
  /** 填充色（箭头尖淡色填充） */
  fillOnly?: string;
}

export interface HandwritingHtml {
  html: string;
  fileHint: string;
}

/** 文字 → 笔画记录（汉字逐笔画，拉丁/符号用真实手写字体整段淡入） */
function htmlTextStrokes(text: string, cx: number, cy: number, size: number, color: string, t: SpeedTiming): HtmlStroke[] {
  const strokes: HtmlStroke[] = [];
  for (const seg of layoutSegments(text, cx, size)) {
    // 纯空白段只占位，不产生笔画（否则每个空格白等 0.4s）
    if (seg.text.trim() === "") continue;
    if (seg.kind === "hanzi") {
      // 汉字逐笔画（段内逐字排开，避免重叠）
      const chars = Array.from(seg.text);
      const xs = hanziCharXs(seg.text, seg.cx, size);
      chars.forEach((c, i) => {
        const info = charDrawInfo(c, xs[i], cy, size);
        info.strokes?.forEach(({ d }) => {
          strokes.push({ d, color, width: Math.max(1.6, size / 14), dur: (t.strokeFrames * t.strokeInterval) / 1000, label: `写 ${c}` });
        });
      });
    } else {
      // 拉丁/符号段：手写字体整体渲染（画布端做从左到右的擦除式显出，像被笔带出来）
      strokes.push({
        d: `<text x="${seg.cx.toFixed(1)}" y="${(cy + size * 0.22).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="${LATIN_FONT}" font-size="${size}" fill="${color}">${esc(seg.text)}</text>`,
        color,
        width: 1,
        dur: Math.min(1.2, 0.35 + seg.text.length * 0.06),
        label: `写 ${seg.text}`,
        isText: true,
      });
    }
  }
  return strokes;
}

/** 段落文字 → 笔画记录：逐行自上而下（x,y 为段落左上角），行内对齐 */
function htmlParagraphStrokes(el: TextElement, size: number, color: string, t: SpeedTiming): HtmlStroke[] {
  const layout = layoutParagraph(el.text, size, el.w, el.lineHeight ?? 1.6);
  const align = el.align ?? "left";
  const boxW = el.w ?? layout.width;
  const strokes: HtmlStroke[] = [];
  layout.lines.forEach((line, i) => {
    if (line.trim() === "") return; // 空行只占行高
    const lineW = measureText(line, size);
    const cy = el.y + layout.lineHeightPx * (i + 0.5);
    let cx: number;
    if (align === "center") cx = el.x + boxW / 2;
    else if (align === "right") cx = el.x + boxW - lineW / 2;
    else cx = el.x + lineW / 2;
    strokes.push(...htmlTextStrokes(line, cx, cy, size, color, t));
  });
  return strokes;
}

/** rough 填充斜线：合并成一笔（整体快速生长；逐根线画太拖节奏） */
function htmlFillStrokes(drawable: unknown, fillColor: string, t: SpeedTiming): HtmlStroke[] {
  const d = drawable as { sets?: Array<{ type: string; ops: Array<{ op: string; data: number[] }> }> };
  const set = d.sets?.find((s) => s.type === "fillSketch");
  if (!set) return [];
  return [
    {
      d: gen.opsToPath({ type: "fillSketch", ops: set.ops } as never),
      color: fillColor,
      width: 1.3,
      dur: 0.35,
      label: "涂色",
      hatch: true,
    },
  ];
}

/** 生成自包含手写动画 HTML */
export function buildStrokeSequence(
  opts: BuildOptions,
  speed: AnimSpeed
): { strokes: HtmlStroke[]; width: number; height: number } {
  const { elements, width, height } = layoutElements(opts);
  const t = SPEED[speed];
  const strokes: HtmlStroke[] = [];

  if (opts.title) {
    strokes.push(...htmlTextStrokes(opts.title, width / 2, 22, 24, "#37474f", t));
  }

  const seed = 1;
  const push = (s: HtmlStroke) => strokes.push(s);
  const roughEdge = (x1: number, y1: number, x2: number, y2: number, color: string, label: string, sd: number, t2: SpeedTiming) => {
    const line = gen.linearPath(
      [
        [x1, y1],
        [x2, y2],
      ],
      { ...roughOptions(color, undefined, undefined, seed), seed: sd }
    );
    push({ d: gen.opsToPath((line.sets?.[0] ?? line) as never), color, width: 2, dur: (t2.edgeFrames * t2.edgeInterval) / 1000, label });
  };

  for (const [ei, el] of elements.entries()) {
    const sd = seed + ei * 37;
    if (el.type === "box" || el.type === "ellipse" || el.type === "diamond") {
      const x = el.x ?? 0;
      const y = el.y ?? 0;
      const w = el.w ?? 160;
      const h = el.h ?? 70;
      const color = el.color ?? "#37474f";
      const label = el.type === "box" ? "画框" : el.type === "ellipse" ? "画椭圆" : "画菱形";
      if (el.type === "box") {
        roughEdge(x, y, x + w, y, color, label, sd, t);
        roughEdge(x + w, y, x + w, y + h, color, label, sd + 1, t);
        roughEdge(x + w, y + h, x, y + h, color, label, sd + 2, t);
        roughEdge(x, y + h, x, y, color, label, sd + 3, t);
        if (el.fill) strokes.push(...htmlFillStrokes(gen.rectangle(x, y, w, h, roughOptions(color, el.fill, el.fillStyle, sd + 100)), el.fill, t));
      } else if (el.type === "diamond") {
        const cx = x + w / 2;
        const cy = y + h / 2;
        roughEdge(cx, y, x + w, cy, color, label, sd, t);
        roughEdge(x + w, cy, cx, y + h, color, label, sd + 1, t);
        roughEdge(cx, y + h, x, cy, color, label, sd + 2, t);
        roughEdge(x, cy, cx, y, color, label, sd + 3, t);
        if (el.fill) strokes.push(...htmlFillStrokes(gen.rectangle(x, y, w, h, roughOptions(color, el.fill, el.fillStyle, sd + 100)), el.fill, t));
      } else {
        const cx = x + w / 2;
        const cy = y + h / 2;
        const a1 = gen.arc(cx, cy, w, h, Math.PI, 2 * Math.PI, false, roughOptions(color, undefined, undefined, sd));
        const a2 = gen.arc(cx, cy, w, h, 0, Math.PI, false, { ...roughOptions(color, undefined, undefined, sd), seed: sd + 1 });
        push({ d: gen.opsToPath((a1.sets?.[0] ?? a1) as never), color, width: 2, dur: (t.edgeFrames * t.edgeInterval) / 1000, label });
        push({ d: gen.opsToPath((a2.sets?.[0] ?? a2) as never), color, width: 2, dur: (t.edgeFrames * t.edgeInterval) / 1000, label });
        if (el.fill) strokes.push(...htmlFillStrokes(gen.ellipse(cx, cy, w, h, roughOptions(color, el.fill, el.fillStyle, sd + 100)), el.fill, t));
      }
      if (el.text) {
        // 文字超出盒子时自动缩小字号；textPosition="top" 时贴框内顶部（容器标题）
        const size = fitTextSize(el.text, w, h, el.textSize ?? 22);
        strokes.push(...htmlTextStrokes(el.text, x + w / 2, boxTextCY(el, y, h, size), size, el.color ?? "#263238", t));
      }
    } else if (el.type === "line") {
      const line = gen.linearPath(
        [
          [el.x1, el.y1],
          [el.x2, el.y2],
        ],
        roughOptions(el.color, undefined, undefined, sd)
      );
      push({ d: gen.opsToPath((line.sets?.[0] ?? line) as never), color: el.color ?? "#37474f", width: 2, dur: (t.edgeFrames * t.edgeInterval) / 1000, label: "画线" });
    } else if (el.type === "arrow") {
      const color = el.color ?? "#37474f";
      const ang = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
      const len = Math.hypot(el.x2 - el.x1, el.y2 - el.y1);
      const headLen = Math.min(20, len / 3);
      const bx = el.x2 - headLen * Math.cos(ang - Math.PI / 6);
      const by = el.y2 - headLen * Math.sin(ang - Math.PI / 6);
      const cxp = el.x2 - headLen * Math.cos(ang + Math.PI / 6);
      const cyp = el.y2 - headLen * Math.sin(ang + Math.PI / 6);
      const line = gen.linearPath(
        [
          [el.x1, el.y1],
          [el.x2 - headLen * 0.7 * Math.cos(ang), el.y2 - headLen * 0.7 * Math.sin(ang)],
        ],
        roughOptions(color, undefined, undefined, sd)
      );
      push({ d: gen.opsToPath((line.sets?.[0] ?? line) as never), color, width: 2, dur: (t.edgeFrames * t.edgeInterval) / 1000, label: "连线" });
      // 箭头尖：三条边逐笔手画 + 快速填充
      const tip = [el.x2, el.y2] as const;
      const left = [bx, by] as const;
      const right = [cxp, cyp] as const;
      const edge = (a: readonly [number, number], b: readonly [number, number], lbl: string) => {
        const l = gen.linearPath([[a[0], a[1]], [b[0], b[1]]], roughOptions(color, undefined, undefined, sd + 1));
        push({ d: gen.opsToPath((l.sets?.[0] ?? l) as never), color, width: 2, dur: 0.1, label: lbl });
      };
      edge(tip, left, "箭头");
      edge(left, right, "箭头");
      edge(right, tip, "箭头");
      // 淡色填充箭头尖
      push({
        d: gen.opsToPath((gen.polygon([[el.x2, el.y2], [bx, by], [cxp, cyp]], { ...roughOptions(color, color, "solid", sd + 2), fillWeight: 1 })).sets?.[0] ?? "") as string,
        color: undefined as unknown as string,
        width: 0,
        dur: 0.3,
        label: "箭头",
        fillOnly: color,
      });
      if (el.text) {
        strokes.push(...htmlTextStrokes(el.text, (el.x1 + el.x2) / 2, (el.y1 + el.y2) / 2 - 8, 13, color, t));
      }
    } else if (el.type === "text") {
      const size = el.size ?? 16;
      const color = el.color ?? "#263238";
      if (el.text.includes("\n") || el.w) {
        strokes.push(...htmlParagraphStrokes(el, size, color, t));
      } else {
        strokes.push(...htmlTextStrokes(el.text, el.x, el.y, size, color, t));
      }
    } else if (el.type === "sticker") {
      const st = STICKERS[el.name];
      if (!st) continue; // core 已校验并提示未知贴纸，这里兜底跳过
      const size = el.size ?? 80;
      const k = size / 100;
      st.strokes.forEach((ss, si) => {
        const pts = ss.points.map(([px, py]) => [el.x + px * k, el.y + py * k] as [number, number]);
        const color = el.color ?? ss.color ?? "#37474f";
        const opt = roughOptions(color, ss.fill, ss.fill ? "solid" : undefined, sd + si * 7);
        const drawn = ss.closed ? gen.polygon(pts, opt) : ss.smooth === false ? gen.linearPath(pts, opt) : gen.curve(pts, opt);
        const sets = (drawn as { sets?: Array<{ type: string }> }).sets ?? [];
        const strokeSet = sets.find((s2) => s2.type === "path") ?? sets[0];
        if (strokeSet) {
          push({ d: gen.opsToPath(strokeSet as never), color, width: 2, dur: (t.edgeFrames * t.edgeInterval) / 1000, label: `贴纸 ${el.name}` });
        }
        if (ss.fill) strokes.push(...htmlFillStrokes(drawn, ss.fill, t));
      });
    } else {
      const drawn = gen.path(el.d, roughOptions(el.color, el.fill, "hachure", sd));
      push({ d: gen.opsToPath((drawn.sets?.[0] ?? drawn) as never), color: el.color ?? "#37474f", width: 2, dur: (t.edgeFrames * t.edgeInterval) / 1000, label: "画路径" });
    }
  }
  return { strokes, width, height };
}

export function buildHandwritingHtml(opts: BuildOptions, speed: AnimSpeed): HandwritingHtml {
  const { strokes, width, height } = buildStrokeSequence(opts, speed);
  const labels: Array<{ label: string; time: number }> = [];
  // 计算每笔画的长度、延迟、总时长
  let totalTime = 0;
  const strokeDefs = strokes.map((s) => {
    let len = 0;
    let isText = false;
    let fillOnly: string | undefined;
    if (s.isText) {
      isText = true;
    } else if (s.fillOnly) {
      fillOnly = s.fillOnly;
    } else {
      len = new svgPathProperties(s.d).getTotalLength();
    }
    const delay = totalTime;
    totalTime += s.dur;
    labels.push({ label: s.label, time: delay });
    return {
      d: s.d,
      transform: s.transform ?? "",
      color: s.color,
      width: s.width,
      len: Math.round(len * 100) / 100,
      dur: s.dur,
      delay,
      label: s.label,
      isText,
      fillOnly,
    };
  });
  totalTime += 0.5; // 收尾

  const paths = strokeDefs
    .map((s, i) => {
      if (s.isText) {
        // 无轨迹字符：字体渲染（浏览器系统字体）
        return `<g class="textfallback" style="opacity:0;animation:fadein ${s.dur}s ease ${s.delay.toFixed(3)}s forwards">${s.d}</g>`;
      }
      if (s.fillOnly) {
        // 填充图形（箭头尖）
        return `<path d="${s.d}" fill="${s.fillOnly}" stroke="none" style="opacity:0;animation:fadein ${s.dur}s ease ${s.delay.toFixed(3)}s forwards"/>`;
      }
      return (
        `<path class="stroke" d="${s.d}"${s.transform ? ` transform="${s.transform}"` : ""} ` +
        `stroke="${s.color}" stroke-width="${s.width}" ` +
        `style="--len:${s.len}px;--dur:${s.dur}s;--delay:${s.delay.toFixed(3)}s;animation-delay:${s.delay.toFixed(3)}s"/>`
      );
    })
    .join("\n    ");

  const labelJs = JSON.stringify(labels);

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>✏️ ${opts.title ?? "手绘图"}</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    font-family: -apple-system, "PingFang SC", sans-serif;
  }
  /* 画布占满整个浏览器窗口 */
  .stage {
    position: relative;
    width: 100vw; height: 100vh;
    background: #fdf6e3;
    overflow: hidden;
  }
  svg {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    cursor: grab; touch-action: none;
  }
  .stroke {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: var(--len);
    stroke-dashoffset: var(--len);
    animation: draw var(--dur) ease-out forwards;
  }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes fadein { to { opacity: 1; } }
  /* 悬浮进度条（顶部） */
  .toast {
    position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
    background: rgba(253, 246, 227, 0.94);
    border: 1.5px solid #d5c9a8;
    border-radius: 999px;
    padding: 6px 18px;
    font-size: 14px; color: #7d7461;
    display: flex; gap: 14px; align-items: center;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12);
    z-index: 10; user-select: none;
  }
  .toast .label { color: #b4562c; font-weight: 600; }
  /* 悬浮控制栏（底部） */
  .controls {
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    background: rgba(253, 246, 227, 0.94);
    border: 1.5px solid #d5c9a8;
    border-radius: 999px;
    padding: 6px 10px;
    display: flex; gap: 6px; align-items: center;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12);
    z-index: 10; user-select: none;
  }
  button:hover { background: #f3ecd9; }
</style>
</head>
<body>
<div class="stage">
  <svg id="canvas" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
    <rect width="${width}" height="${height}" fill="${opts.background ?? "#fdf6e3"}" rx="6"/>
    ${paths}
  </svg>
  <div class="toast">
    <span class="label" id="curLabel">准备开始…</span>
    <span id="progress">0/${strokeDefs.length}</span>
  </div>
  <div class="controls">
    <button onclick="location.reload()">↻ 重播</button>
    <button onclick="zoom(1/1.3)">−</button>
    <button onclick="zoom(1.3)">+</button>
    <button onclick="resetView()">适应</button>
    <span style="color:#a89d85">滚轮缩放 · 拖拽平移 · ${strokeDefs.length} 笔</span>
  </div>
</div>
<script>
const svg = document.getElementById("canvas");
// 无限画布：滚轮缩放 + 拖拽平移
let vb = { x: 0, y: 0, w: ${width}, h: ${height} };
function applyView() {
  svg.setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
}
function zoom(f) {
  const r = svg.getBoundingClientRect();
  const cx = vb.x + (r.width / 2) * (vb.w / r.width);
  const cy = vb.y + (r.height / 2) * (vb.h / r.height);
  const nw = vb.w * f, nh = vb.h * f;
  if (nw < 50 || nw > ${Math.max(width, height)} * 40) return;
  vb.x = cx - (r.width / 2) * (nw / r.width);
  vb.y = cy - (r.height / 2) * (nh / r.height);
  vb.w = nw; vb.h = nh;
  applyView();
}
function resetView() {
  const r = svg.getBoundingClientRect();
  const W = ${width}, H = ${height};
  const ratio = r.width / r.height;
  let w = W, h = H;
  if (W / H > ratio) { h = H; w = H * ratio; }
  else { w = W; h = W / ratio; }
  vb = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  applyView();
}
let drag = null;
svg.addEventListener("mousedown", (e) => {
  drag = { sx: e.clientX, sy: e.clientY, vx: vb.x, vy: vb.y };
  svg.style.cursor = "grabbing";
});
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const r = svg.getBoundingClientRect();
  vb.x = drag.vx - ((e.clientX - drag.sx) * vb.w) / r.width;
  vb.y = drag.vy - ((e.clientY - drag.sy) * vb.h) / r.height;
  applyView();
});
window.addEventListener("mouseup", () => { drag = null; svg.style.cursor = ""; });
svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const fx = vb.x + (mx * vb.w) / r.width;
  const fy = vb.y + (my * vb.h) / r.height;
  const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
  const nw = vb.w * f, nh = vb.h * f;
  if (nw < 50 || nw > ${Math.max(width, height)} * 40) return;
  vb.x = fx - (mx * nw) / r.width;
  vb.y = fy - (my * nh) / r.height;
  vb.w = nw; vb.h = nh;
  applyView();
}, { passive: false });
applyView();
const parts = ${labelJs};
const total = ${strokeDefs.length};
const durTotal = ${totalTime};
const labelEl = document.getElementById("curLabel");
const progEl = document.getElementById("progress");
let pi = 0;
function tick() {
  const t = performance.now() / 1000;
  while (pi < parts.length - 1 && t >= parts[pi + 1].time) pi++;
  if (pi < parts.length) labelEl.textContent = "✏️ " + parts[pi].label;
  progEl.textContent = pi + 1 + "/" + total;
  if (t < durTotal) requestAnimationFrame(tick);
  else { labelEl.textContent = "✅ 完成"; progEl.textContent = total + "/" + total; }
}
setTimeout(() => requestAnimationFrame(tick), 200);
</script>
</body>
</html>`;

  return { html, fileHint: `${strokeDefs.length} 笔，动画 ${totalTime.toFixed(1)}s` };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function buildSvg(opts: BuildOptions): string {
  const { elements, width, height } = layoutElements(opts);

  const parts: string[] = [];

  if (opts.title && (opts.layout === "flow" || opts.showTitle)) {
    parts.push(textSvg(width / 2, 22, opts.title, 24, "#37474f", "middle"));
  }

  elements.forEach((el, i) => {
    parts.push(renderElement(el, seedFor(i + 1)));
  });

  const bg =
    opts.background && opts.background !== "transparent"
      ? `<rect width="${width}" height="${height}" fill="${opts.background}"/>`
      : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    bg +
    parts.join("") +
    `</svg>`
  );
}
