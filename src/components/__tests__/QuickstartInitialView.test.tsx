import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickstartInitialView } from "@/components/quickstart/QuickstartInitialView";

describe("QuickstartInitialView", () => {
  const renderView = () => {
    const onNewProject = vi.fn();
    const onSelectLoad = vi.fn();
    render(
      <QuickstartInitialView
        onNewProject={onNewProject}
        onSelectLoad={onSelectLoad}
      />
    );
    return { onNewProject, onSelectLoad };
  };

  it("shows only the minimum project entry points", () => {
    renderView();

    expect(screen.getByText("Node Banana")).toBeInTheDocument();
    expect(screen.getByText("New project")).toBeInTheDocument();
    expect(screen.getByText("Load workflow")).toBeInTheDocument();
    expect(screen.queryByText("Templates")).not.toBeInTheDocument();
    expect(screen.queryByText("Prompt a workflow")).not.toBeInTheDocument();
  });

  it("describes the image reference loop without non-minimum media entries", () => {
    renderView();

    expect(
      screen.getByText(/focused node-based workflow editor/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/video|audio|3d/i)).not.toBeInTheDocument();
  });

  it("calls the project actions", () => {
    const { onNewProject, onSelectLoad } = renderView();

    fireEvent.click(screen.getByText("New project"));
    fireEvent.click(screen.getByText("Load workflow"));

    expect(onNewProject).toHaveBeenCalledTimes(1);
    expect(onSelectLoad).toHaveBeenCalledTimes(1);
  });

  it("keeps documentation available without exposing community or paid links", () => {
    renderView();

    const docsLink = screen.getByText("Docs").closest("a");
    expect(docsLink).toHaveAttribute("href", "https://node-banana-docs.vercel.app/");
    expect(screen.queryByText("Discord")).not.toBeInTheDocument();
    expect(screen.queryByText("NB Pro Waitlist")).not.toBeInTheDocument();
  });
});
