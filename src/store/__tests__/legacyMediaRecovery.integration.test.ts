import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { useWorkflowStore, type WorkflowFile } from "../workflowStore";
import { readSessionMedia } from "../execution/sessionMedia";
import { readRecoverableJson, savePortableWorkflow, type PersistableWorkflow } from "@/lib/projectFiles.server";
import type { NanoBananaNodeData } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

describe("R-004 legacy output reference disagrees with the selected candidate", () => {
  let directory: string;
  let a: Buffer;
  let b: Buffer;
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const dataUrl = (bytes: Buffer) => `data:image/jpeg;base64,${bytes.toString("base64")}`;

  beforeEach(async () => {
    useWorkflowStore.getState().clearWorkflow();
    const tempRoot = process.env.CRB_TEMP_ROOT ?? path.resolve("../.tmp");
    await fs.mkdir(tempRoot, { recursive: true });
    directory = await fs.mkdtemp(path.join(tempRoot, "crb-12-recovery-"));
    await fs.mkdir(path.join(directory, "generations"));
    [a, b] = await Promise.all(["red", "blue"].map(background =>
      sharp({ create: { width: 4, height: 4, channels: 3, background } }).jpeg().toBuffer()));
    await fs.writeFile(path.join(directory, "generations/blob-a.jpg"), a);
    await fs.writeFile(path.join(directory, "generations/blob-b.jpg"), b);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/workflow-images?")) {
        const id = new URLSearchParams(url.split("?")[1]).get("imageId")!;
        try {
          const bytes = await fs.readFile(path.join(directory, "generations", `${id}.jpg`));
          return Response.json({ success: true, image: dataUrl(bytes) });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return Response.json({ success: false, notFound: true });
        }
      }
      const body = JSON.parse(String(init?.body));
      if (url === "/api/workflow-images") {
        await fs.writeFile(path.join(directory, "generations", `${body.imageId}.jpg`),
          Buffer.from(body.imageData.split(",")[1], "base64"));
        return Response.json({ success: true, imageId: body.imageId });
      }
      if (url === "/api/workflow") {
        await savePortableWorkflow(directory, path.join(directory, "legacy-recovery.json"), body.workflow);
        return Response.json({ success: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(async () => {
    useWorkflowStore.getState().clearWorkflow();
    vi.unstubAllGlobals();
    expect(path.basename(directory)).toMatch(/^crb-12-recovery-/);
    await fs.rm(directory, { recursive: true, force: true });
  });

  function legacy(outputImage: string | null): WorkflowFile {
    return { version: 1, id: "legacy-recovery", name: "legacy-recovery", edges: [], nodes: [{
      id: "gen", type: "nanoBanana", position: { x: 0, y: 0 }, data: {
        inputImages: [], outputImage, outputImageRef: "blob-a", selectedHistoryId: "candidate-b",
        selectedHistoryIndex: 0,
        imageHistory: [{ id: "candidate-a", assetId: "blob-a" }, { id: "candidate-b", assetId: "blob-b" }],
      },
    }] } as WorkflowFile;
  }

  it.each(["data:image/jpeg;base64,abc[local-path-redacted]", null])(
    "loads selected B instead of stale A, then saves both original hashes (inline %s)", async outputImage => {
      await useWorkflowStore.getState().loadWorkflow(legacy(outputImage), directory);
      const loaded = useWorkflowStore.getState();
      expect((loaded.nodes[0].data as NanoBananaNodeData).outputImage).toBe(dataUrl(b));
      expect(readSessionMedia("candidate-b")).toBe(dataUrl(b));
      expect(loaded.characterProject?.selection).toEqual({ "gen@default": "candidate-b" });

      expect(await loaded.saveToFile()).toBe(true);
      const saved = await readRecoverableJson<PersistableWorkflow>(path.join(directory, "legacy-recovery.json"));
      expect(saved.nodes![0].data).toMatchObject({ selectedHistoryId: "candidate-b", outputImageRef: "blob-b", outputImage: null });
      expect(saved.characterProject?.selection).toEqual({ "gen@default": "candidate-b" });
      expect(saved.assetManifest?.assets.find(asset => asset.candidateId === "candidate-b")?.sha256).toBe(digest(b));
      expect(digest(await fs.readFile(path.join(directory, "generations/blob-a.jpg")))).toBe(digest(a));
      expect(digest(await fs.readFile(path.join(directory, "generations/blob-b.jpg")))).toBe(digest(b));
    });

  it("keeps missing B unresolved without caching or writing A under B", async () => {
    await fs.unlink(path.join(directory, "generations/blob-b.jpg"));
    await useWorkflowStore.getState().loadWorkflow(legacy("data:image/jpeg;base64,abc[local-path-redacted]"), directory);
    expect((useWorkflowStore.getState().nodes[0].data as NanoBananaNodeData).outputImage).toBeNull();
    expect(readSessionMedia("candidate-b")).toBeNull();
    expect(await useWorkflowStore.getState().saveToFile()).toBe(false);
    expect(digest(await fs.readFile(path.join(directory, "generations/blob-a.jpg")))).toBe(digest(a));
    await expect(fs.stat(path.join(directory, "generations/blob-b.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an explicit clear through save, reopen and downstream input resolution (R-006)", async () => {
    const workflow = legacy(dataUrl(b));
    workflow.nodes.push({ id: "consumer", type: "nanoBanana", position: { x: 100, y: 0 },
      data: { inputImages: [], outputImage: null } } as WorkflowFile["nodes"][number]);
    workflow.edges.push({ id: "image-edge", source: "gen", target: "consumer", sourceHandle: "image", targetHandle: "image" });
    await useWorkflowStore.getState().loadWorkflow(workflow, directory);
    useWorkflowStore.getState().clearNodeSelection("gen");
    expect(await useWorkflowStore.getState().saveToFile()).toBe(true);
    const saved = await readRecoverableJson<PersistableWorkflow>(path.join(directory, "legacy-recovery.json"));
    expect(saved.nodes![0].data).toMatchObject({ outputImage: null, selectedHistoryId: null });
    expect(saved.nodes![0].data).not.toHaveProperty("outputImageRef");

    useWorkflowStore.getState().clearWorkflow();
    await useWorkflowStore.getState().loadWorkflow(saved as WorkflowFile, directory);
    const reopened = useWorkflowStore.getState();
    expect((reopened.nodes[0].data as NanoBananaNodeData).outputImage).toBeNull();
    expect((reopened.nodes[0].data as NanoBananaNodeData).selectedHistoryId).toBeNull();
    expect(reopened.characterProject?.selection).toEqual({});
    expect(reopened.getConnectedInputs("consumer").images).toEqual([]);
    expect((reopened.nodes[0].data as NanoBananaNodeData).imageHistory).toHaveLength(2);
    expect(digest(await fs.readFile(path.join(directory, "generations/blob-a.jpg")))).toBe(digest(a));
    expect(digest(await fs.readFile(path.join(directory, "generations/blob-b.jpg")))).toBe(digest(b));
  });
});
