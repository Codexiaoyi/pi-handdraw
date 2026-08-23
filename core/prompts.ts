/**
 * core/prompts.ts — 工具文案（i18n 包装）
 *
 * pi 扩展拿 description + guidelines 分开注册；MCP 没有 guidelines 概念，用 *Full 合并版。
 */
import { t, tArr, getLang, type Lang } from "../i18n";

export function toolDescription(lang: Lang = getLang()): string {
  return t("tool.desc", undefined, lang);
}
export function toolGuidelines(lang: Lang = getLang()): string[] {
  return tArr("tool.guidelines", lang);
}
/** MCP 用：描述 + 指导语合并（MCP 没有 promptGuidelines，全部放进 description） */
export function toolDescriptionFull(lang: Lang = getLang()): string {
  return t("tool.desc", undefined, lang) + "\n\n" + toolGuidelines(lang).map((g) => `- ${g}`).join("\n");
}
export function boardToolDescription(lang: Lang = getLang()): string {
  return t("board.desc", undefined, lang);
}
export function boardToolDescriptionFull(lang: Lang = getLang()): string {
  return t("board.desc", undefined, lang) + "\n\n" + tArr("board.guidelines", lang).map((g) => `- ${g}`).join("\n");
}
export function boardToolGuidelines(lang: Lang = getLang()): string[] {
  return tArr("board.guidelines", lang);
}
export function delegateToolDescription(lang: Lang = getLang()): string {
  return t("delegate.desc", undefined, lang);
}
export function delegateToolGuidelines(lang: Lang = getLang()): string[] {
  return tArr("delegate.guidelines", lang);
}
