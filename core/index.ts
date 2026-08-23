/**
 * core/index.ts — handdraw_canvas / handdraw_board / handdraw_delegate 工具的 agent 无关核心
 *
 * 本文件只做 re-export，保持原 core.ts 的对外 export 列表不变；
 * 实现按职责拆到同目录的平铺文件里：
 * - domain.ts    类型与领域常量
 * - schema.ts    工具参数 JSON Schema
 * - prompts.ts   工具文案（i18n）
 * - role.ts      蚁后/工蚁角色门控
 * - geometry.ts  矩形几何 + bbox 采样 + 覆盖检测（纯函数）
 * - bridge.ts    画布桥（local/remote/noop）+ 服务器生命周期
 * - canvas.ts    handdraw_canvas 主逻辑
 * - boards.ts    handdraw_board 主逻辑
 * - delegate.ts  handdraw_delegate 主逻辑
 *
 * pi 扩展（index.ts）和 MCP server（mcp-server.ts）都只是这一层的薄壳。
 *
 * 注意：这里用 `import + export` 而不是 `export * from`，因为 tsx 对
 * 链式 export * 的静态链接支持有问题（只会解析第一个 re-export）。
 */

import {
  type CanvasElementInfo,
  type StrokeMsg,
  type CanvasSummary,
  type BoardListItem,
  type HandDrawElement,
  type ToolResult,
  type ExecuteOptions,
  type CanvasActionParams,
  type BoardActionParams,
  type DelegateTask,
  type DelegateParams,
} from "./domain";
import { ELEMENT_SCHEMA, PARAMS_SCHEMA, DELEGATE_PARAMS_SCHEMA, BOARD_PARAMS_SCHEMA } from "./schema";
import {
  toolDescription,
  toolGuidelines,
  toolDescriptionFull,
  boardToolDescription,
  boardToolDescriptionFull,
  boardToolGuidelines,
  delegateToolDescription,
  delegateToolGuidelines,
} from "./prompts";
import { DRAW_WORKER_ID, IS_QUEEN, IS_WORKER, isStatusRequest, assertQueenWrite, rejectWorkerOn } from "./role";
import {
  type Rect,
  type OverlapItem,
  shrinkRect,
  rectHit,
  rectContains,
  isCovering,
  findOverlapHits,
  unionRects,
  strokesBBox,
  pathBBox,
  taskRegionError,
} from "./geometry";
import { type CanvasBridge, getBridge, setAgentWorking, ensureCanvasServer, shutdownCanvasServer } from "./bridge";
import { executeCanvasAction } from "./canvas";
import { executeBoardAction } from "./boards";
import { executeDelegateAction } from "./delegate";

export {
  // domain
  type CanvasElementInfo,
  type StrokeMsg,
  type CanvasSummary,
  type BoardListItem,
  type HandDrawElement,
  type ToolResult,
  type ExecuteOptions,
  type CanvasActionParams,
  type BoardActionParams,
  type DelegateTask,
  type DelegateParams,
  // schema
  ELEMENT_SCHEMA,
  PARAMS_SCHEMA,
  DELEGATE_PARAMS_SCHEMA,
  BOARD_PARAMS_SCHEMA,
  // prompts
  toolDescription,
  toolGuidelines,
  toolDescriptionFull,
  boardToolDescription,
  boardToolDescriptionFull,
  boardToolGuidelines,
  delegateToolDescription,
  delegateToolGuidelines,
  // role
  DRAW_WORKER_ID,
  IS_QUEEN,
  IS_WORKER,
  isStatusRequest,
  assertQueenWrite,
  rejectWorkerOn,
  // geometry
  type Rect,
  type OverlapItem,
  shrinkRect,
  rectHit,
  rectContains,
  isCovering,
  findOverlapHits,
  unionRects,
  strokesBBox,
  pathBBox,
  taskRegionError,
  // bridge
  type CanvasBridge,
  getBridge,
  setAgentWorking,
  ensureCanvasServer,
  shutdownCanvasServer,
  // actions
  executeCanvasAction,
  executeBoardAction,
  executeDelegateAction,
};
