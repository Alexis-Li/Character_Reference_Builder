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

/** Keyboard shortcuts that create nodes in the first local prototype. */
export const MINIMUM_LOOP_NODE_SHORTCUTS = [
  { key: "p", type: "prompt", description: "Add Prompt node" },
  { key: "i", type: "imageInput", description: "Add Image Input node" },
  { key: "g", type: "nanoBanana", description: "Add Generate Image node" },
  { key: "a", type: "annotation", description: "Add Annotation node" },
] as const satisfies ReadonlyArray<{
  key: string;
  type: NodeType;
  description: string;
}>;

export function isMinimumLoopNodeType(type: NodeType | string): type is NodeType {
  return MINIMUM_LOOP_NODE_TYPES.has(type as NodeType);
}

export function minimumLoopNodeTypeForShortcut(key: string): NodeType | null {
  return MINIMUM_LOOP_NODE_SHORTCUTS.find((shortcut) => shortcut.key === key.toLowerCase())?.type ?? null;
}
