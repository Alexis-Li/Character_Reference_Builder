import type { NodeType } from "@/types";

/** Nodes exposed by the first local prototype navigation. */
export const MINIMUM_LOOP_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "imageInput",
  "annotation",
  "prompt",
  "nanoBanana",
  "imageCompare",
  "outputGallery",
  "output",
]);

export function isMinimumLoopNodeType(type: NodeType | string): type is NodeType {
  return MINIMUM_LOOP_NODE_TYPES.has(type as NodeType);
}
