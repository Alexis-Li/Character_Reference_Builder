import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

import { FTUXWelcomeStep } from "@/components/onboarding/FTUXWelcomeStep";
import { FTUXModelDefaultsStep } from "@/components/onboarding/FTUXModelDefaultsStep";
import { FTUXApiKeysStep } from "@/components/onboarding/FTUXApiKeysStep";

const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector?: (state: unknown) => unknown) => {
    const state = mockUseWorkflowStore((s: unknown) => s);
    return selector ? selector(state) : state;
  },
  useProviderApiKeys: () => ({
    replicateApiKey: "test-replicate-key",
    falApiKey: null,
    kieApiKey: "test-kie-key",
    wavespeedApiKey: null,
    openaiApiKey: "test-openai-key",
    replicateEnabled: true,
    kieEnabled: true,
    openaiEnabled: true,
  }),
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>(
    "@xyflow/react"
  );
  return {
    ...actual,
    useReactFlow: () => ({
      screenToFlowPosition: (pos: unknown) => pos,
    }),
  };
});

vi.mock("react-dom", async () => {
  const actual = await vi.importActual("react-dom");
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

describe("FTUX minimum image loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector({
        providerSettings: { providers: {} },
        updateProviderApiKey: vi.fn(),
        addNode: vi.fn(),
        incrementModalCount: vi.fn(),
        decrementModalCount: vi.fn(),
        recentModels: [],
        trackModelUsage: vi.fn(),
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

  it("model selector stays within the image-loop providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          models: [
            {
              id: "flux/dev",
              name: "FLUX.1 Dev",
              description: null,
              provider: "fal",
              capabilities: ["text-to-image"],
            },
            {
              id: "stability-ai/sdxl",
              name: "SDXL",
              description: null,
              provider: "replicate",
              capabilities: ["text-to-image"],
            },
          ],
          availableProviders: ["gemini", "fal", "replicate", "openai"],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReactFlowProvider>
        <FTUXModelDefaultsStep />
      </ReactFlowProvider>
    );
    fireEvent.click(screen.getByText("Select"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("providers=");
    });

    // Configured-but-excluded providers never appear, server list included
    expect(screen.queryByTitle("Replicate")).not.toBeInTheDocument();
    expect(screen.queryByTitle("OpenAI")).not.toBeInTheDocument();
    expect(screen.getByTitle("Gemini")).toBeInTheDocument();
    expect(screen.getByTitle("fal.ai")).toBeInTheDocument();
    expect(screen.queryByText("SDXL")).not.toBeInTheDocument();
    const capabilitySelect = screen.getByDisplayValue("Image") as HTMLSelectElement;
    expect(capabilitySelect).toBeDisabled();
  });
});
