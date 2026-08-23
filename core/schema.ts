/**
 * core/schema.ts — 工具参数 JSON Schema（pi 的 typebox 和 MCP 的 inputSchema 都兼容纯 JSON Schema）
 *
 * 纯数据，无运行时依赖。ELEMENT_SCHEMA 是全部画布元素的 union。
 */

const zProp = { type: "number", description: "叠放层次：小的在下面；不设则后画的在上" };

const descProp = {
  type: "string",
  description:
    "该对象的详细说明（1~2 句）：架构图写节点职责/关键交互；手帐/旅行规划写描述或小 tips。双击浮窗展示，必填",
};

const boxLike = (literal: "box" | "ellipse" | "diamond") => ({
  type: "object",
  properties: {
    type: { const: literal },
    x: { type: "number", description: "左上角 x（画布绝对坐标）" },
    y: { type: "number", description: "左上角 y（画布绝对坐标）" },
    w: { type: "number", description: "宽度，默认 160" },
    h: { type: "number", description: "高度，默认 70" },
    text: { type: "string", description: "形状内文字，默认居中" },
    textPosition: {
      anyOf: [{ const: "center" }, { const: "top" }],
      description:
        "文字位置：center=居中（默认，叶子节点用）；top=框内顶部（容器/模块框的标题用，此时框内其他内容从 y+50 以下开始排，不要覆盖标题）",
    },
    color: { type: "string", description: "描边颜色，如 #c0392b" },
    fill: { type: "string", description: "填充颜色，如 #fdebd0" },
    fillStyle: {
      type: "string",
      description: "填充风格：hachure(手绘斜线)/solid/zigzag/cross-hatch，默认 hachure",
    },
    textSize: { type: "number", description: "文字大小，默认 16" },
    desc: descProp,
    z: zProp,
  },
  required: ["type", "x", "y"],
});

export const ELEMENT_SCHEMA = {
  anyOf: [
    boxLike("box"),
    boxLike("ellipse"),
    boxLike("diamond"),
    {
      type: "object",
      properties: {
        type: { const: "line" },
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        color: { type: "string" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "x1", "y1", "x2", "y2"],
    },
    {
      type: "object",
      properties: {
        type: { const: "arrow" },
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        text: { type: "string", description: "箭头上的说明文字" },
        color: { type: "string" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "x1", "y1", "x2", "y2"],
    },
    {
      type: "object",
      properties: {
        type: { const: "text" },
        x: { type: "number", description: "单行：文字中心 x；多行（含 \\n 或设了 w）：段落左上角 x" },
        y: { type: "number", description: "单行：文字中心 y；多行：段落左上角 y" },
        text: { type: "string", description: "文字内容，\\n 分行" },
        size: { type: "number", description: "字号，默认 16" },
        color: { type: "string" },
        w: { type: "number", description: "段落宽度：设置后开启自动换行（多行模式）" },
        lineHeight: { type: "number", description: "行距（字号倍数，默认 1.6，仅多行）" },
        align: { anyOf: [{ const: "left" }, { const: "center" }, { const: "right" }], description: "对齐（仅多行，默认 left）" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "x", "y", "text"],
    },
    {
      type: "object",
      properties: {
        type: { const: "sticker" },
        name: { type: "string", description: "贴纸名（从 status 返回的 stickers 列表里选，不要编造）" },
        x: { type: "number", description: "左上角 x" },
        y: { type: "number", description: "左上角 y" },
        size: { type: "number", description: "边长，默认 80" },
        color: { type: "string", description: "整体覆盖描边色（不设用贴纸自带配色）" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "name", "x", "y"],
    },
    {
      type: "object",
      properties: {
        type: { const: "image" },
        src: {
          type: "string",
          description:
            "图片来源：http(s):// URL、data:image/...;base64,...、或画板 images/ 目录下的文件名（如 photo.png，文件需已存在）",
        },
        x: { type: "number", description: "左上角 x" },
        y: { type: "number", description: "左上角 y" },
        w: { type: "number", description: "显示宽度" },
        h: { type: "number", description: "显示高度" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "src", "x", "y", "w", "h"],
    },
    {
      type: "object",
      properties: {
        type: { const: "path" },
        d: { type: "string", description: "SVG path 数据" },
        color: { type: "string" },
        fill: { type: "string" },
        desc: descProp,
        z: zProp,
      },
      required: ["type", "d"],
    },
  ],
};

export const PARAMS_SCHEMA = {
  type: "object",
  properties: {
    action: {
      anyOf: [{ const: "draw" }, { const: "update" }, { const: "remove" }, { const: "status" }, { const: "clear" }],
      description:
        "draw=画新元素（默认）；update=修改已有元素（用 elementId）；remove=删除元素；status=只查询画布状态；clear=清空整个画布（仅用户明确要求时用）",
    },
    board: { type: "string", description: "目标画板名（默认当前画板；画板管理用 handdraw_board 工具）" },
    elementId: { type: "string", description: "要修改/删除的元素 ID（从上次返回的摘要或 occupied 列表获取）" },
    elements: { type: "array", items: ELEMENT_SCHEMA, description: "本次要画的元素（draw 用）或新元素（update 用）" },
    taskId: { type: "string", description: "工蚁任务 ID（仅异步工蚁绘图时使用）" },
    region: {
      type: "object",
      description: "工蚁任务允许区域；工蚁绘制的元素必须完全位于其中",
      properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
      required: ["x", "y", "w", "h"],
    },
    allowOverlap: {
      type: "boolean",
      description:
        "是否允许覆盖已有内容（默认 false：新元素与已占用区域部分重叠会被直接拒绝；完全包含关系如容器装子元素/底色块垫文字不受限。仅当确实需要有意的叠加效果时设 true）",
    },
  },
  required: ["elements"],
};

export const DELEGATE_PARAMS_SCHEMA = {
  type: "object",
  properties: {
    board: { type: "string", description: "目标画板名" },
    tasks: {
      type: "array",
      description: "严格四工蚁模式：必须一次提交恰好 4 个互不重叠的独立绘图任务，每个任务由一只工蚁执行",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "任务 ID；不填则自动生成" },
          title: { type: "string", description: "任务简短标题" },
          region: {
            type: "object",
            description: "工蚁允许工作的区域，x/y 为左上角",
            properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
            required: ["x", "y", "w", "h"],
          },
          instructions: { type: "string", description: "给工蚁的绘图说明" },
        },
        required: ["region", "instructions"],
      },
    },
  },
  required: ["tasks"],
};

export const BOARD_PARAMS_SCHEMA = {
  type: "object",
  properties: {
    action: {
      anyOf: [{ const: "list" }, { const: "create" }, { const: "switch" }, { const: "delete" }],
      description: "list=列出所有画板；create=新建画板（并设为当前）；switch=切换当前画板；delete=删除画板画布数据",
    },
    name: { type: "string", description: "画板名（create/switch/delete 必填）；会建成 boards/<画板名>/ 目录" },
  },
  required: ["action"],
};
