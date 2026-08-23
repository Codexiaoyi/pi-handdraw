/**
 * core/role.ts — 蚁后 / 工蚁 角色门控
 *
 * HANDDRAW_WORKER_ID 是 worker 子进程继承的 env（蚁后进程该值为空）。
 * 这里集中所有"是否工蚁 / 是否蚁后"的判断和拒绝文案。
 */

/** worker 子进程继承的身份；蚁后进程该值为空 */
export const DRAW_WORKER_ID: string | undefined = process.env.HANDDRAW_WORKER_ID || undefined;

/** 当前进程是否为蚁后（未设 worker id 即是蚁后） */
export const IS_QUEEN = !DRAW_WORKER_ID;

/** 当前进程是否为工蚁 */
export const IS_WORKER = Boolean(DRAW_WORKER_ID);

/** 请求是否只是查询（status / 空 draw）—— 工蚁/蚁后都能回答 */
export function isStatusRequest(action: string | undefined, hasElements: boolean): boolean {
  if (action === "status") return true;
  if ((action === "draw" || !action) && !hasElements) return true;
  return false;
}

/** 蚁后才能做写操作（draw / update / clear / board 创建/删除/切换）；
 *  工蚁只能做"绘制已分配区域"，并且不能 remove / clear。
 *  返回 null = 通过；返回 string = 拒绝文案 */
export function assertQueenWrite(action: string | undefined): string | null {
  if (IS_QUEEN) return null;
  return "❌ 蚁后不能直接修改画布。请先把绘图拆成互不重叠的区域任务，再调用 handdraw_delegate；蚁后只能用 handdraw_canvas 查看 status。";
}

/** 工蚁独有的拒绝：删除、清空、修改其他元素 */
export function rejectWorkerOn(action: string): string | null {
  if (!IS_WORKER) return null;
  if (action === "clear") return "❌ 工蚁不能清空画板，只能绘制蚁后分配的区域。";
  if (action === "remove") return "❌ 工蚁不能删除元素，只能绘制蚁后分配的区域。";
  return null;
}