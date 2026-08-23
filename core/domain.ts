/**
 * core/domain.ts — 类型与领域常量（不依赖运行时）
 *
 * 给 pi 扩展 / MCP server 共享的对外类型。canvas-server.ts 已经在这些类型的原始定义处，
 * 这里只 re-export + 少量添加（HandDrawElement 类型别名等）。
 */
export type {
  CanvasElementInfo,
  StrokeMsg,
  CanvasSummary,
  BoardListItem,
} from "../canvas-server";
export type { HandDrawElement } from "../draw";

/** 工具调用方统一返回：text 给 LLM 读，details 给调用方结构化消费 */
export interface ToolResult {
  text: string;
  details: Record<string, unknown>;
}

/** 执行选项：openBrowser = 启动服务器后是否自动开页面（pi 模式下看 ctx.hasUI） */
export interface ExecuteOptions {
  openBrowser?: boolean;
}

/** handdraw_canvas 工具参数 */
export interface CanvasActionParams {
  action?: "draw" | "update" | "remove" | "status" | "clear";
  board?: string;
  elementId?: string;
  elements?: Array<{ type: string } & Record<string, unknown>>;
  /** 工蚁：本次绘制允许的区域（蚁后调度用） */
  region?: { x: number; y: number; w: number; h: number };
  /** 工蚁：本次任务的 taskId（蚁后调度时分配） */
  taskId?: string;
  /** 允许覆盖已有元素（默认 false，覆盖会被拒） */
  allowOverlap?: boolean;
}

/** handdraw_board 工具参数 */
export interface BoardActionParams {
  action: "list" | "create" | "switch" | "delete";
  name?: string;
}

/** handdraw_delegate 的单条任务 */
export interface DelegateTask {
  taskId?: string;
  title?: string;
  instructions: string;
  region: { x: number; y: number; w: number; h: number };
}

/** handdraw_delegate 工具参数 */
export interface DelegateParams {
  board?: string;
  tasks: DelegateTask[];
}