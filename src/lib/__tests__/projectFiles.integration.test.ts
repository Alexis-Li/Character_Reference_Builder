import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  atomicReplaceFile,
  auditProjectAssets,
  createReferencePackage,
  readRecoverableJson,
  savePortableWorkflow,
  type PersistableWorkflow,
} from "../projectFiles.server";
import { recordSuccessfulRun, type CharacterProject } from "../characterProject";

const FRONT = Buffer.from("full-resolution-front-image");
const BACK = Buffer.from("full-resolution-back-image");
const SOURCE = Buffer.from("original-character-source");

function digest(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function project(): CharacterProject {
  return {
    id: "character-7",
    updatedAt: 7,
    references: [{ id: "ref:original", kind: "original", source: "sha256:source", purpose: "原画" }],
    projectLocks: [{ id: "lock", description: "保持原设计" }],
    parts: [{
      id: "coat",
      name: "外套",
      requirements: ["保留双排扣"],
      correctionHistory: [{ at: 1, note: "确认左右结构" }],
    }],
    candidates: [
      {
        id: "candidate-front",
        assetId: "blob-front",
        partId: "coat",
        view: "正面",
        runId: "run-front",
        referenceIds: ["ref:original"],
        inferenceNotes: "无",
        review: "approved",
      },
      {
        id: "candidate-back",
        assetId: "blob-back",
        partId: "coat",
        view: "背面",
        runId: "run-back",
        parentCandidateId: "candidate-front",
        referenceIds: ["ref:original"],
        inferenceNotes: "遮挡后的背带走向为推测",
        review: "selected",
      },
    ],
    runs: [
      { id: "run-front", partId: "coat", view: "正面", status: "success", candidateIds: ["candidate-front"] },
      {
        id: "run-back",
        partId: "coat",
        view: "背面",
        inputCandidateId: "candidate-front",
        status: "success",
        candidateIds: ["candidate-back"],
      },
    ],
    selection: { "coat@正面": "candidate-front", "coat@背面": "candidate-back" },
  };
}

function workflow(directoryPath: string): PersistableWorkflow {
  return {
    version: 1,
    id: "workflow-7",
    name: "角色参考",
    directoryPath,
    apiKey: "must-never-be-written",
    nodes: [
      {
        id: "original",
        type: "imageInput",
        data: { imageRef: "source-original", filename: "original.png", localNote: directoryPath },
      },
      {
        id: "generation",
        type: "nanoBanana",
        data: {
          imageHistory: [
            { id: "candidate-front", assetId: "blob-front" },
            { id: "candidate-back", assetId: "blob-back" },
          ],
          selectedHistoryId: "candidate-front",
        },
      },
      {
        id: "mask-not-selected",
        type: "annotation",
        data: {
          referencePackageAsset: { kind: "mask", assetId: "mask-unused", selected: false },
        },
      },
    ],
    edges: [
      { id: "front-branch", source: "original", target: "generation" },
      { id: "back-branch", source: "generation", target: "generation" },
    ],
    characterProject: project(),
  };
}

describe("CRB-06 real project files", () => {
  let ownedRoot: string;
  let projectDirectory: string;

  beforeEach(async () => {
    const configuredRoot = process.env.CRB_TEMP_ROOT || path.join(os.tmpdir(), "Character_Reference_Builder");
    await fs.mkdir(configuredRoot, { recursive: true });
    ownedRoot = await fs.mkdtemp(path.join(configuredRoot, "crb-06-test-"));
    projectDirectory = path.join(ownedRoot, "角色 项目 (Windows 合法路径)");
    await fs.mkdir(path.join(projectDirectory, "inputs"), { recursive: true });
    await fs.mkdir(path.join(projectDirectory, "generations"), { recursive: true });
    await fs.writeFile(path.join(projectDirectory, "inputs", "source-original.png"), SOURCE);
    await fs.writeFile(path.join(projectDirectory, "generations", "blob-front.png"), FRONT);
    await fs.writeFile(path.join(projectDirectory, "generations", "blob-back.png"), BACK);
  });

  afterEach(async () => {
    // Only the unique directory created by this test is removed.
    await fs.rm(ownedRoot, { recursive: true, force: true });
  });

  it("writes a portable versioned manifest and retains both P03 branches", async () => {
    const filePath = path.join(projectDirectory, "project.json");
    await savePortableWorkflow(projectDirectory, filePath, workflow(projectDirectory));
    const persisted = await readRecoverableJson<PersistableWorkflow>(filePath);
    const raw = await fs.readFile(filePath, "utf8");

    expect(persisted.directoryPath).toBeUndefined();
    expect(raw).not.toContain(projectDirectory);
    expect(raw).not.toContain("must-never-be-written");
    expect(persisted.assetManifest?.version).toBe(1);
    expect(persisted.assetManifest?.assets).toHaveLength(3);
    expect(persisted.assetManifest?.assets.find((asset) => asset.id === "candidate-front")).toMatchObject({
      relativePath: "generations/blob-front.png",
      sha256: digest(FRONT),
      candidateId: "candidate-front",
      blobId: "blob-front",
      referenceIds: ["ref:original"],
      selected: true,
    });
    expect(persisted.edges).toHaveLength(2);
    expect(persisted.characterProject?.candidates.map((candidate) => candidate.id)).toEqual([
      "candidate-front",
      "candidate-back",
    ]);
  });

  it("loads after directory migration and reports one missing image without clearing other assets", async () => {
    const filePath = path.join(projectDirectory, "project.json");
    await savePortableWorkflow(projectDirectory, filePath, workflow(projectDirectory));
    const migrated = path.join(ownedRoot, "迁移后的目录");
    await fs.cp(projectDirectory, migrated, { recursive: true });
    const reopened = await readRecoverableJson<PersistableWorkflow>(path.join(migrated, "project.json"));
    expect(await auditProjectAssets(migrated, reopened.assetManifest)).toEqual([]);

    await fs.rm(path.join(migrated, "generations", "blob-back.png"));
    const warnings = await auditProjectAssets(migrated, reopened.assetManifest);
    expect(warnings).toEqual([
      expect.objectContaining({ assetId: "candidate-back", code: "missing" }),
    ]);
    expect(reopened.characterProject?.selection).toEqual({
      "coat@正面": "candidate-front",
      "coat@背面": "candidate-back",
    });
    const continued = recordSuccessfulRun(reopened.characterProject!, {
      runId: "run-after-reopen",
      partId: "coat",
      view: "背面",
      inputCandidateId: "candidate-back",
      outputs: [{ candidateId: "candidate-after-reopen", referenceIds: ["ref:original"] }],
    });
    expect(continued.candidates.at(-1)?.parentCandidateId).toBe("candidate-back");
    expect(continued.selection["coat@背面"]).toBe("candidate-back");
    expect(await fs.readFile(path.join(migrated, "generations", "blob-front.png"))).toEqual(FRONT);
  });

  it("keeps the previous valid project when a save is interrupted before commit", async () => {
    const filePath = path.join(projectDirectory, "project.json");
    const original = await savePortableWorkflow(projectDirectory, filePath, workflow(projectDirectory));
    const changed = { ...workflow(projectDirectory), name: "interrupted replacement" };
    await expect(
      savePortableWorkflow(projectDirectory, filePath, changed, {
        beforeCommit: () => {
          throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrow("simulated interruption");
    expect(await readRecoverableJson(filePath)).toEqual(original);
  });

  it("exports selected originals with hashes, overview, descriptions and explicit review state", async () => {
    const filePath = path.join(projectDirectory, "project.json");
    const saved = await savePortableWorkflow(projectDirectory, filePath, workflow(projectDirectory));

    const approved = await createReferencePackage(projectDirectory, saved, { packageName: "角色参考" });
    expect(approved.exportedCandidateIds).toEqual(["candidate-front"]);
    const approvedManifest = JSON.parse(
      await fs.readFile(path.join(approved.packagePath, "asset-manifest.json"), "utf8"),
    ) as { assets: Array<{ candidateId: string; sha256: string; relativePath: string }> };
    expect(approvedManifest.assets).toHaveLength(1);
    expect(approvedManifest.assets[0]).toMatchObject({
      candidateId: "candidate-front",
      sha256: digest(FRONT),
    });
    const exportedFront = await fs.readFile(
      path.join(approved.packagePath, ...approvedManifest.assets[0].relativePath.split("/")),
    );
    expect(exportedFront).toEqual(FRONT);
    expect(await fs.readFile(path.join(approved.packagePath, "overview.svg"), "utf8")).toContain("外套 · 正面");

    const explicit = await createReferencePackage(projectDirectory, saved, {
      packageName: "角色参考",
      includeUnreviewed: true,
    });
    expect(explicit.exportedCandidateIds).toEqual(["candidate-front", "candidate-back"]);
    const explicitRaw = await fs.readFile(path.join(explicit.packagePath, "asset-manifest.json"), "utf8");
    expect(explicitRaw).toContain("includes-unreviewed");
    expect(explicitRaw).toContain("遮挡后的背带走向为推测");
    expect(explicitRaw).not.toContain(projectDirectory);
    expect(explicitRaw).not.toContain("mask-unused");
    expect(await fs.readFile(path.join(explicit.packagePath, "README.md"), "utf8")).toContain("Review: selected");
  });
});
