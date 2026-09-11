import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

import { OutputGalleryNode } from "@/components/nodes/OutputGalleryNode";

const mockAddNode = vi.fn();
const mockSetNodes = vi.fn();
const mockGetNodes = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector: (state: unknown) => unknown) =>
    mockUseWorkflowStore(selector),
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>(
    "@xyflow/react"
  );
  return {
    ...actual,
    useReactFlow: () => ({
      getNodes: (...args: unknown[]) => mockGetNodes(...args),
      setNodes: (...args: unknown[]) => mockSetNodes(...args),
    }),
  };
});

vi.mock("@/hooks/useAdaptiveImageSrc", () => ({
  useAdaptiveImageSrc: (src: string) => src,
}));

vi.mock("@/hooks/useVideoBlobUrl", () => ({
  useVideoBlobUrl: (src: string | null) => src,
}));

vi.mock("@/hooks/useShowHandleLabels", () => ({
  useShowHandleLabels: () => false,
}));

function TestWrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

describe("OutputGalleryNode minimum-loop extract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector({
        updateNodeData: vi.fn(),
        addNode: (...args: unknown[]) => mockAddNode(...args),
        currentNodeIds: [],
        setHoveredNodeId: vi.fn(),
        hoveredNodeId: null,
      })
    );
    mockAddNode.mockReturnValue("new-node-id");
    mockGetNodes.mockReturnValue([
      {
        id: "gallery-1",
        position: { x: 0, y: 0 },
        measured: { width: 200 },
      },
    ]);
  });

  it("extracts images without creating videoInput nodes", () => {
    render(
      <TestWrapper>
        <OutputGalleryNode
          id="gallery-1"
          type="outputGallery"
          selected={false}
          data={{
            images: ["data:image/png;base64,aaa", "data:image/png;base64,bbb"],
            videos: ["data:video/mp4;base64,ccc"],
          } as never}
        />
      </TestWrapper>
    );

    fireEvent.click(screen.getByText("Extract"));

    expect(mockAddNode).toHaveBeenCalledTimes(2);
    for (const call of mockAddNode.mock.calls) {
      expect(call[0]).toBe("imageInput");
    }
    expect(mockAddNode).not.toHaveBeenCalledWith(
      "videoInput",
      expect.anything(),
      expect.anything()
    );
  });

  it("blank gallery shows image-only affordances", () => {
    render(
      <TestWrapper>
        <OutputGalleryNode
          id="gallery-1"
          type="outputGallery"
          selected={false}
          data={{ images: [], videos: [] } as never}
        />
      </TestWrapper>
    );

    expect(
      screen.getByText("Connect image nodes to view gallery")
    ).toBeInTheDocument();
    expect(screen.queryByText("Video")).not.toBeInTheDocument();
    expect(screen.queryByText("Extract")).not.toBeInTheDocument();
  });

  it("legacy videos stay view-only without video handles or extract", () => {
    render(
      <TestWrapper>
        <OutputGalleryNode
          id="gallery-1"
          type="outputGallery"
          selected={false}
          data={{ images: [], videos: ["data:video/mp4;base64,ccc"] } as never}
        />
      </TestWrapper>
    );

    expect(screen.getByText("Legacy")).toBeInTheDocument();
    expect(screen.queryByText("Video")).not.toBeInTheDocument();
    expect(screen.queryByText("Extract")).not.toBeInTheDocument();
    expect(mockAddNode).not.toHaveBeenCalled();
  });
});
