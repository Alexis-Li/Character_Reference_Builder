/**
 * What the run route refuses to submit.
 *
 * Validation and the split loop have to agree on what "present" means. When
 * they did not, an empty string sent for a required input was present enough to
 * pass the check and absent enough to be skipped by the loop — so the job went
 * to the engine with nothing patched in, and the user got a render from the
 * workflow author's saved value instead of the curated 400.
 *
 * Requests carry the real local-session envelope: the privileged guard runs for
 * real, and only what the engine returns is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ComfyAppDefinition } from "@/lib/comfy/types";
import { localApiNextRequest, TEST_LOCAL_ORIGIN } from "@/test/localApiRequest";

const submit = vi.fn();
const uploadInputs = vi.fn();

vi.mock("@/lib/comfy/server", () => ({
  engineFromRequest: () => ({
    engine: { submit, label: "Comfy Cloud" },
    orgApiKey: null,
  }),
}));

vi.mock("@/lib/comfy/server/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comfy/server/run")>()),
  uploadInputs,
}));

const { POST } = await import("../run/route");

const app = {
  id: "app-1",
  name: "App",
  description: "",
  source: "upload",
  graph: {
    "3": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
    "9": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
  },
  inputs: [
    {
      id: "3:text",
      name: "prompt",
      label: "Prompt",
      type: "text" as const,
      nodeId: "3",
      inputKey: "text",
      required: true,
    },
  ],
  params: [],
  outputs: [
    { id: "9", label: "Result", type: "image" as const, nodeId: "9", classType: "SaveImage" },
  ],
  classTypes: ["CLIPTextEncode", "SaveImage"],
  nodeCount: 2,
  createdAt: 0,
} satisfies ComfyAppDefinition;

const call = (inputs: Record<string, string>) =>
  POST(
    localApiNextRequest(`${TEST_LOCAL_ORIGIN}/api/comfy/run`, {
      method: "POST",
      body: JSON.stringify({ app, inputs }),
    }),
    // The guarded handler is typed with its context argument; these routes take
    // no dynamic segment, so it is empty. The guard itself runs for real.
    { params: Promise.resolve({}) }
  );

beforeEach(() => {
  submit.mockReset().mockResolvedValue("job-1");
  uploadInputs.mockReset().mockResolvedValue({});
});

describe("POST /api/comfy/run", () => {
  it("submits when the required input carries text", async () => {
    const body = await (await call({ prompt: "a dog" })).json();

    expect(body).toMatchObject({ success: true, jobId: "job-1" });
    expect(submit).toHaveBeenCalledOnce();
    const graph = submit.mock.calls[0]![0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["3"]!.inputs.text).toBe("a dog");
  });

  it("refuses an empty string for a required input instead of running the author's value", async () => {
    const response = await call({ prompt: "" });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Prompt");
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses an absent required input", async () => {
    const response = await call({});

    expect(response.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports the missing input before spending anything on uploads", async () => {
    // Decoding and hashing media for a run that cannot be submitted is work
    // thrown away, and on a large image it is not cheap work.
    //
    // The successful call comes first on purpose: "was not called" says nothing
    // unless the mock is known to be reached when the route does get that far.
    await call({ prompt: "a dog" });
    expect(uploadInputs).toHaveBeenCalledOnce();

    uploadInputs.mockClear();
    await call({});
    expect(uploadInputs).not.toHaveBeenCalled();
  });
});
