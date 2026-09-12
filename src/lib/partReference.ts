import {
  effectiveConstraints,
  type CharacterProject,
} from "./characterProject";
import preset from "../../presets/workflows/part-reference.json";

export const PART_REFERENCE_PRESET = preset;

export function partReferencePrompt(
  project: CharacterProject,
  partId: string,
  view: string,
  instruction: string,
) {
  const part = project.parts.find((item) => item.id === partId);
  if (!part) throw new Error("请先确认目标部件");
  return [
    `生成建模部件「${part.name}」的${view}参考，只输出此视图。`,
    "以导入原画为设计依据；保留视图仅用于一致性参考，不修改它们。",
    ...effectiveConstraints(project, partId),
    instruction,
    "不可见、遮挡且无资料支持的细节属于推测，不得视为已确认设计。",
  ]
    .filter(Boolean)
    .join("\n");
}
