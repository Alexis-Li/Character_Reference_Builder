// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { externalizeWorkflowMedia, hydrateWorkflowMedia } from "../mediaStorage";
import { sanitizePortableValue } from "@/lib/projectFiles.server";
import type { WorkflowFile } from "@/store/workflowStore";
import type { NanoBananaNodeData } from "@/types";

afterEach(() => vi.unstubAllGlobals());
function workflow(image: string): WorkflowFile {
  return { version: 1, name: "saved-project", edges: [], nodes: [{ id: "gen", type: "nanoBanana", position: { x: 0, y: 0 }, data: {
    outputImage: image, inputImages: [], selectedHistoryId: "older-candidate", selectedHistoryIndex: 1,
    imageHistory: [{ id: "new-candidate", assetId: "new-blob" }, { id: "older-candidate", assetId: "selected-blob" }],
  } }] } as WorkflowFile;
}

describe("saved image bytes remain usable for refinement", () => {
  it("externalizes the selected output, then rehydrates its exact bytes after portable save", async () => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).jpeg().toBuffer();
    const image = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    const fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ imageId: "selected-blob", imageData: image, folder: "generations" });
        return Response.json({ success: true, imageId: body.imageId });
      }
      expect(url).toContain("imageId=selected-blob");
      return Response.json({ success: true, image });
    });
    vi.stubGlobal("fetch", fetch);
    const saved = sanitizePortableValue(await externalizeWorkflowMedia(workflow(image), "E:/projects/saved"));
    expect(saved.nodes[0].data).toMatchObject({ outputImage: null, outputImageRef: "selected-blob" });
    const reopened = await hydrateWorkflowMedia(saved, "E:/projects/saved");
    expect((reopened.nodes[0].data as NanoBananaNodeData).outputImage).toBe(image);
  });

  it("recovers older path-redacted inline output from its independently stored candidate asset", async () => {
    const image = "data:image/png;base64,aGVsbG8=";
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, image }));
    vi.stubGlobal("fetch", fetch);
    const reopened = await hydrateWorkflowMedia(workflow("data:image/png;base64,abc[local-path-redacted]"), "E:/projects/saved");
    expect((reopened.nodes[0].data as NanoBananaNodeData).outputImage).toBe(image);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves opaque raster data in embedded mode while still redacting text paths and credentials", async () => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).jpeg().toBuffer();
    const image = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    const saved = sanitizePortableValue({ ...workflow(image), note: "E:/private/character", access_token: "private" });
    expect((saved.nodes[0].data as NanoBananaNodeData).outputImage).toBe(image);
    expect(saved.note).toBe("[local-path-redacted]");
    expect(saved).not.toHaveProperty("access_token");
  });

  it.each(["index", "ref"])("still recovers legacy %s-only selection", async kind => {
    const saved = workflow("unused");
    const data = saved.nodes[0].data as NanoBananaNodeData;
    data.outputImage = null;
    delete data.selectedHistoryId;
    if (kind === "ref") {
      delete data.selectedHistoryIndex;
      data.outputImageRef = "selected-blob";
    }
    const image = "data:image/png;base64,aGVsbG8=";
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, image }));
    vi.stubGlobal("fetch", fetch);
    const reopened = await hydrateWorkflowMedia(saved, "E:/projects/saved");
    expect((reopened.nodes[0].data as NanoBananaNodeData).outputImage).toBe(image);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toContain("imageId=selected-blob");
  });

  it("does not select history when a legacy project has neither selection nor output reference", async () => {
    const saved = workflow("unused");
    const data = saved.nodes[0].data as NanoBananaNodeData;
    data.outputImage = null;
    delete data.selectedHistoryId;
    delete data.selectedHistoryIndex;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const reopened = await hydrateWorkflowMedia(saved, "E:/projects/saved");
    expect((reopened.nodes[0].data as NanoBananaNodeData).outputImage).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
