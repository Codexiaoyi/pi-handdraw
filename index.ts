/**
 * handdraw — 实时手绘画布扩展
 *
 * 给 AI 一个 `handdraw_canvas` 工具：用结构化的"绘画语言"描述图形
 * （方框/椭圆/菱形/箭头/文字/路径），在浏览器无限画布上逐笔实时书写
 * （rough.js 手绘风 + 楷体文字 + 钢笔跟随动画）。
 *
 * 安装：复制到 ~/.pi/agent/extensions/handdraw/ 后 npm install，/reload 生效。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec } from "node:child_process";
import { buildStrokeSequence, type BuildOptions, type HandDrawElement } from "./draw";
import { getCanvasServer, type StrokeMsg, type CanvasElementInfo } from "./canvas-server";

// ---------------------------------------------------------------------------
// 参数 Schema
// ---------------------------------------------------------------------------

const boxLike = (literal: "box" | "ellipse" | "diamond") =>
  Type.Object({
    type: Type.Literal(literal),
    x: Type.Number({ description: "左上角 x（画布绝对坐标）" }),
    y: Type.Number({ description: "左上角 y（画布绝对坐标）" }),
    w: Type.Optional(Type.Number({ description: "宽度，默认 160" })),
    h: Type.Optional(Type.Number({ description: "高度，默认 70" })),
    text: Type.Optional(Type.String({ description: "形状内文字，默认居中" })),
    textPosition: Type.Optional(
      Type.Union([Type.Literal("center"), Type.Literal("top")], {
        description:
          "文字位置：center=居中（默认，叶子节点用）；top=框内顶部（容器/模块框的标题用，此时框内其他内容从 y+50 以下开始排，不要覆盖标题）",
      })
    ),
    color: Type.Optional(Type.String({ description: "描边颜色，如 #c0392b" })),
    fill: Type.Optional(Type.String({ description: "填充颜色，如 #fdebd0" })),
    fillStyle: Type.Optional(
      Type.String({ description: "填充风格：hachure(手绘斜线)/solid/zigzag/cross-hatch，默认 hachure" })
    ),
    textSize: Type.Optional(Type.Number({ description: "文字大小，默认 16" })),
  });

const elementSchema = Type.Union([
  boxLike("box"),
  boxLike("ellipse"),
  boxLike("diamond"),
  Type.Object({
    type: Type.Literal("line"),
    x1: Type.Number(),
    y1: Type.Number(),
    x2: Type.Number(),
    y2: Type.Number(),
    color: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("arrow"),
    x1: Type.Number(),
    y1: Type.Number(),
    x2: Type.Number(),
    y2: Type.Number(),
    text: Type.Optional(Type.String({ description: "箭头上的说明文字" })),
    color: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("text"),
    x: Type.Number(),
    y: Type.Number(),
    text: Type.String(),
    size: Type.Optional(Type.Number()),
    color: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("path"),
    d: Type.String({ description: "SVG path 数据" }),
    color: Type.Optional(Type.String()),
    fill: Type.Optional(Type.String()),
  }),
]);

// ---------------------------------------------------------------------------
// 工具辅助
// ---------------------------------------------------------------------------

function toElement(raw: { type: string } & Record<string, unknown>): HandDrawElement {
  return raw as unknown as HandDrawElement;
}

/** 元素 → 位置摘要（AI 判断空位用） */
function toElementInfo(el: HandDrawElement): CanvasElementInfo {
  if (el.type === "box" || el.type === "ellipse" || el.type === "diamond") {
    return { type: el.type, label: el.text, x: el.x ?? 0, y: el.y ?? 0, w: el.w ?? 160, h: el.h ?? 70 };
  }
  if (el.type === "line" || el.type === "arrow") {
    return {
      type: el.type,
      label: el.type === "arrow" ? el.text : undefined,
      x: Math.min(el.x1, el.x2),
      y: Math.min(el.y1, el.y2),
      w: Math.abs(el.x2 - el.x1),
      h: Math.abs(el.y2 - el.y1),
    };
  }
  return { type: el.type, label: el.text, x: el.x, y: el.y, w: 60, h: 20 };
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
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---- 实时画布服务器生命周期 ----
  let canvasServerMode: "local" | "remote" | null = null;
  async function ensureCanvasServer(ctx: ExtensionContext): Promise<string | null> {
    const server = getCanvasServer();
    try {
      if (!server.isRunning()) {
        try {
          canvasServerMode = await server.start();
        } catch (err) {
          canvasServerMode = null;
          throw err;
        }
        if (ctx.hasUI) {
          openInBrowser(`http://localhost:${server.getPort()}`);
        }
      } else {
        canvasServerMode = "local";
      }
      return `http://localhost:${server.getPort()}`;
    } catch {
      canvasServerMode = null;
      return null;
    }
  }
  /** 推送笔画：本地直推或远程 HTTP */
  async function pushToCanvas(msgs: StrokeMsg[], infos: CanvasElementInfo[]): Promise<void> {
    const server = getCanvasServer();
    if (canvasServerMode === "remote") {
      await fetch(`http://localhost:${server.getPort()}/api/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strokes: msgs, elements: infos }),
      });
    } else {
      server.pushStrokes(msgs, infos);
    }
  }
  async function canvasSummary(): Promise<Record<string, unknown>> {
    const server = getCanvasServer();
    if (canvasServerMode === "remote") {
      try {
        const res = await fetch(`http://localhost:${server.getPort()}/state`);
        return (await res.json()) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
    }
    return server.getSummary() as unknown as Record<string, unknown>;
  }
  /** 修改元素（update/remove）：本地直调或远程 HTTP */
  async function modifyCanvas(
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
          body: JSON.stringify({ elementId, strokes, info }),
        });
        const data = (await res.json()) as { ok?: boolean };
        return data.ok !== false;
      } catch {
        return false;
      }
    }
    return action === "update" ? server.updateElement(elementId, strokes ?? [], info!) : server.removeElement(elementId);
  }
  pi.on("session_shutdown", () => {
    if (canvasServerMode === "local") {
      getCanvasServer().stop();
    }
    canvasServerMode = null;
  });

  // ---- 实时画布工具：AI 分步增量绘制，每笔实时出现在浏览器 ----
  pi.registerTool({
    name: "handdraw_canvas",
    label: "实时画布",
    description:
      "在实时画布上增量绘制（浏览器无限画布 + 钢笔指示器逐笔书写）。\n" +
      "每次调用只画 1~3 个元素，调用后浏览器里会实时出现新笔画（钢笔跟随书写）。\n" +
      "元素必须用绝对坐标（box/ellipse/diamond 的 x/y 是左上角，w/h 是宽高）。\n" +
      "画布自动扩展，元素可以放到任意坐标。",
    promptSnippet: "Draw incrementally on a live canvas with a pen indicator (one call = a few strokes)",
    promptGuidelines: [
      "Use handdraw_canvas for real-time drawing: each call draws 1~3 elements and the browser shows them immediately with a pen writing them.",
      "Decide positions based on the returned canvas summary (freeSpots tells you where the empty space is). Draw top-to-bottom or left-to-right, one component at a time.",
      "实时画图时：一次只画 1-2 个元素（比如先画一个框，再画它的文字），这样用户可以看着笔一笔一笔画。",
      "Connect arrows to box edges: right edge=(x+w, y+h/2), left edge=(x, y+h/2), bottom=(x+w/2, y+h), top=(x+w/2, y). Never point arrows at box centers.",
      "For a container/module box that holds other elements inside, set textPosition \"top\" so its title sits at the top of the box, and place inner content below y+50. NEVER put a container title in the box center and then draw content over it.",
      "Each heading/label must be exactly ONE text element — never repeat the same text at multiple positions.",
      "After drawing a few elements, check the returned summary to place the next ones without overlap.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("draw"), Type.Literal("update"), Type.Literal("remove"), Type.Literal("status")], {
          description: "draw=画新元素（默认）；update=修改已有元素（用 elementId）；remove=删除元素；status=只查询画布状态",
        })
      ),
      elementId: Type.Optional(Type.String({ description: "要修改/删除的元素 ID（从上次返回的摘要或 occupied 列表获取）" })),
      elements: Type.Array(elementSchema, { description: "本次要画的元素（draw 用）或新元素（update 用）" }),
    }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as {
        action?: string;
        elementId?: string;
        elements: Array<{ type: string } & Record<string, unknown>>;
      };
      const action = (params.action ?? "draw") as "draw" | "update" | "remove" | "status";
      const url = await ensureCanvasServer(ctx);
      if (!url) {
        return {
          content: [{ type: "text", text: `❌ 无法启动实时画布服务器。` }],
          details: { ok: false },
        };
      }

      if (action === "status" || (action === "draw" && (params.elements ?? []).length === 0)) {
        const summary = (await canvasSummary()) as unknown as {
          elementCount: number;
          occupied: Array<{ id: string; type: string; label?: string; x: number; y: number; w: number; h: number }>;
          freeSpots: Array<{ x: number; y: number; w: number; h: number; hint: string }>;
        };
        return {
          content: [
            {
              type: "text",
              text:
                `当前画布：${summary.elementCount} 个元素。\n` +
                `已画：${(summary.occupied ?? []).map((e) => `${e.label ?? e.type}[${e.id}]@(${Math.round(e.x)},${Math.round(e.y)})`).join("; ")}\n` +
                `空位：${(summary.freeSpots ?? []).map((f) => `${f.hint} @(${Math.round(f.x)},${Math.round(f.y)})`).join("; ")}`,
            },
          ],
          details: summary,
        };
      }

      const elements = (params.elements ?? []).map(toElement);

      // 每个元素独立生成笔画并标记 elementId（可单独修改/删除）
      const buildOpts = (el: HandDrawElement): BuildOptions => ({
        layout: "manual",
        background: "#fdf6e3",
        title: undefined,
        elements: [el],
      });

      if (action === "update") {
        if (!params.elementId || elements.length === 0) {
          return { content: [{ type: "text", text: "update 需要 elementId 和新元素。" }], details: {} };
        }
        const el = elements[0];
        const { strokes } = buildStrokeSequence(buildOpts(el), "fast");
        const msgs: StrokeMsg[] = strokes.map((s) => ({
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
        const ok = await modifyCanvas("update", params.elementId, msgs, toElementInfo(el));
        const summary = (await canvasSummary()) as unknown as { elementCount: number };
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `✅ 已更新元素 ${params.elementId} 为「${("text" in el && el.text) || el.type}」（重绘 ${msgs.length} 笔）。画布共 ${summary.elementCount} 个元素。`
                : `❌ 元素 ${params.elementId} 不存在。可用 status 查看当前元素 ID。`,
            },
          ],
          details: { ok },
        };
      }

      if (action === "remove") {
        if (!params.elementId) {
          return { content: [{ type: "text", text: "remove 需要 elementId。" }], details: {} };
        }
        const ok = await modifyCanvas("remove", params.elementId);
        const summary = (await canvasSummary()) as unknown as { elementCount: number };
        return {
          content: [
            {
              type: "text",
              text: ok ? `🗑️ 已删除元素 ${params.elementId}。画布剩余 ${summary.elementCount} 个元素。` : `❌ 元素 ${params.elementId} 不存在。`,
            },
          ],
          details: { ok },
        };
      }

      // draw：逐个元素生成笔画（带独立 id）并推送
      const allMsgs: StrokeMsg[] = [];
      const infos: CanvasElementInfo[] = [];
      for (const el of elements) {
        const elId = `el${Math.floor(Math.random() * 1e9).toString(36)}`;
        const { strokes } = buildStrokeSequence(buildOpts(el), "fast");
        for (const s of strokes) {
          allMsgs.push({
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
          });
        }
        infos.push({ ...toElementInfo(el), id: elId });
      }
      await pushToCanvas(allMsgs, infos);

      const summary = (await canvasSummary()) as unknown as {
        elementCount: number;
        bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
        freeSpots: Array<{ x: number; y: number; w: number; h: number; hint: string }>;
      };
      return {
        content: [
          {
            type: "text",
            text:
              `✅ 已画 ${elements.length} 个元素（${allMsgs.length} 笔）到实时画布 ${url}。\n` +
              `元素 ID：${infos.map((i) => `${i.label ?? i.type}[${i.id}]@(${Math.round(i.x)},${Math.round(i.y)})`).join("; ")}\n` +
              `画布现状：${summary.elementCount} 个元素` +
              (summary.bounds ? `，范围 x[${Math.round(summary.bounds.minX)}-${Math.round(summary.bounds.maxX)}] y[${Math.round(summary.bounds.minY)}-${Math.round(summary.bounds.maxY)}]` : "") +
              `。\n下一步空位推荐：` +
              (summary.freeSpots ?? []).map((f) => `${f.hint} @(${Math.round(f.x)},${Math.round(f.y)})`).join("; "),
          },
        ],
        details: summary,
      };
    },
  });
}
