/**
 * handdraw — 实时手绘画布扩展（pi 薄壳）
 *
 * 所有核心逻辑在 core.ts（agent 无关），这里只负责：
 * - 注册 handdraw_canvas / handdraw_board 工具（schema / 描述 / 指导语都来自 core.ts + i18n.ts）
 * - 会话结束时停止本进程监听的画布服务器
 *
 * MCP 形态见 mcp-server.ts。语言：环境变量 HANDDRAW_LANG=zh|en（默认 zh）。
 *
 * 安装：复制到 ~/.pi/agent/extensions/handdraw/ 后 npm install，/reload 生效。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  executeCanvasAction,
  executeBoardAction,
  shutdownCanvasServer,
  PARAMS_SCHEMA,
  BOARD_PARAMS_SCHEMA,
  toolDescription,
  toolGuidelines,
  boardToolDescription,
  boardToolGuidelines,
} from "./core";

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    shutdownCanvasServer();
  });

  // ---- 实时画布工具：AI 分步增量绘制，每笔实时出现在浏览器 ----
  pi.registerTool({
    name: "handdraw_canvas",
    label: "实时画布",
    description: toolDescription(),
    promptSnippet: "Draw incrementally on a live canvas with a pen indicator (one call = a few strokes)",
    promptGuidelines: toolGuidelines(),
    // core.ts 里的纯 JSON Schema（typebox 兼容）
    parameters: PARAMS_SCHEMA as unknown as TSchema,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const result = await executeCanvasAction(
        rawParams as Parameters<typeof executeCanvasAction>[0],
        { openBrowser: ctx.hasUI }
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });

  // ---- 画板管理工具：每个画板 = boards/<画板名>/ 目录 ----
  pi.registerTool({
    name: "handdraw_board",
    label: "画板管理",
    description: boardToolDescription(),
    promptSnippet: "Manage canvas boards (list/create/switch/delete); each board is a directory under boards/",
    promptGuidelines: boardToolGuidelines(),
    parameters: BOARD_PARAMS_SCHEMA as unknown as TSchema,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const result = await executeBoardAction(
        rawParams as Parameters<typeof executeBoardAction>[0],
        { openBrowser: ctx.hasUI }
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });
}
