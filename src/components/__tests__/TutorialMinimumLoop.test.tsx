import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

import { TutorialOverlay } from "@/components/onboarding/TutorialOverlay";
import {
  MINIMUM_LOOP_NODE_TYPES,
  isMinimumLoopNodeType,
} from "@/config/minimumLoop";

const mockAddNode = vi.fn();
const mockOnConnect = vi.fn();
const mockUpdateNodeData = vi.fn();
const mockCompleteCurrentStep = vi.fn();
const mockNextTutorialStep = vi.fn();

const workflowHookState = {
  nodes: [
    {
      id: "gen-1",
      type: "nanoBanana",
      position: { x: 0, y: 0 },
      data: {},
    },
  ],
  edges: [],
  updateNodeData: (...args: unknown[]) => mockUpdateNodeData(...args),
};

const workflowStoreSnapshot = {
  nodes: workflowHookState.nodes,
  addNode: (...args: unknown[]) => {
    mockAddNode(...args);
    return `node-${mockAddNode.mock.calls.length}`;
  },
  onConnect: (...args: unknown[]) => mockOnConnect(...args),
  updateNodeData: (...args: unknown[]) => mockUpdateNodeData(...args),
};

const ftuxState = {
  tutorialActive: true,
  currentTutorialStep: 0,
  tutorialSteps: [
    { id: "demonstrate-downstream", completed: false, message: "demo" },
  ],
  completeCurrentStep: (...args: unknown[]) =>
    mockCompleteCurrentStep(...args),
  nextTutorialStep: (...args: unknown[]) => mockNextTutorialStep(...args),
  skipTutorial: vi.fn(),
  connectionMenuShown: false,
  nanoBananaAddedFromMenu: false,
  tutorialSampleImage: null,
};

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign(
    (selector?: (state: unknown) => unknown) =>
      selector ? selector(workflowHookState) : workflowHookState,
    { getState: () => workflowStoreSnapshot }
  ),
}));

vi.mock("@/store/ftuxStore", () => ({
  useFTUXStore: (selector: (state: unknown) => unknown) =>
    selector(ftuxState),
}));

vi.mock("@/components/onboarding/ElementHighlight", () => ({
  ElementHighlight: () => null,
}));

vi.mock("@/components/onboarding/TutorialMessage", () => ({
  TutorialMessage: () => null,
}));

describe("TutorialOverlay minimum-loop demonstration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("demonstrates downstream with minimum-loop nodes only", () => {
    render(<TutorialOverlay />);

    act(() => {
      vi.runAllTimers();
    });

    expect(mockAddNode.mock.calls.length).toBeGreaterThan(0);
    for (const [nodeType] of mockAddNode.mock.calls) {
      expect(isMinimumLoopNodeType(nodeType as string)).toBe(true);
      expect(MINIMUM_LOOP_NODE_TYPES.has(nodeType as never)).toBe(true);
    }
    const createdTypes = mockAddNode.mock.calls.map(([type]) => type);
    expect(createdTypes).not.toContain("generateVideo");
    expect(createdTypes).not.toContain("llmGenerate");
    expect(createdTypes).not.toContain("videoInput");
  });
});
