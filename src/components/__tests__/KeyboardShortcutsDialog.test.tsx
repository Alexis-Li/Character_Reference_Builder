import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog";

describe("KeyboardShortcutsDialog", () => {
  it("only advertises node shortcuts from the minimum loop", () => {
    render(<KeyboardShortcutsDialog isOpen onClose={vi.fn()} />);

    expect(screen.getByText("Add Prompt node")).toBeInTheDocument();
    expect(screen.getByText("Add Image Input node")).toBeInTheDocument();
    expect(screen.getByText("Add Generate Image node")).toBeInTheDocument();
    expect(screen.getByText("Add Annotation node")).toBeInTheDocument();

    expect(screen.queryByText("Add Generate Video node")).not.toBeInTheDocument();
    expect(screen.queryByText("Add LLM Text node")).not.toBeInTheDocument();
    expect(screen.queryByText("Add Audio node")).not.toBeInTheDocument();
    expect(screen.queryByText("Add Video Input node")).not.toBeInTheDocument();
    expect(screen.queryByText("Add Array node")).not.toBeInTheDocument();
    expect(screen.queryByText("Add ComfyUI App node")).not.toBeInTheDocument();
  });
});
