/**
 * i18n.ts — 中英文案
 *
 * 语言选择：环境变量 HANDDRAW_LANG=zh|en（默认 zh）。
 * 覆盖：工具描述/指导语/结果消息（AI 可见）+ 画布页面 UI（用户可见，由服务器注入页面）。
 */
export type Lang = "zh" | "en";

export function getLang(): Lang {
  const l = (process.env.HANDDRAW_LANG ?? "").toLowerCase();
  return l.startsWith("en") ? "en" : "zh";
}

type Dict = Record<string, string | string[]>;

const zh: Dict = {
  // ---- handdraw_canvas 工具 ----
  "tool.desc":
    "在实时画布上增量绘制（浏览器无限画布 + 钢笔指示器逐笔书写）。\n" +
    "每次调用只画 1~3 个元素，调用后浏览器里会实时出现新笔画（钢笔跟随书写）。\n" +
    "元素必须用绝对坐标（box/ellipse/diamond 的 x/y 是左上角，w/h 是宽高）。\n" +
    "元素类型：box/ellipse/diamond/line/arrow/text/path/sticker（贴纸，按 name 引用，清单见 status 返回）/image（图片，直接显示）。\n" +
    "画布分多个画板（board）：默认画到当前画板，可用 board 参数指定目标画板（画板管理用 handdraw_board 工具）。\n" +
    "画布自动扩展，元素可以放到任意坐标。",
  "tool.guidelines": [
    "Use handdraw_canvas for real-time drawing: each call draws 1~3 elements and the browser shows them immediately with a pen writing them.",
    "BEFORE the first draw of a new diagram, ALWAYS call action \"status\" first. If the canvas already has content, start the new diagram at the recommended freeSpots (prefer 内容右侧, keep the gap) so it sits side by side with existing diagrams — never draw over occupied regions.",
    "严禁覆盖已有内容：新元素与已占用区域发生部分重叠会被直接拒绝（返回冲突清单）。容器包含子元素、底色块垫文字这类完全包含关系不受限制；只有确有意的覆盖才允许传 allowOverlap: true。",
    "Decide positions based on the returned canvas summary (freeSpots tells you where the empty space is). Draw top-to-bottom or left-to-right, one component at a time.",
    "实时画图时：一次只画 1-2 个元素（比如先画一个框，再画它的文字），这样用户可以看着笔一笔一笔画。",
    "Connect arrows to box edges: right edge=(x+w, y+h/2), left edge=(x, y+h/2), bottom=(x+w/2, y+h), top=(x+w/2, y). Never point arrows at box centers.",
    "For a container/module box that holds other elements inside, set textPosition \"top\" so its title sits at the top of the box, and place inner content below y+50. NEVER put a container title in the box center and then draw content over it.",
    "Each heading/label must be exactly ONE text element — never repeat the same text at multiple positions.",
    "After drawing a few elements, check the returned summary to place the next ones without overlap.",
    "Only use action \"clear\" when the user explicitly asks to wipe/reset the canvas (清空/重画). Never clear on your own — old diagrams must be preserved.",
    "text 元素支持多行：用 \\n 分行，或设置 w 开启自动换行（此时 x,y 为段落左上角，可配 lineHeight 行距倍数和 align 对齐）；单行时 x,y 为文字中心（旧行为）。",
    "元素可用 z 控制叠放层次（小的在下）：底色块、装饰贴纸压在文字下时记得给它们更小的 z；不设 z 时后画的在上。",
    "贴纸用 {type:\"sticker\", name, x, y, size?, color?} 绘制；可用贴纸名字从 status 返回的 stickers 列表获取，不要编造不存在的贴纸名。",
    "每个元素都必须填 \"desc\" 字段：写这个对象本身的详细说明（1~2 句话），不是形状名（如「画框/椭圆」）、也不是把标签文字复述一遍。架构图场景：说明该节点的职责和关键交互，如「订单服务：负责下单与订单查询，通过 MQ 异步通知库存服务扣减库存」；手帐/旅行规划场景：写一段描述或小 tips，如「Day1 清水寺：建议 8:00 前到避开人流，顺路逛三年坂二年坂，午餐推荐抹茶荞麦面」。双击对象时 desc 会以浮窗展示给用户。",
    "图片用 {type:\"image\", src, x, y, w, h} 放置（不是笔画，会直接显示）：src 支持 http(s) URL、data:image/ base64、或画板 images/ 目录下已存在的文件名（如 photo.png）；图片也必须填 desc 说明图片内容。",
  ],
  "tool.serverFail": "❌ 无法启动实时画布服务器。",
  "tool.cleared": "🧹 画布已清空。",
  "tool.updateNeedId": "update 需要 elementId 和新元素。",
  "tool.removeNeedId": "remove 需要 elementId。",
  "tool.elNotFound": "❌ 元素 {id} 不存在。可用 status 查看当前元素 ID。",
  "tool.stickerUnknown": "⚠️ 未知贴纸「{name}」，已跳过（可用贴纸见 status 返回的 stickers 列表）。",
  "tool.imageBadSrc": "⚠️ 图片来源「{src}」不合法或不受支持（支持 http(s) URL、data:image/ base64、或画板 images/ 目录下的 png/jpg/gif/webp/bmp/svg 文件名），已跳过。",
  "tool.overlap":
    "❌ 拒绝绘制：以下新元素会覆盖已有内容：{hits}。\n" +
    "请参照空位（{spots}）重新排布后重试。完全包含关系（容器装子元素/底色块垫文字）不会被拦截；若确实需要有意的覆盖，传 allowOverlap: true。",
  "tool.status":
    "当前画板「{board}」（目录 {dir}）：{count} 个元素。\n" +
    "已画：{occupied}\n" +
    "空位：{spots}\n" +
    "可用贴纸：{stickers}",
  "tool.updated": "✅ 已更新元素 {id} 为「{label}」（重绘 {strokes} 笔）。画板共 {count} 个元素。",
  "tool.removed": "🗑️ 已删除元素 {id}。画板剩余 {count} 个元素。",
  "tool.drew":
    "✅ 已画 {n} 个元素（{strokes} 笔）到画板「{board}」 {url}。\n" +
    "元素 ID：{ids}\n" +
    "画板现状：{count} 个元素{bounds}。\n" +
    "下一步空位推荐：{spots}",
  "tool.bounds": "，范围 x[{minX}-{maxX}] y[{minY}-{maxY}]",

  // ---- handdraw_board 工具 ----
  "board.desc":
    "管理手绘画布的画板（board）。每个画板对应磁盘上一个目录（boards/<画板名>/），" +
    "画布状态存为 state.json，图片等资源放该目录下（images/ 子目录）。\n" +
    "list=列出所有画板；create=新建画板（并设为当前画板）；switch=切换当前画板；delete=删除画板画布数据（保留目录内其他资源文件）。",
  "board.guidelines": [
    "Use handdraw_board to manage boards: list / create / switch / delete. Each board is a directory under boards/ named after the board.",
    "用户想新开一个主题（比如新的手帐页、新的一张图）时，用 create 新建画板；画到哪个画板由 handdraw_canvas 的 board 参数或当前画板决定。",
  ],
  "board.needName": "{action} 需要 name 参数。",
  "board.invalidName": "❌ 画板名不合法：「{name}」（不能包含 / \\ .. 或开头结尾的空格/点，最长 60 字符）。",
  "board.list": "画板列表（当前：「{active}」）：\n{boards}",
  "board.listEmpty": "（还没有画板）",
  "board.item": "- {name}（{count} 个元素，目录 {dir}）{current}",
  "board.currentMark": " ←当前",
  "board.created": "✅ 已创建画板「{name}」（目录 {dir}，图片等资源可放 images/ 子目录），已设为当前画板。",
  "board.exists": "画板「{name}」已存在，已设为当前画板。",
  "board.switched": "✅ 已切换到画板「{name}」（{count} 个元素）。",
  "board.deleted": "🗑️ 已删除画板「{name}」的画布数据（目录内其他资源文件保留）。",
  "board.notFound": "❌ 画板「{name}」不存在。用 list 查看现有画板。",

  // ---- 画布页面 UI ----
  "page.title": "✏️ 实时画布",
  "page.waiting": "等待 AI 动笔…",
  "page.strokeUnit": " 笔",
  "page.batchDone": "✅ 本批完成",
  "page.cleared": "画布已清空",
  "page.restored": "已恢复画布，等待 AI 动笔…",
  "page.disconnected": "连接断开，重连中…",
  "page.removedEl": "🗑️ 已删除元素 {id}",
  "page.fit": "适应",
  "page.refresh": "刷新",
  "page.clear": "清空",
  "page.hint": "滚轮缩放 · 拖拽平移 · 实时连接",
  "page.board": "画板",
};

const en: Dict = {
  "tool.desc":
    "Draw incrementally on a live canvas (infinite browser canvas + a pen indicator writing stroke by stroke).\n" +
    "Draw only 1~3 elements per call; new strokes appear in the browser in real time (pen follows the writing).\n" +
    "Elements use absolute coordinates (for box/ellipse/diamond, x/y is the top-left corner, w/h the size).\n" +
    "Element types: box/ellipse/diamond/line/arrow/text/path/sticker (predefined doodles referenced by name; see the stickers list returned by status)/image (a picture, shown instantly).\n" +
    "The canvas is organized into boards: draw calls go to the active board unless a board parameter is given (manage boards with the handdraw_board tool).\n" +
    "The canvas auto-expands; elements can be placed at any coordinates.",
  "tool.guidelines": [
    "Use handdraw_canvas for real-time drawing: each call draws 1~3 elements and the browser shows them immediately with a pen writing them.",
    "BEFORE the first draw of a new diagram, ALWAYS call action \"status\" first. If the canvas already has content, start the new diagram at the recommended freeSpots (prefer right of the content, keep the gap) so it sits side by side with existing diagrams — never draw over occupied regions.",
    "NEVER cover existing content: a new element partially overlapping any occupied region is rejected outright (you get the collision list). Full containment (child inside a container, a background block under text) is allowed; pass allowOverlap: true only when the overlap is truly intentional.",
    "Decide positions based on the returned canvas summary (freeSpots tells you where the empty space is). Draw top-to-bottom or left-to-right, one component at a time.",
    "When drawing live, draw only 1-2 elements per call (e.g. first a box, then its label) so the user can watch the pen write stroke by stroke.",
    "Connect arrows to box edges: right edge=(x+w, y+h/2), left edge=(x, y+h/2), bottom=(x+w/2, y+h), top=(x+w/2, y). Never point arrows at box centers.",
    "For a container/module box that holds other elements inside, set textPosition \"top\" so its title sits at the top of the box, and place inner content below y+50. NEVER put a container title in the box center and then draw content over it.",
    "Each heading/label must be exactly ONE text element — never repeat the same text at multiple positions.",
    "After drawing a few elements, check the returned summary to place the next ones without overlap.",
    "Only use action \"clear\" when the user explicitly asks to wipe/reset the canvas. Never clear on your own — old diagrams must be preserved.",
    "text elements support multiple lines: use \\n for line breaks, or set w for automatic wrapping (then x,y is the top-left of the paragraph; lineHeight is a multiple of font size, align can be left/center/right). Single-line text keeps the old behavior: x,y is the text center.",
    "Elements accept z for stacking order (smaller goes below): give background blocks and decorative stickers a smaller z when they should sit under text; without z, later draws go on top.",
    "Stickers are drawn with {type:\"sticker\", name, x, y, size?, color?}; get available sticker names from the stickers list in the status result — never invent sticker names.",
    "Every element MUST include a \"desc\" field with a detailed 1-2 sentence description of the object itself — not a shape name (like \"box\") and not a copy of its label text. Architecture diagrams: state the node's responsibility and key interactions, e.g. \"Order service: handles order creation/queries; notifies inventory via MQ to deduct stock\". Journal / travel-planning scenes: write a description or small tips, e.g. \"Day 1 Kiyomizu-dera: arrive before 8am to beat the crowds, stroll Sannenzaka on the way; try matcha soba for lunch\". The desc is shown in a popup when the user double-clicks the object.",
    "Place pictures with {type:\"image\", src, x, y, w, h} (not a stroke — it appears instantly): src accepts an http(s) URL, a data:image/ base64 string, or the filename of an existing file in the board's images/ directory (e.g. photo.png); images also need a desc explaining what they show.",
  ],
  "tool.serverFail": "❌ Failed to start the live canvas server.",
  "tool.cleared": "🧹 Canvas cleared.",
  "tool.updateNeedId": "update requires elementId and a new element.",
  "tool.removeNeedId": "remove requires elementId.",
  "tool.elNotFound": "❌ Element {id} does not exist. Use status to see current element IDs.",
  "tool.stickerUnknown": "⚠️ Unknown sticker \"{name}\", skipped (see the stickers list in the status result).",
  "tool.imageBadSrc": "⚠️ Image source \"{src}\" is invalid or unsupported (supports http(s) URLs, data:image/ base64, or png/jpg/gif/webp/bmp/svg files in the board's images/ directory); skipped.",
  "tool.overlap":
    "❌ Draw rejected: these new elements would cover existing content: {hits}.\n" +
    "Re-layout at the free spots ({spots}) and retry. Full containment (child inside container / background block) is not blocked; if the overlap is intentional, pass allowOverlap: true.",
  "tool.status":
    "Board \"{board}\" (dir {dir}): {count} elements.\n" +
    "Drawn: {occupied}\n" +
    "Free spots: {spots}\n" +
    "Available stickers: {stickers}",
  "tool.updated": "✅ Updated element {id} to \"{label}\" (redrew {strokes} strokes). Board now has {count} elements.",
  "tool.removed": "🗑️ Removed element {id}. {count} elements left on the board.",
  "tool.drew":
    "✅ Drew {n} elements ({strokes} strokes) onto board \"{board}\" {url}.\n" +
    "Element IDs: {ids}\n" +
    "Board now: {count} elements{bounds}.\n" +
    "Suggested free spots: {spots}",
  "tool.bounds": ", range x[{minX}-{maxX}] y[{minY}-{maxY}]",

  "board.desc":
    "Manage boards of the hand-drawn canvas. Each board maps to a directory on disk (boards/<name>/): " +
    "canvas state is stored as state.json; resources such as images live in that directory (images/ subdirectory).\n" +
    "list=list all boards; create=create a board (and make it active); switch=switch the active board; delete=delete a board's canvas data (other resource files in the directory are kept).",
  "board.guidelines": [
    "Use handdraw_board to manage boards: list / create / switch / delete. Each board is a directory under boards/ named after the board.",
    "When the user starts a new topic (e.g. a new journal page or a new diagram), create a new board; which board gets drawn on is decided by the board parameter of handdraw_canvas or the active board.",
  ],
  "board.needName": "{action} requires a name parameter.",
  "board.invalidName": "❌ Invalid board name: \"{name}\" (no / \\ .. or leading/trailing spaces/dots; max 60 chars).",
  "board.list": "Boards (active: \"{active}\"):\n{boards}",
  "board.listEmpty": "(no boards yet)",
  "board.item": "- {name} ({count} elements, dir {dir}){current}",
  "board.currentMark": " ←active",
  "board.created": "✅ Created board \"{name}\" (dir {dir}; put resources like images into the images/ subdirectory) and made it active.",
  "board.exists": "Board \"{name}\" already exists; made it active.",
  "board.switched": "✅ Switched to board \"{name}\" ({count} elements).",
  "board.deleted": "🗑️ Deleted canvas data of board \"{name}\" (other resource files in the directory are kept).",
  "board.notFound": "❌ Board \"{name}\" does not exist. Use list to see existing boards.",

  "page.title": "✏️ Live Canvas",
  "page.waiting": "Waiting for AI to draw…",
  "page.strokeUnit": " strokes",
  "page.batchDone": "✅ Batch done",
  "page.cleared": "Canvas cleared",
  "page.restored": "Canvas restored, waiting for AI…",
  "page.disconnected": "Disconnected, reconnecting…",
  "page.removedEl": "🗑️ Removed element {id}",
  "page.fit": "Fit",
  "page.refresh": "Reload",
  "page.clear": "Clear",
  "page.hint": "Scroll to zoom · Drag to pan · Live",
  "page.board": "Board",
};

const DICTS: Record<Lang, Dict> = { zh, en };

/** 取文案（{var} 插值）；缺 key 时回退中文再回退 key 本身 */
export function t(key: string, vars?: Record<string, string | number>, lang: Lang = getLang()): string {
  let s = DICTS[lang][key] ?? DICTS.zh[key] ?? key;
  if (Array.isArray(s)) s = s.join("\n");
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

/** 取文案数组（如指导语列表） */
export function tArr(key: string, lang: Lang = getLang()): string[] {
  const v = DICTS[lang][key] ?? DICTS.zh[key];
  return Array.isArray(v) ? v : [String(v ?? key)];
}

/** 画布页面用的全部 UI 文案（服务器注入页面） */
export function pageStrings(lang: Lang = getLang()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(DICTS.zh)) {
    if (k.startsWith("page.")) out[k.slice(5)] = t(k, undefined, lang);
  }
  return out;
}
