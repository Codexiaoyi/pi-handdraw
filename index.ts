/**
 * handdraw — 手绘风图表扩展
 *
 * 给 AI 一个 `handdraw` 工具：用结构化的"绘画语言"描述图形
 * （方框/椭圆/菱形/箭头/文字/路径），生成手绘风 SVG + PNG，
 * 并在 pi TUI 中内联显示（Warp / Kitty / iTerm2 / Ghostty / WezTerm 支持）。
 *
 * 安装：复制到 ~/.pi/agent/extensions/handdraw/ 后 npm install，/reload 生效。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Image, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Resvg } from "@resvg/resvg-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { join } from "node:path";
import { buildSvg, buildStrokeSequence, buildHandwritingHtml, layoutElements, type AnimSpeed, type BuildOptions, type HandDrawElement } from "./draw";
import { getCanvasServer, CANVAS_PORT, type StrokeMsg, type CanvasElementInfo } from "./canvas-server";

// ---------------------------------------------------------------------------
// 参数 Schema
// ---------------------------------------------------------------------------

const boxLike = (literal: "box" | "ellipse" | "diamond") =>
  Type.Object({
    type: Type.Literal(literal),
    x: Type.Optional(Type.Number({ description: "左上角 x（flow 布局下可省略）" })),
    y: Type.Optional(Type.Number({ description: "左上角 y（flow 布局下可省略）" })),
    w: Type.Optional(Type.Number({ description: "宽度，默认 160" })),
    h: Type.Optional(Type.Number({ description: "高度，默认 70" })),
    text: Type.Optional(Type.String({ description: "形状内文字，自动居中" })),
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

const parametersSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "图表标题（flow 布局下显示在顶部）" })),
  width: Type.Optional(Type.Number({ description: "画布宽，默认 800；flow 布局下自动计算" })),
  height: Type.Optional(Type.Number({ description: "画布高，默认 500；flow 布局下自动计算" })),
  background: Type.Optional(Type.String({ description: "画布背景色，如 #fdf6e3（米色纸张效果），默认透明/白" })),
  layout: Type.Optional(
    Type.Union([Type.Literal("flow"), Type.Literal("manual")], {
      description: "flow=形状自动排布+自动画箭头（画流程图最简单）；manual=完全手动指定坐标",
    })
  ),
  live: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("real"), Type.Literal("fast"), Type.Literal("instant")], {
      description:
        "书写动画：auto=自动（笔画多时加快）；real=真实手写速度（一笔一笔写，中文按笔顺）；fast=快速书写；instant=不播动画直接出图。默认 auto",
    })
  ),
  elements: Type.Array(elementSchema, { description: "图形元素列表" }),
});

type HandDrawParams = Static<typeof parametersSchema> & {
  elements: Array<{ type: string } & Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// 工具结果/入口数据
// ---------------------------------------------------------------------------

interface DrawingEntryData {
  title: string;
  svgPath: string;
  pngPath?: string;
  timestamp: number;
}

const OUT_DIR_NAME = "handdraw";

function timestampSlug(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

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

// ---------------------------------------------------------------------------
// Live 绘制：在 TUI 中用 Kitty 图片协议逐元素实时绘制
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** 用默认浏览器打开文件（macOS/Linux/Windows） */
function openInBrowser(filePath: string) {
  const cmd =
    process.platform === "darwin"
      ? `open "${filePath}"`
      : process.platform === "win32"
        ? `start "" "${filePath}"`
        : `xdg-open "${filePath}"`;
  exec(cmd, (err) => {
    if (err) {
      // 打开失败不影响主流程
    }
  });
}

/** 渲染 SVG 为 PNG Buffer */
function renderPngBuf(svg: string, background: string): Buffer {
  return new Resvg(svg, { background }).render().asPng();
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
      "元素必须用 layout 为 manual 的绝对坐标（x/y 是左上角）。\n" +
      "画布自动扩展，元素可以放到任意坐标。",
    promptSnippet: "Draw incrementally on a live canvas with a pen indicator (one call = a few strokes)",
    promptGuidelines: [
      "Use handdraw_canvas for real-time drawing: each call draws 1~3 elements and the browser shows them immediately with a pen writing them.",
      "Decide positions based on the returned canvas summary (freeSpots tells you where the empty space is). Draw top-to-bottom or left-to-right, one component at a time.",
      "实时画图时：一次只画 1-2 个元素（比如先画一个框，再画它的文字），这样用户可以看着笔一笔一笔画。",
      "Use manual coordinates (x/y 左上角). Boxes ~160x70 default; arrows connect existing boxes using their edge coordinates.",
      "After drawing a few elements, check the returned summary to place the next ones without overlap.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("draw"), Type.Literal("update"), Type.Literal("remove"), Type.Literal("status")], {
          description: "draw=画新元素（默认）；update=修改已有元素（用 elementId）；remove=删除元素；status=只查询画布状态",
        })
      ),
      elementId: Type.Optional(Type.String({ description: "要修改/删除的元素 ID（从上次返回的摘要或 occupied 列表获取）" })),
      title: Type.Optional(Type.String({ description: "本批次的标题（画在顶部，可省略）" })),
      elements: Type.Array(elementSchema, { description: "本次要画的元素（draw 用）或新元素（update 用）" }),
    }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as {
        action?: string;
        elementId?: string;
        title?: string;
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
      const server = getCanvasServer();

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

  // ---- TUI 内联显示手绘图（自定义 entry，不进 LLM 上下文） ----
  pi.registerEntryRenderer<DrawingEntryData>("handdraw-drawing", (entry, _opts, theme) => {
    const data = entry.data;
    const title = data?.title ?? "手绘图";
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", `✏️ ${title}`), 0, 0));

    if (data?.pngPath && existsSync(data.pngPath)) {
      try {
        const b64 = readFileSync(data.pngPath).toString("base64");
        const image = new Image(b64, "image/png", { fallbackColor: (s) => theme.fg("dim", s) }, {
          maxWidthCells: 76,
          maxHeightCells: 44,
        });
        box.addChild(image);
      } catch (err) {
        box.addChild(new Text(theme.fg("dim", `(PNG 渲染失败: ${(err as Error).message})`), 0, 0));
      }
    } else {
      box.addChild(new Text(theme.fg("dim", `SVG: ${data?.svgPath ?? "(无)"}`), 0, 0));
    }
    return box;
  });

  // ---- 工具：handdraw ----
  pi.registerTool({
    name: "handdraw",
    label: "手绘图表",
    description:
      "生成手绘风格的图表/流程图/示意图（rough.js 手绘风 + 楷体文字），保存为 SVG 和 PNG 文件并在终端内联显示。\n" +
      "用法示例（画一个手绘流程图，flow 布局会自动排布形状并画箭头）：\n" +
      'handdraw({ title: "登录流程", layout: "flow", background: "#fdf6e3", elements: [\n' +
      '  { type: "box", text: "开始" },\n' +
      '  { type: "box", text: "输入用户名密码", fill: "#d6eaf8" },\n' +
      '  { type: "diamond", text: "验证通过?", fill: "#fdebd0" },\n' +
      '  { type: "box", text: "进入主页", fill: "#d5f5e3" },\n' +
      '  { type: "box", text: "提示错误", fill: "#fadbd8" }\n' +
      "] })\n" +
      "手动布局：layout: \"manual\"，每个元素用 x/y 坐标精确定位（box/ellipse/diamond 的 x/y 是左上角，w/h 是宽高；line/arrow 用 x1,y1,x2,y2；text 用 x,y）。",
    promptSnippet: "Generate hand-drawn style diagrams (SVG+PNG) and show them inline",
    promptGuidelines: [
      "Use handdraw when the user asks for a diagram, flowchart, mind map, or any sketchy/hand-drawn visual (流程图中 boxes 用 flow 布局最省事，只需列出形状和文字).",
      "When drawing flowcharts with handdraw, prefer layout \"flow\": list box/ellipse/diamond elements in order and arrows between consecutive shapes are drawn automatically.",
      "For exact positioning (mind maps, architecture diagrams), use handdraw with layout \"manual\" and give every element explicit coordinates.",
      "Keep text short (Chinese or English, renders in Kaiti SC calligraphy font); long paragraphs do not wrap and will overflow the shape.",
    ],
    parameters: parametersSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as HandDrawParams;
      const outDir = join(ctx.cwd, OUT_DIR_NAME);
      mkdirSync(outDir, { recursive: true });

      const slug = timestampSlug();
      const rawElements = (params.elements ?? []).map(toElement);
      const layout: "flow" | "manual" = (params.layout as "flow" | "manual" | undefined) ?? "flow";
      const buildOpts: BuildOptions = {
        title: params.title,
        width: params.width,
        height: params.height,
        background: params.background,
        layout,
        elements: rawElements,
      };

      // 先做一次完整布局，固定所有元素坐标（live 逐步绘制时位置一致）
      const laidOut = layoutElements(buildOpts);
      const stageOpts: BuildOptions = {
        ...buildOpts,
        layout: "manual",
        width: laidOut.width,
        height: laidOut.height,
        showTitle: true,
        elements: laidOut.elements,
      };

      // live 参数解析：auto / real / fast / instant（浏览器手写动画速度）
      const liveParam = (params.live as "auto" | "real" | "fast" | "instant" | undefined) ?? "auto";
      const textLen =
        (params.title ?? "").length +
        (params.elements ?? []).reduce((n, el) => n + ("text" in el && el.text ? Array.from(el.text as string).length : 0), 0);
      const speed: AnimSpeed = liveParam === "fast" || (liveParam === "auto" && textLen > 24) ? "fast" : "real";
      const playBrowser = liveParam !== "instant" && ctx.hasUI;

      // 静态图（笔画手写体：汉字按笔顺渲染，无笔画数据字符 fallback 字体）
      const finalSvg = buildSvg(stageOpts);
      const svgPath = join(outDir, `${slug}.svg`);
      writeFileSync(svgPath, finalSvg);

      // 浏览器手写动画页
      let htmlPath: string | undefined;
      let htmlHint = "";
      let htmlError: string | undefined;
      try {
        const { html, fileHint } = buildHandwritingHtml(stageOpts, speed);
        htmlPath = join(outDir, `${slug}.html`);
        writeFileSync(htmlPath, html);
        htmlHint = fileHint;
        if (playBrowser) {
          openInBrowser(htmlPath);
        }
      } catch (err) {
        htmlPath = undefined;
        htmlError = (err as Error).message;
      }

      let pngPath: string | undefined;
      try {
        const pngBuf = renderPngBuf(finalSvg, params.background === "transparent" ? "transparent" : "white");
        pngPath = join(outDir, `${slug}.png`);
        writeFileSync(pngPath, pngBuf);
      } catch (err) {
        // PNG 失败不影响 SVG
      }

      pi.appendEntry<DrawingEntryData>("handdraw-drawing", {
        title: params.title ?? "手绘图",
        svgPath,
        pngPath,
        timestamp: Date.now(),
      });

      const count = stageOpts.elements.length;
      const liveNote = playBrowser
        ? `✏️ 手写动画已在浏览器打开（${htmlHint}，${speed === "real" ? "真实手写速度" : "快速书写"}）`
        : liveParam === "instant"
          ? "手写动画：已按 instant 关闭（仅静态图）"
          : "手写动画：无 UI 环境，未自动打开浏览器（可手动打开 HTML 观看）";
      const htmlWarn = htmlError ? `⚠️ 动画页生成失败: ${htmlError}` : "";
      return {
        content: [
          {
            type: "text",
            text:
              `已生成手绘图表「${params.title ?? "手绘图"}」（${count} 个元素）。\n` +
              (htmlPath ? `动画页: ${htmlPath}\n` : "") +
              (htmlWarn ? `${htmlWarn}\n` : "") +
              `SVG: ${svgPath}\n` +
              (pngPath ? `PNG: ${pngPath}\n` : "(PNG 渲染失败，仅保存 SVG)\n") +
              `${liveNote}\n` +
              "（文字为逐笔手写笔画，不是字体；浏览器页面可重播）",
          },
        ],
        details: { svgPath, pngPath, htmlPath, elementCount: count, layout, live: playBrowser, speed },
      };
    },
  });

  // ---- 命令：/handdraw-demo 生成示例图并在浏览器播放手写动画 ----
  pi.registerCommand("handdraw-demo", {
    description: "生成示例图并在浏览器播放手写动画",
    handler: async (_args, ctx) => {
      const outDir = join(ctx.cwd, OUT_DIR_NAME);
      mkdirSync(outDir, { recursive: true });
      const slug = timestampSlug();
      const buildOpts: BuildOptions = {
        title: "手绘示例：周末计划",
        layout: "flow",
        background: "#fdf6e3",
        elements: [
          { type: "ellipse", text: "起床" },
          { type: "box", text: "去公园散步", fill: "#d6eaf8" },
          { type: "diamond", text: "下雨?", fill: "#fdebd0" },
          { type: "box", text: "去咖啡店", fill: "#d5f5e3" },
          { type: "box", text: "回家看书", fill: "#fadbd8" },
        ],
      };
      const laidOut = layoutElements(buildOpts);
      const stageOpts: BuildOptions = {
        ...buildOpts,
        layout: "manual",
        width: laidOut.width,
        height: laidOut.height,
        showTitle: true,
        elements: laidOut.elements,
      };
      const speed: AnimSpeed = "fast";
      const finalSvg = buildSvg(stageOpts);
      const svgPath = join(outDir, `${slug}.svg`);
      writeFileSync(svgPath, finalSvg);
      let htmlPath: string | undefined;
      try {
        const { html, fileHint } = buildHandwritingHtml(stageOpts, speed);
        htmlPath = join(outDir, `${slug}.html`);
        writeFileSync(htmlPath, html);
        if (ctx.hasUI) {
          openInBrowser(htmlPath);
        }
        ctx.ui.notify(`已在浏览器打开手写动画（${fileHint}）: ${htmlPath}`, "info");
      } catch (err) {
        htmlPath = undefined;
        ctx.ui.notify(`HTML 生成失败: ${(err as Error).message}`, "error");
      }
      let pngPath: string | undefined;
      try {
        const pngBuf = renderPngBuf(finalSvg, "white");
        pngPath = join(outDir, `${slug}.png`);
        writeFileSync(pngPath, pngBuf);
      } catch {
        /* ignore */
      }
      pi.appendEntry<DrawingEntryData>("handdraw-drawing", {
        title: "手绘示例",
        svgPath,
        pngPath,
        timestamp: Date.now(),
      });
    },
  });
}
