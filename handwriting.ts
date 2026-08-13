/**
 * handwriting.ts — 汉字笔画书写引擎
 *
 * 用开源汉字笔画顺序数据（hanzi-writer-data / Make Me a Hanzi），
 * 把文字变成"按笔画顺序逐笔书写"的 SVG 片段序列，模拟人用笔写字。
 * 每个笔画用 stroke-dasharray 生长动画，从起笔写到收笔。
 */
import { svgPathProperties } from "svg-path-properties";

// ---------------------------------------------------------------------------
// 数据加载与缓存
// ---------------------------------------------------------------------------

interface CharData {
  strokes: string[];
  medians: number[][][];
}

const charDataCache = new Map<string, CharData | null>();
const charBBoxCache = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();

/** 加载单个汉字的笔画数据；无数据（非汉字/生僻字）返回 null */
export function getCharData(char: string): CharData | null {
  if (charDataCache.has(char)) return charDataCache.get(char) ?? null;
  try {
    // hanzi-writer-data 按字加载：require('hanzi-writer-data/登')
    const d = (require(`hanzi-writer-data/${char}`) as CharData) ?? null;
    charDataCache.set(char, d);
    return d;
  } catch {
    charDataCache.set(char, null);
    return null;
  }
}

/** 采样计算字形包围盒（hanzi-writer-data 坐标单位约 1024 高） */
function charBBox(char: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const cached = charBBoxCache.get(char);
  if (cached) return cached;
  const data = getCharData(char);
  if (!data) return null;
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const path of data.strokes) {
    const props = new svgPathProperties(path);
    const len = props.getTotalLength();
    for (let t = 0; t <= 1; t += 0.05) {
      const p = props.getPointAtLength(len * t);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const box = { minX, minY, maxX, maxY };
  charBBoxCache.set(char, box);
  return box;
}

// ---------------------------------------------------------------------------
// 笔画书写片段
// ---------------------------------------------------------------------------

export interface StrokePart {
  /** 该笔画书写到 progress(0..1) 时输出的 SVG path 片段 */
  render: (progress: number) => string;
  /** 笔画完整时的路径 */
  full: string;
}

/**
 * 生成一个汉字的逐笔画书写片段序列。
 * @param char 汉字
 * @param cx 字中心 x
 * @param cy 字中心 y
 * @param size 字高（px）
 */
export function charStrokeParts(char: string, cx: number, cy: number, size: number, color = "#263238"): StrokePart[] | null {
  const data = getCharData(char);
  const box = charBBox(char);
  if (!data || !data.medians || data.medians.length === 0 || !box) {
    // 拉丁字符：手写轨迹
    const latin = latinStrokePaths(char, cx, cy, size);
    if (latin) {
      const sw = Math.max(1.6, size / 14);
      return latin.map((s) => {
        let length = -1;
        return {
          full: `<path d="${s.d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`,
          render: (progress: number) => {
            if (progress >= 1) return `<path d="${s.d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
            if (length < 0) length = new svgPathProperties(s.d).getTotalLength();
            const shown = length * Math.min(1, Math.max(0, progress));
            return `<path d="${s.d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${(length - shown).toFixed(1)}"/>`;
          },
        };
      });
    }
    return null;
  }

  const cw = box.maxX - box.minX;
  const ch = box.maxY - box.minY;
  const scale = (size / Math.max(cw, ch)) * 0.95;
  const tx = cx - (box.minX + cw / 2) * scale;
  const ty = cy - (box.minY + ch / 2) * scale;
  const sw = Math.max(1.6, size / 14);

  return data.medians.map((median) => {
    // 运笔轨迹：y 向上 → 向下转换 + 缩放平移（起点 = 落笔点，方向正确）
    const path = medianStrokePath(median, scale, tx, ty, size);
    const stroke = (dash: string) =>
      `<path d="${path}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
    let length = -1;
    return {
      full: stroke(""),
      render: (progress: number) => {
        if (progress >= 1) return stroke("");
        if (length < 0) {
          length = new svgPathProperties(path).getTotalLength();
        }
        const shown = length * Math.min(1, Math.max(0, progress));
        return stroke(` stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${(length - shown).toFixed(1)}"`);
      },
    };
  });
}

/** 判断该字符是否有笔画数据（否则走普通文字渲染） */
export function hasCharStrokes(char: string): boolean {
  return getCharData(char) !== null;
}

/** 判断一段文字是否全部有笔画数据 */
export function isAllHanziStrokes(text: string): boolean {
  if (!text) return false;
  const chars = Array.from(text);
  // 汉字范围 U+4E00–U+9FFF，且必须有笔画数据
  return chars.every((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code >= 0x4e00 && code <= 0x9fff && getCharData(c) !== null;
  });
}

// ---------------------------------------------------------------------------
// 拉丁字母/数字手写轨迹库
// 手写运笔轨迹（1024 坐标系，y 向下，基线 y≈860），起点=落笔点。
// ---------------------------------------------------------------------------

export interface LatinChar {
  /** 笔画：每笔是运笔点序列 */
  strokes: number[][][];
  /** 宽度（相对字高 1.0） */
  width: number;
}

const LATIN: Record<string, LatinChar> = {
  // 大写
  A: { strokes: [[[200, 200], [500, 860]], [[500, 200], [800, 860]], [[340, 560], [660, 560]]], width: 0.82 },
  B: { strokes: [[[260, 200], [260, 860]], [[260, 200], [520, 200], [560, 380], [260, 540]], [[260, 540], [560, 540], [520, 860], [260, 860]]], width: 0.78 },
  C: { strokes: [[[520, 200], [240, 200], [240, 860], [520, 860]]], width: 0.76 },
  D: { strokes: [[[280, 200], [280, 860]], [[280, 200], [560, 200], [600, 530], [560, 860], [280, 860]]], width: 0.82 },
  E: { strokes: [[[280, 200], [280, 860]], [[280, 200], [700, 200]], [[280, 530], [620, 530]], [[280, 860], [700, 860]]], width: 0.76 },
  F: { strokes: [[[280, 200], [280, 860]], [[280, 200], [700, 200]], [[280, 530], [600, 530]]], width: 0.74 },
  G: { strokes: [[[520, 200], [260, 200], [260, 860], [520, 860]], [[520, 530], [720, 530], [720, 640]]], width: 0.82 },
  H: { strokes: [[[240, 200], [240, 860]], [[740, 200], [740, 860]], [[240, 530], [740, 530]]], width: 0.84 },
  I: { strokes: [[[500, 200], [500, 860]], [[380, 200], [620, 200]], [[380, 860], [620, 860]]], width: 0.5 },
  J: { strokes: [[[500, 200], [500, 740], [440, 860], [320, 860]], [[380, 200], [620, 200]]], width: 0.62 },
  K: { strokes: [[[260, 200], [260, 860]], [[260, 530], [700, 200]], [[260, 530], [700, 860]]], width: 0.78 },
  L: { strokes: [[[280, 200], [280, 860]], [[280, 860], [720, 860]]], width: 0.74 },
  M: { strokes: [[[180, 860], [180, 200]], [[180, 200], [500, 860]], [[500, 860], [820, 200]], [[820, 200], [820, 860]]], width: 1.0 },
  N: { strokes: [[[220, 860], [220, 200]], [[220, 200], [740, 860]], [[740, 860], [740, 200]]], width: 0.88 },
  O: { strokes: [[[260, 200], [260, 860], [700, 860], [700, 200], [260, 200]]], width: 0.82 },
  P: { strokes: [[[280, 200], [280, 860]], [[280, 200], [520, 200], [560, 380], [280, 540]]], width: 0.74 },
  Q: { strokes: [[[260, 200], [260, 860], [700, 860], [700, 200], [260, 200]], [[600, 700], [760, 860]]], width: 0.84 },
  R: { strokes: [[[280, 200], [280, 860]], [[280, 200], [520, 200], [560, 380], [280, 540]], [[280, 540], [700, 860]]], width: 0.8 },
  S: { strokes: [[[560, 200], [280, 200], [280, 380], [560, 530], [560, 680], [280, 860]]], width: 0.72 },
  T: { strokes: [[[240, 200], [760, 200]], [[500, 200], [500, 860]]], width: 0.76 },
  U: { strokes: [[[240, 200], [240, 740], [500, 860], [740, 740], [740, 200]]], width: 0.82 },
  V: { strokes: [[[200, 200], [500, 860]], [[500, 860], [800, 200]]], width: 0.78 },
  W: { strokes: [[[160, 200], [340, 860], [500, 200], [660, 860], [840, 200]]], width: 1.0 },
  X: { strokes: [[[220, 200], [760, 860]], [[760, 200], [220, 860]]], width: 0.8 },
  Y: { strokes: [[[220, 200], [500, 530]], [[780, 200], [500, 530]], [[500, 530], [500, 860]]], width: 0.78 },
  Z: { strokes: [[[220, 200], [780, 200]], [[780, 200], [220, 860]], [[220, 860], [780, 860]]], width: 0.78 },
  // 小写
  a: { strokes: [[[420, 520], [420, 700], [560, 860], [700, 700], [700, 520]], [[700, 520], [700, 860]]], width: 0.74 },
  b: { strokes: [[[320, 180], [320, 860]], [[320, 560], [560, 560], [560, 860], [320, 860]]], width: 0.74 },
  c: { strokes: [[[560, 520], [360, 520], [360, 860], [560, 860]]], width: 0.66 },
  d: { strokes: [[[560, 560], [360, 560], [360, 860], [560, 860]], [[560, 180], [560, 860]]], width: 0.74 },
  e: { strokes: [[[560, 640], [360, 640], [360, 720], [560, 720], [560, 860], [360, 860]]], width: 0.7 },
  f: { strokes: [[[440, 180], [440, 700], [380, 860], [280, 860]], [[400, 380], [600, 380]]], width: 0.56 },
  g: { strokes: [[[520, 520], [340, 520], [340, 860], [520, 860]], [[520, 520], [520, 700], [460, 860], [340, 860]]], width: 0.72 },
  h: { strokes: [[[300, 180], [300, 860]], [[300, 560], [540, 560], [540, 860]]], width: 0.74 },
  i: { strokes: [[[480, 520], [480, 860]], [[480, 300], [480, 340]]], width: 0.4 },
  j: { strokes: [[[500, 520], [500, 760], [460, 860], [360, 860]], [[500, 300], [500, 340]]], width: 0.44 },
  k: { strokes: [[[300, 520], [300, 860]], [[300, 650], [600, 520]], [[300, 650], [600, 860]]], width: 0.68 },
  l: { strokes: [[[420, 180], [420, 860]]], width: 0.42 },
  m: { strokes: [[[320, 520], [320, 760], [420, 860], [520, 760], [520, 520]], [[520, 520], [520, 760], [620, 860], [720, 760], [720, 520]], [[720, 520], [720, 860]]], width: 0.92 },
  n: { strokes: [[[320, 520], [320, 760], [420, 860], [540, 760], [540, 520]], [[540, 520], [540, 860]]], width: 0.72 },
  o: { strokes: [[[360, 520], [360, 860], [620, 860], [620, 520], [360, 520]]], width: 0.7 },
  p: { strokes: [[[360, 520], [360, 1024]], [[360, 560], [560, 560], [560, 860], [360, 860]]], width: 0.72 },
  q: { strokes: [[[560, 560], [360, 560], [360, 860], [560, 860]], [[560, 520], [560, 1024]]], width: 0.72 },
  r: { strokes: [[[320, 520], [320, 860]], [[320, 520], [440, 520], [480, 620]]], width: 0.56 },
  s: { strokes: [[[520, 520], [360, 520], [360, 640], [520, 680], [520, 800], [360, 860]]], width: 0.62 },
  t: { strokes: [[[440, 280], [440, 860]], [[380, 520], [560, 520]]], width: 0.54 },
  u: { strokes: [[[320, 520], [320, 760], [440, 860], [560, 760], [560, 520]], [[560, 520], [560, 860]]], width: 0.72 },
  v: { strokes: [[[320, 520], [440, 860]], [[440, 860], [580, 520]]], width: 0.66 },
  w: { strokes: [[[320, 520], [400, 860], [480, 520], [560, 860], [640, 520]]], width: 0.82 },
  x: { strokes: [[[340, 520], [580, 860]], [[580, 520], [340, 860]]], width: 0.66 },
  y: { strokes: [[[320, 520], [460, 860]], [[460, 860], [600, 520], [600, 700], [560, 860], [460, 940]]], width: 0.7 },
  z: { strokes: [[[320, 520], [580, 520]], [[580, 520], [320, 860]], [[320, 860], [580, 860]]], width: 0.68 },
  // 数字
  "0": { strokes: [[[320, 520], [320, 860], [600, 860], [600, 520], [320, 520]]], width: 0.7 },
  "1": { strokes: [[[400, 300], [480, 200], [480, 860]]], width: 0.5 },
  "2": { strokes: [[[560, 520], [360, 520], [360, 600], [560, 860], [320, 860]]], width: 0.7 },
  "3": { strokes: [[[560, 520], [360, 520], [360, 660], [560, 690], [560, 860], [360, 860]]], width: 0.68 },
  "4": { strokes: [[[360, 300], [360, 680], [620, 680], [620, 200]], [[620, 680], [620, 860]]], width: 0.68 },
  "5": { strokes: [[[360, 520], [600, 520], [600, 600]], [[600, 600], [360, 600], [360, 860], [600, 860]]], width: 0.68 },
  "6": { strokes: [[[560, 560], [560, 700], [420, 860], [320, 860], [320, 700], [560, 700]]], width: 0.68 },
  "7": { strokes: [[[320, 520], [600, 520]], [[600, 520], [400, 860]]], width: 0.66 },
  "8": { strokes: [[[360, 520], [360, 680], [560, 680], [560, 520], [360, 520]], [[360, 680], [360, 860], [560, 860], [560, 680], [360, 680]]], width: 0.68 },
  "9": { strokes: [[[360, 560], [360, 700], [520, 860], [580, 860], [580, 680], [360, 680]]], width: 0.68 },
  // 符号
  "-": { strokes: [[[320, 680], [600, 680]]], width: 0.6 },
  _: { strokes: [[[300, 940], [620, 940]]], width: 0.6 },
  ".": { strokes: [[[490, 800], [510, 840]]], width: 0.3 },
  ",": { strokes: [[[500, 800], [490, 850], [450, 880]]], width: 0.3 },
  "?": { strokes: [[[500, 520], [380, 520], [380, 660], [500, 700]], [[500, 810], [500, 840]]], width: 0.62 },
  "!": { strokes: [[[500, 520], [500, 780]], [[500, 830], [500, 860]]], width: 0.4 },
  "/": { strokes: [[[320, 860], [600, 520]]], width: 0.6 },
  "\"": { strokes: [[[400, 420], [400, 520]], [[560, 420], [560, 520]]], width: 0.5 },
  "'": { strokes: [[[480, 420], [480, 520]]], width: 0.3 },
  ":": { strokes: [[[480, 580], [500, 620]], [[480, 790], [500, 830]]], width: 0.32 },
  ";": { strokes: [[[480, 580], [500, 620]], [[480, 790], [470, 840], [430, 860]]], width: 0.34 },
  "(": { strokes: [[[560, 520], [460, 520], [460, 860], [560, 860]]], width: 0.5 },
  ")": { strokes: [[[460, 520], [560, 520], [560, 860], [460, 860]]], width: 0.5 },
  "[": { strokes: [[[560, 500], [460, 500], [460, 880], [560, 880]]], width: 0.44 },
  "]": { strokes: [[[460, 500], [560, 500], [560, 880], [460, 880]]], width: 0.44 },
  "+": { strokes: [[[400, 680], [600, 680]], [[500, 580], [500, 780]]], width: 0.6 },
  "=": { strokes: [[[400, 640], [600, 640]], [[400, 760], [600, 760]]], width: 0.66 },
  ">": { strokes: [[[420, 600], [580, 700], [420, 800]]], width: 0.6 },
  "<": { strokes: [[[580, 600], [420, 700], [580, 800]]], width: 0.6 },
  "@": { strokes: [[[420, 520], [420, 860], [620, 860], [620, 620], [540, 620], [540, 760], [460, 760], [460, 700], [560, 700]]], width: 0.9 },
  "#": { strokes: [[[400, 520], [340, 860]], [[620, 520], [560, 860]], [[340, 640], [660, 640]], [[300, 760], [640, 760]]], width: 0.7 },
  "%": { strokes: [[[360, 520], [600, 860]], [[480, 620], [470, 600]], [[440, 780], [420, 760]]], width: 0.72 },
  "&": { strokes: [[[520, 860], [360, 700], [360, 640], [460, 560], [560, 640], [560, 700], [380, 860], [600, 860]]], width: 0.82 },
  "*": { strokes: [[[500, 560], [500, 760]], [[420, 620], [580, 700]], [[580, 620], [420, 700]]], width: 0.6 },
};

/** 拉丁字符是否有手写轨迹 */
export function hasLatinStrokes(char: string): boolean {
  return char in LATIN;
}

/** 字符绘制信息：笔画轨迹（无则字体 fallback）+ 布局宽度 */
export interface CharDrawInfo {
  strokes: CharStroke[] | null;
  width: number;
  kind: "hanzi" | "latin" | "fallback";
}

/** 统一获取字符的笔画与宽度（中文按笔顺、拉丁/其他用字体渲染） */
export function charDrawInfo(char: string, cx: number, cy: number, size: number): CharDrawInfo {
  const hanzi = charStrokePaths(char, cx, cy, size);
  if (hanzi) return { strokes: hanzi, width: size, kind: "hanzi" };
  if (hasLatinStrokes(char)) return { strokes: null, width: LATIN[char].width * size, kind: "latin" };
  return { strokes: null, width: size * 0.85, kind: "fallback" };
}

/**
 * 拉丁字符 → 手写笔画（运笔轨迹）。
 * 坐标系：1024 高，基线 y≈860。按每个字符内容中心垂直对齐（不挤、不偏移）。
 */
export function latinStrokePaths(char: string, cx: number, cy: number, size: number): CharStroke[] | null {
  const def = LATIN[char];
  if (!def) return null;
  const scale = size / 1024;
  const tx = cx;
  // 字符内容垂直中心（所有笔画点的 y 范围中心）→ 对齐 cy
  const allY = def.strokes.flatMap((s) => s.map((p) => p[1]));
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);
  const centerY = (minY + maxY) / 2;
  const ty = cy - centerY * scale;
  return def.strokes.map((median) => {
    const pts: Array<[number, number]> = median.map(([x, y]) => [x * scale + tx, y * scale + ty]);
    return { d: medianPointsToPath(pts, size), transform: "" };
  });
}

/** 点序列 → Catmull-Rom 平滑贝塞尔 path */
function medianPointsToPath(pts: Array<[number, number]>, size: number): string {
  if (pts.length < 2) return "";
  const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d;
}

// ---------------------------------------------------------------------------
// 结构化笔画数据（供浏览器 HTML 动画使用）
// ---------------------------------------------------------------------------

export interface CharStroke {
  /** SVG path 数据（已变换到布局坐标系） */
  d: string;
  /** 变换：translate(tx,ty) scale(s) */
  transform: string;
}

/**
 * 把 SVG path 的所有坐标应用变换（绝对/相对命令都支持）。
 * 关键：让汉字笔画直接处于布局坐标系，stroke-width 才不会被 transform 缩放。
 */
function transformPath(d: string, scale: number, tx: number, ty: number): string {
  const tokens = d.match(/[MmLlCcQqTtSsAaHhVvZz]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
  let out = "";
  let cx = 0;
  let cy = 0; // 当前点（用于相对命令）
  let sx = 0;
  let sy = 0; // 子路径起点（Z 用）
  let i = 0;
  const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
  while (i < tokens.length) {
    const tok = tokens[i++];
    if (/^[a-zA-Z]$/.test(tok)) {
      out += tok;
      if (tok === "Z" || tok === "z") {
        cx = sx;
        cy = sy;
      }
      continue;
    }
    // 数字：属于上一个命令（隐式重复命令）
    const nums: number[] = [parseFloat(tok)];
    while (i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) {
      nums.push(parseFloat(tokens[i++]));
    }
    const cmd = out.match(/[a-zA-Z][^a-zA-Z]*$/)?.[0][0] ?? "L";
    const abs = cmd === cmd.toUpperCase();
    const C = cmd.toUpperCase();
    let j = 0;
    // 处理完所有参数组（隐式重复命令）
    while (j < nums.length) {
      const group = (n: number): number[] => {
        const g = nums.slice(j, j + n);
        j += n;
        return g;
      };
      if (C === "M" || C === "L") {
        const [x, y] = group(2);
        const ax = abs ? x : cx + x;
        const ay = abs ? y : cy + y;
        const px = ax * scale + tx;
        const py = ay * scale + ty;
        out += ` ${fmt(px)} ${fmt(py)}`;
        if (C === "M") {
          sx = px;
          sy = py;
        }
        cx = ax;
        cy = ay;
      } else if (C === "H") {
        const [x] = group(1);
        const ax = abs ? x : cx + x;
        out += ` ${fmt(ax * scale + tx)}`;
        cx = ax;
      } else if (C === "V") {
        const [y] = group(1);
        const ay = abs ? y : cy + y;
        out += ` ${fmt(ay * scale + ty)}`;
        cy = ay;
      } else if (C === "Q") {
        const [x1, y1, x, y] = group(4);
        const ax1 = abs ? x1 : cx + x1;
        const ay1 = abs ? y1 : cy + y1;
        const ax = abs ? x : cx + x;
        const ay = abs ? y : cy + y;
        out += ` ${fmt(ax1 * scale + tx)} ${fmt(ay1 * scale + ty)} ${fmt(ax * scale + tx)} ${fmt(ay * scale + ty)}`;
        cx = ax;
        cy = ay;
      } else if (C === "T") {
        const [x, y] = group(2);
        const ax = abs ? x : cx + x;
        const ay = abs ? y : cy + y;
        out += ` ${fmt(ax * scale + tx)} ${fmt(ay * scale + ty)}`;
        cx = ax;
        cy = ay;
      } else if (C === "C") {
        const [x1, y1, x2, y2, x, y] = group(6);
        const ax1 = abs ? x1 : cx + x1;
        const ay1 = abs ? y1 : cy + y1;
        const ax2 = abs ? x2 : cx + x2;
        const ay2 = abs ? y2 : cy + y2;
        const ax = abs ? x : cx + x;
        const ay = abs ? y : cy + y;
        out += ` ${fmt(ax1 * scale + tx)} ${fmt(ay1 * scale + ty)} ${fmt(ax2 * scale + tx)} ${fmt(ay2 * scale + ty)} ${fmt(ax * scale + tx)} ${fmt(ay * scale + ty)}`;
        cx = ax;
        cy = ay;
      } else if (C === "S") {
        const [x2, y2, x, y] = group(4);
        const ax2 = abs ? x2 : cx + x2;
        const ay2 = abs ? y2 : cy + y2;
        const ax = abs ? x : cx + x;
        const ay = abs ? y : cy + y;
        out += ` ${fmt(ax2 * scale + tx)} ${fmt(ay2 * scale + ty)} ${fmt(ax * scale + tx)} ${fmt(ay * scale + ty)}`;
        cx = ax;
        cy = ay;
      } else if (C === "A") {
        const [rx, ry, rot, large, sweep, x, y] = group(7);
        const ax = abs ? x : cx + x;
        const ay = abs ? y : cy + y;
        out += ` ${fmt(rx * scale)} ${fmt(ry * scale)} ${rot} ${large} ${sweep} ${fmt(ax * scale + tx)} ${fmt(ay * scale + ty)}`;
        cx = ax;
        cy = ay;
      } else {
        break;
      }
    }
  }
  return out;
}

/**
 * 用 medians（真实运笔轨迹）生成笔画路径。
 * medians 是笔尖移动的轨迹点（y 向上坐标系，与 strokes 的 y 向下相反），
 * 从落笔点开始 → dash 生长动画方向天然正确（像真的在写）。
 * 输出布局坐标系的平滑贝塞尔路径。
 */
function medianStrokePath(median: number[][], scale: number, tx: number, ty: number, size: number): string {
  // y 向上 → y 向下转换（1024 坐标系）
  const pts: Array<[number, number]> = median.map(([x, y]) => [x * scale + tx, (1024 - y) * scale + ty]);
  if (pts.length < 2) return "";
  // Catmull-Rom 平滑 → 三次贝塞尔
  const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  const sw = Math.max(1.6, size / 14);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    // Catmull-Rom → Bezier 控制点（tension 0.5）
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d;
}

/** 获取汉字的笔画序列（坐标已变换到布局坐标系，可直接用于 SVG）
 * 用 medians（真实运笔轨迹）生成 → 书写方向天然正确。
 */
export function charStrokePaths(char: string, cx: number, cy: number, size: number): CharStroke[] | null {
  const data = getCharData(char);
  const box = charBBox(char);
  if (!data || !data.medians || data.medians.length === 0) return null;
  if (!box) return null;
  const cw = box.maxX - box.minX;
  const ch = box.maxY - box.minY;
  const scale = (size / Math.max(cw, ch)) * 0.95;
  const tx = cx - (box.minX + cw / 2) * scale;
  const ty = cy - (box.minY + ch / 2) * scale;
  return data.medians.map((median) => ({
    d: medianStrokePath(median, scale, tx, ty, size),
    transform: "",
  }));
}
