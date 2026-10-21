import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkflowBrowserView } from "../quickstart/WorkflowBrowserView";
import { WORKFLOWS_DIRECTORY_KEY } from "@/store/utils/localStorage";

beforeEach(() => localStorage.removeItem(WORKFLOWS_DIRECTORY_KEY));
afterEach(() => vi.unstubAllGlobals());

describe("opening a saved project by directory path", () => {
  it("loads through the existing workflow route without a native picker or generation", async () => {
    const workflow = { version: 1, nodes: [], edges: [] };
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: true, workflow }) });
    vi.stubGlobal("fetch", fetch);
    const loaded = vi.fn(), close = vi.fn();
    render(<WorkflowBrowserView onWorkflowLoaded={loaded} onClose={close} />);
    expect(screen.getByText("按路径打开项目")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("项目目录路径"), { target: { value: "  E:/projects/wolf copy  " } });
    fireEvent.click(screen.getByText("按路径打开项目"));
    await waitFor(() => expect(loaded).toHaveBeenCalledWith(workflow, "E:/projects/wolf copy"));
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/workflow?path=E%3A%2Fprojects%2Fwolf%20copy&load=true");
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the path and current project on failure so the user can correct it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ success: false, error: "Project file missing" }) }));
    const loaded = vi.fn(), close = vi.fn();
    render(<WorkflowBrowserView onWorkflowLoaded={loaded} onClose={close} />);
    fireEvent.change(screen.getByLabelText("项目目录路径"), { target: { value: "E:/projects/missing" } });
    fireEvent.click(screen.getByText("按路径打开项目"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Project file missing");
    expect(screen.getByLabelText("项目目录路径")).toHaveValue("E:/projects/missing");
    expect(loaded).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByText("按路径打开项目")).toBeEnabled();
  });

  it("also offers direct opening when a listing directory is already configured", async () => {
    localStorage.setItem(WORKFLOWS_DIRECTORY_KEY, "E:/projects");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ success: true, workflows: [] }) }));
    render(<WorkflowBrowserView onWorkflowLoaded={vi.fn()} />);
    await screen.findByText("E:/projects");
    expect(screen.getByLabelText("项目目录路径")).toBeVisible();
  });
});
