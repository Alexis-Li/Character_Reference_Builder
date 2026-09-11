import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { FTUXWelcomeStep } from "@/components/onboarding/FTUXWelcomeStep";
import { FTUXModelDefaultsStep } from "@/components/onboarding/FTUXModelDefaultsStep";
import { FTUXApiKeysStep } from "@/components/onboarding/FTUXApiKeysStep";

const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector: (state: unknown) => unknown) =>
    mockUseWorkflowStore(selector),
}));

describe("FTUX minimum image loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector({
        providerSettings: { providers: {} },
        updateProviderApiKey: vi.fn(),
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) })
    );
  });

  it("welcome copy stays on reference images", () => {
    render(<FTUXWelcomeStep />);
    expect(screen.getByText(/reference images/i)).toBeInTheDocument();
    expect(screen.queryByText(/videos/i)).not.toBeInTheDocument();
  });

  it("model defaults expose only the image model", () => {
    render(<FTUXModelDefaultsStep />);
    expect(screen.getByText("Default Image Model")).toBeInTheDocument();
    expect(screen.queryByText("Default Video Model")).not.toBeInTheDocument();
    expect(screen.queryByText("videos")).not.toBeInTheDocument();
  });

  it("api keys expose only the image-loop providers", () => {
    render(<FTUXApiKeysStep />);
    expect(screen.getByText("Google Gemini")).toBeInTheDocument();
    expect(screen.getByText("fal.ai")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByText("Replicate")).not.toBeInTheDocument();
    expect(screen.queryByText("Kie.ai")).not.toBeInTheDocument();
    expect(screen.queryByText("WaveSpeed")).not.toBeInTheDocument();
  });
});
