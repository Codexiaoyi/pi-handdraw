/**
 * stickers.ts — 贴纸（涂鸦）库
 *
 * 每个贴纸 = 若干笔，每笔是一串归一化坐标点（0~100 的方框内，y 向下）。
 * 绘制时由 draw.ts 缩放到目标尺寸，并走 rough.js 生成手绘抖动，
 * 所以贴纸和别的元素风格一致。
 *
 * 加新贴纸：往 STICKERS 里加一项即可，status 会自动把名字告诉 AI。
 */

export interface StickerStroke {
  /** 归一化坐标点（0~100，y 向下） */
  points: Array<[number, number]>;
  /** 闭合（多边形，可填充）；默认 false = 开放曲线 */
  closed?: boolean;
  /** 填充色（仅 closed 有效） */
  fill?: string;
  /** 描边色（元素 color 可整体覆盖） */
  color?: string;
  /** false = 折线（默认平滑曲线） */
  smooth?: boolean;
}

export interface Sticker {
  /** 展示名（zh/en），status 里给 AI 看 */
  label: { zh: string; en: string };
  strokes: StickerStroke[];
}

// ---- 参数化点列助手 ----

/** 圆/椭圆一周 */
function ellipsePts(cx: number, cy: number, rx: number, ry: number, n = 28, a0 = 0, a1 = Math.PI * 2): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** 圆弧 */
function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, n = 16): Array<[number, number]> {
  return ellipsePts(cx, cy, r, r, n, a0, a1);
}

/** 波浪线（蒸汽、装饰） */
function wavePts(x0: number, y0: number, x1: number, y1: number, amp: number, waves: number, n = 20): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([x0 + (x1 - x0) * t + Math.sin(t * Math.PI * 2 * waves) * amp, y0 + (y1 - y0) * t]);
  }
  return pts;
}

export const STICKERS: Record<string, Sticker> = {
  star: {
    label: { zh: "五角星", en: "star" },
    strokes: [
      {
        closed: true,
        fill: "#f7dc6f",
        color: "#b7950b",
        smooth: false,
        points: Array.from({ length: 11 }, (_, i) => {
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const r = i % 2 === 0 ? 45 : 18;
          return [50 + r * Math.cos(a), 52 + r * Math.sin(a)] as [number, number];
        }),
      },
    ],
  },

  heart: {
    label: { zh: "爱心", en: "heart" },
    strokes: [
      {
        closed: true,
        fill: "#f5b7b1",
        color: "#c0392b",
        points: Array.from({ length: 41 }, (_, i) => {
          const t2 = (i / 40) * Math.PI * 2;
          // 经典心形参数方程，映射到 0~100
          const hx = 16 * Math.pow(Math.sin(t2), 3);
          const hy = 13 * Math.cos(t2) - 5 * Math.cos(2 * t2) - 2 * Math.cos(3 * t2) - Math.cos(4 * t2);
          return [50 + hx * 2.6, 48 - hy * 2.6] as [number, number];
        }),
      },
    ],
  },

  sun: {
    label: { zh: "太阳", en: "sun" },
    strokes: [
      { closed: true, fill: "#f9e79f", color: "#d4ac0d", points: ellipsePts(50, 50, 24, 24) },
      ...Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return {
          color: "#d4ac0d",
          points: [
            [50 + 32 * Math.cos(a), 50 + 32 * Math.sin(a)],
            [50 + 44 * Math.cos(a), 50 + 44 * Math.sin(a)],
          ] as Array<[number, number]>,
        };
      }),
    ],
  },

  cloud: {
    label: { zh: "云朵", en: "cloud" },
    strokes: [
      {
        closed: true,
        fill: "#d6eaf8",
        color: "#5d6d7e",
        points: [
          ...arcPts(32, 62, 14, Math.PI * 0.9, Math.PI * 1.9),
          ...arcPts(50, 48, 18, Math.PI * 1.05, Math.PI * 1.95),
          ...arcPts(68, 60, 13, Math.PI * 1.15, Math.PI * 0.35),
          [76, 72],
          [24, 72],
        ],
      },
    ],
  },

  flower: {
    label: { zh: "小花", en: "flower" },
    strokes: [
      ...Array.from({ length: 5 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
        const px = 50 + 22 * Math.cos(a);
        const py = 42 + 22 * Math.sin(a);
        return { closed: true, fill: "#f5b7b1", color: "#c0392b", points: ellipsePts(px, py, 13, 13, 18) };
      }),
      { closed: true, fill: "#f7dc6f", color: "#b7950b", points: ellipsePts(50, 42, 9, 9, 18) },
      { color: "#7d6608", points: wavePts(50, 54, 50, 92, 4, 1.5) },
      { color: "#7d6608", points: arcPts(58, 72, 10, -Math.PI * 0.5, Math.PI * 0.15) },
    ],
  },

  coffee: {
    label: { zh: "咖啡杯", en: "coffee cup" },
    strokes: [
      // 杯身（左下 → 左上 → 右上 → 右下 → 左下，一笔 U 形带回钩）
      { color: "#6e2c00", smooth: false, points: [[34, 82], [28, 40], [72, 40], [66, 82], [34, 82]] },
      // 杯把（右侧小半圆）
      { color: "#6e2c00", points: arcPts(74, 58, 10, -Math.PI * 0.42, Math.PI * 0.42) },
      // 液面
      { color: "#a04000", points: ellipsePts(50, 40, 19, 4.5, 20) },
      // 蒸汽两条
      { color: "#95a5a6", points: wavePts(42, 28, 42, 8, 5, 1.2) },
      { color: "#95a5a6", points: wavePts(56, 28, 56, 8, 5, 1.2) },
    ],
  },

  check: {
    label: { zh: "对勾", en: "check mark" },
    strokes: [{ color: "#27ae60", smooth: false, points: [[18, 52], [42, 76], [84, 24]] }],
  },

  music: {
    label: { zh: "音符", en: "music note" },
    strokes: [
      { closed: true, fill: "#37474f", color: "#37474f", points: ellipsePts(34, 76, 11, 8, 18) },
      { color: "#37474f", smooth: false, points: [[44, 72], [44, 22]] },
      { color: "#37474f", points: [[44, 22], [70, 30], [66, 46], [44, 36]] },
    ],
  },

  rainbow: {
    label: { zh: "彩虹", en: "rainbow" },
    strokes: [
      { color: "#e74c3c", points: arcPts(50, 82, 38, Math.PI, Math.PI * 2, 24) },
      { color: "#f39c12", points: arcPts(50, 82, 30, Math.PI, Math.PI * 2, 20) },
      { color: "#27ae60", points: arcPts(50, 82, 22, Math.PI, Math.PI * 2, 16) },
      { color: "#5d6d7e", closed: true, fill: "#d6eaf8", points: ellipsePts(16, 76, 12, 8, 16) },
      { color: "#5d6d7e", closed: true, fill: "#d6eaf8", points: ellipsePts(84, 76, 12, 8, 16) },
    ],
  },

  moon: {
    label: { zh: "月亮", en: "moon" },
    strokes: [
      {
        closed: true,
        fill: "#f4d03f",
        color: "#b7950b",
        points: [
          ...arcPts(50, 50, 34, Math.PI * 0.35, Math.PI * 1.65, 24),
          ...arcPts(64, 50, 26, Math.PI * 1.45, Math.PI * 0.55, 18),
        ],
      },
    ],
  },
};

/** 贴纸清单（给 AI 的 status 用） */
export function stickerList(lang: "zh" | "en"): Array<{ name: string; label: string }> {
  return Object.entries(STICKERS).map(([name, s]) => ({ name, label: s.label[lang] }));
}
