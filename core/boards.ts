/**
 * core/boards.ts — handdraw_board 工具主逻辑（画板 CRUD）
 */
import { isValidBoardName } from "../canvas-server";
import { t } from "../i18n";
import type { BoardActionParams, ExecuteOptions, ToolResult } from "./domain";
import { ensureCanvasServer, getBridge } from "./bridge";

export async function executeBoardAction(
  params: BoardActionParams,
  opts: ExecuteOptions = {}
): Promise<ToolResult> {
  const url = await ensureCanvasServer(opts.openBrowser ?? false);
  if (!url) {
    return { text: t("tool.serverFail"), details: { ok: false } };
  }
  const { action, name } = params;

  if (action === "list") {
    const { active, boards } = await getBridge().listBoards();
    const text =
      boards.length === 0
        ? t("board.listEmpty")
        : t("board.list", {
            active,
            boards: boards
              .map((b) =>
                t("board.item", {
                  name: b.name,
                  count: b.elementCount,
                  dir: b.dir,
                  current: b.active ? t("board.currentMark") : "",
                })
              )
              .join("\n"),
          });
    return { text, details: { ok: true, active, boards } as unknown as Record<string, unknown> };
  }

  if (!name) {
    return { text: t("board.needName", { action }), details: { ok: false } };
  }
  if (!isValidBoardName(name)) {
    return { text: t("board.invalidName", { name }), details: { ok: false } };
  }

  if (action === "create") {
    const r = await getBridge().op("create", name);
    const { boards } = await getBridge().listBoards();
    const dir = boards.find((b) => b.name === name)?.dir ?? "";
    return {
      text: r.created === false ? t("board.exists", { name }) : t("board.created", { name, dir }),
      details: { ok: r.ok, board: name, dir, created: r.created ?? true },
    };
  }

  if (action === "switch") {
    const r = await getBridge().op("switch", name);
    if (!r.ok) return { text: t("board.notFound", { name }), details: { ok: false } };
    const { boards } = await getBridge().listBoards();
    const count = boards.find((b) => b.name === name)?.elementCount ?? 0;
    return { text: t("board.switched", { name, count }), details: { ok: true, board: name } };
  }

  // delete
  const r = await getBridge().op("delete", name);
  if (!r.ok) return { text: t("board.notFound", { name }), details: { ok: false } };
  return { text: t("board.deleted", { name }), details: { ok: true, board: name } };
}
