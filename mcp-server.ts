#!/usr/bin/env node
/**
 * mcp-server.ts — handdraw_canvas 的 MCP server 形态（stdio）
 *
 * 与 pi 扩展共用 core.ts 的全部逻辑，任何支持 MCP 的 agent 都能用。
 *
 * 运行：
 *   npx tsx mcp-server.ts
 *
 * 语言：环境变量 HANDDRAW_LANG=zh|en（默认 zh）。
 *
 * 客户端配置示例（Claude Code / Cursor 等）：
 *   {
 *     "mcpServers": {
 *       "handdraw": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/pi-handdraw/mcp-server.ts"]
 *       }
 *     }
 *   }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  executeCanvasAction,
  executeBoardAction,
  shutdownCanvasServer,
  PARAMS_SCHEMA,
  BOARD_PARAMS_SCHEMA,
  toolDescriptionFull,
  boardToolDescriptionFull,
} from "./core";

const server = new Server(
  { name: "handdraw-canvas", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    // 客户端初始化时可见的整体说明（配合工具 description 里的使用规则）
    instructions:
      "handdraw_canvas 让你在一块浏览器实时画布上逐笔绘制手绘风图形。" +
      "用户主动要求画图/讲解/涂鸦时再使用；先 status 看画布现状，再分步增量绘制。",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "handdraw_canvas",
      description: toolDescriptionFull(),
      inputSchema: PARAMS_SCHEMA,
    },
    {
      name: "handdraw_board",
      description: boardToolDescriptionFull(),
      inputSchema: BOARD_PARAMS_SCHEMA,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  let result;
  if (req.params.name === "handdraw_canvas") {
    result = await executeCanvasAction(args as Parameters<typeof executeCanvasAction>[0], { openBrowser: true });
  } else if (req.params.name === "handdraw_board") {
    result = await executeBoardAction(args as unknown as Parameters<typeof executeBoardAction>[0], { openBrowser: true });
  } else {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }
  return {
    content: [{ type: "text" as const, text: result.text }],
    structuredContent: result.details,
  };
});

// MCP 客户端断开/进程退出时，停止本进程监听的画布服务器
function shutdown() {
  shutdownCanvasServer();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed:", err);
  process.exit(1);
});
