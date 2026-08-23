/**
 * core/delegate.ts — handdraw_delegate 工具主逻辑（蚁后派单给工蚁调度器）
 */
import { getCanvasServer, isValidBoardName } from "../canvas-server";
import type { DelegateParams, ExecuteOptions, ToolResult } from "./domain";
import { DRAW_WORKER_ID } from "./role";
import { ensureCanvasServer } from "./bridge";

export async function executeDelegateAction(params: DelegateParams, opts: ExecuteOptions = {}): Promise<ToolResult> {
  if (DRAW_WORKER_ID) {
    return { text: "工蚁不能继续派发子任务，只能执行蚁后已分配的绘图任务。", details: { ok: false, workerId: DRAW_WORKER_ID } };
  }
  const url = await ensureCanvasServer(opts.openBrowser ?? false);
  if (!url) return { text: "无法连接工蚁调度器。", details: { ok: false } };
  const server = getCanvasServer();
  const board = params.board && isValidBoardName(params.board) ? params.board : server.getActiveBoard();
  const tasks = (params.tasks ?? []).filter((task) => task && typeof task.instructions === "string" && task.region);
  if (!tasks.length) return { text: "没有可分配的工蚁任务。", details: { ok: false } };
  if (tasks.length > 4) return { text: "❌ 一次最多委派 4 个互不重叠的区域任务；建议每次只走一小步。", details: { ok: false, maxWorkers: 4 } };
  const payload = { board, tasks: tasks.map((task, i) => ({ ...task, taskId: task.taskId || `task-${Date.now()}-${i + 1}` })) };
  try {
    const response = await fetch(`http://localhost:${server.getPort()}/api/delegate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok || data.ok === false) throw new Error(String(data.error ?? "调度器拒绝任务"));
    return { text: `✅ 已异步分配 ${tasks.length} 个工蚁任务；蚁后可以继续与用户交流，工蚁完成后会自动领取后续任务。`, details: data };
  } catch (e) {
    return { text: `❌ 工蚁调度失败：${e instanceof Error ? e.message : String(e)}`, details: { ok: false } };
  }
}
