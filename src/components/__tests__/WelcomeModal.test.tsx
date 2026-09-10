import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WelcomeModal } from "@/components/quickstart/WelcomeModal";
import { WorkflowFile } from "@/store/workflowStore";

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock("@/components/quickstart/WorkflowBrowserView", () => ({
  WorkflowBrowserView: ({
    onBack,
    onWorkflowLoaded,
    onClose,
  }: {
    onBack: () => void;
    onWorkflowLoaded: (workflow: WorkflowFile, directoryPath: string) => void;
    onClose: () => void;
  }) => (
    <div data-testid="workflow-browser-view">
      <button onClick={onBack}>Back</button>
      <button
        data-testid="load-workflow-btn"
        onClick={() =>
          onWorkflowLoaded(
            { version: 1, nodes: [], edges: [], name: "Test" } as unknown as WorkflowFile,
            "/test/dir"
          )
        }
      >
        Load
      </button>
      <button data-testid="close-browser-btn" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

describe("WelcomeModal", () => {
  const mockOnWorkflowGenerated = vi.fn();
  const mockOnClose = vi.fn();
  const mockOnNewProject = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, workflows: [] }),
    });
  });

  const renderModal = () =>
    render(
      <WelcomeModal
        onWorkflowGenerated={mockOnWorkflowGenerated}
        onClose={mockOnClose}
        onNewProject={mockOnNewProject}
      />
    );

  it("starts with only the minimum navigation", () => {
    renderModal();

    expect(screen.getByText("Node Banana")).toBeInTheDocument();
    expect(screen.getByText("New project")).toBeInTheDocument();
    expect(screen.getByText("Load workflow")).toBeInTheDocument();
    expect(screen.queryByText("Templates")).not.toBeInTheDocument();
    expect(screen.queryByText("Prompt a workflow")).not.toBeInTheDocument();
  });

  it("forwards the new project action", () => {
    renderModal();

    fireEvent.click(screen.getByText("New project"));

    expect(mockOnNewProject).toHaveBeenCalledTimes(1);
  });

  it("opens the workflow browser and can return", () => {
    renderModal();

    fireEvent.click(screen.getByText("Load workflow"));
    expect(screen.getByTestId("workflow-browser-view")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("Node Banana")).toBeInTheDocument();
  });

  it("forwards a loaded workflow and its directory", () => {
    renderModal();

    fireEvent.click(screen.getByText("Load workflow"));
    fireEvent.click(screen.getByTestId("load-workflow-btn"));

    expect(mockOnWorkflowGenerated).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, nodes: [], edges: [] }),
      "/test/dir"
    );
  });

  it("closes when the overlay is clicked", () => {
    const { container } = renderModal();
    const overlay = container.firstElementChild;

    fireEvent.click(overlay!);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });
});
