import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CharacterProject } from "./characterProject";
import {
  PROJECT_ASSET_MANIFEST_VERSION,
  isPortableRelativePath,
  type ProjectAssetKind,
  type ProjectAssetManifest,
  type ProjectAssetRecord,
  type ProjectAssetWarning,
} from "./projectAssets";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;
const SECRET_KEY = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|credential)s?$/i;

interface PersistableNode {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PersistableWorkflow {
  version?: number;
  id?: string;
  name?: string;
  directoryPath?: string;
  nodes?: PersistableNode[];
  edges?: unknown[];
  characterProject?: CharacterProject | null;
  assetManifest?: ProjectAssetManifest;
  [key: string]: unknown;
}

export interface AtomicWriteOptions {
  /** Test hook representing an interruption after the durable temp write. */
  beforeCommit?: () => void | Promise<void>;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function mimeForExtension(extension: string): string {
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return `image/${extension}`;
}

function portableRelative(...segments: string[]): string {
  return segments.join("/").replaceAll("\\", "/");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findImage(
  directoryPath: string,
  folder: "inputs" | "generations",
  id: string,
): Promise<{ absolutePath: string; relativePath: string; extension: string } | null> {
  if (!id || path.basename(id) !== id || id.includes("..")) return null;
  for (const extension of IMAGE_EXTENSIONS) {
    const relativePath = portableRelative(folder, `${id}.${extension}`);
    const absolutePath = path.join(directoryPath, ...relativePath.split("/"));
    if (await exists(absolutePath)) return { absolutePath, relativePath, extension };
  }
  return null;
}

async function recordForFile(
  input: Omit<ProjectAssetRecord, "relativePath" | "sha256" | "byteLength" | "mimeType">,
  located: { absolutePath: string; relativePath: string; extension: string },
): Promise<ProjectAssetRecord> {
  const bytes = await fs.readFile(located.absolutePath);
  return {
    ...input,
    relativePath: located.relativePath,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mimeType: mimeForExtension(located.extension),
  };
}

function optionalAssetSelection(node: PersistableNode): {
  id: string;
  kind: Extract<ProjectAssetKind, "mask" | "transparent">;
  folder: "inputs" | "generations";
} | null {
  const selection = node.data?.referencePackageAsset;
  if (!selection || typeof selection !== "object") return null;
  const value = selection as Record<string, unknown>;
  if (value.selected !== true) return null;
  if (value.kind !== "mask" && value.kind !== "transparent") return null;
  if (typeof value.assetId !== "string" || !value.assetId) return null;
  return {
    id: value.assetId,
    kind: value.kind,
    folder: value.folder === "generations" ? "generations" : "inputs",
  };
}

/** Build the authoritative manifest from files already externalized beside the project. */
export async function buildProjectAssetManifest(
  directoryPath: string,
  workflow: PersistableWorkflow,
): Promise<ProjectAssetManifest> {
  const assets: ProjectAssetRecord[] = [];
  const project = workflow.characterProject ?? null;
  const selectedIds = new Set(Object.values(project?.selection ?? {}));

  for (const candidate of project?.candidates ?? []) {
    const blobId = candidate.assetId ?? candidate.id;
    const located = await findImage(directoryPath, "generations", blobId);
    if (!located) {
      throw new Error(`Candidate ${candidate.id} has no recoverable original image.`);
    }
    assets.push(
      await recordForFile(
        {
          id: candidate.id,
          kind: "candidate",
          candidateId: candidate.id,
          blobId,
          partId: candidate.partId,
          view: candidate.view,
          runId: candidate.runId || undefined,
          parentCandidateId: candidate.parentCandidateId,
          referenceIds: [...candidate.referenceIds],
          review: candidate.review,
          selected: selectedIds.has(candidate.id),
          inferenceNotes: candidate.inferenceNotes,
        },
        located,
      ),
    );
  }

  for (const node of workflow.nodes ?? []) {
    if (node.type === "imageInput" && typeof node.data?.imageRef === "string") {
      const located = await findImage(directoryPath, "inputs", node.data.imageRef);
      if (!located) throw new Error(`Source asset ${node.id} has no recoverable original image.`);
      assets.push(
        await recordForFile(
          {
            id: `source:${node.id}`,
            kind: "source",
            sourceNodeId: node.id,
            referenceId: `ref:${node.id}`,
            blobId: node.data.imageRef,
          },
          located,
        ),
      );
    }

    const optional = optionalAssetSelection(node);
    if (optional) {
      const located = await findImage(directoryPath, optional.folder, optional.id);
      if (!located) throw new Error(`Selected ${optional.kind} asset ${optional.id} is missing.`);
      assets.push(
        await recordForFile(
          {
            id: `${optional.kind}:${node.id}`,
            kind: optional.kind,
            sourceNodeId: node.id,
            blobId: optional.id,
            selectedForExport: true,
          },
          located,
        ),
      );
    }
  }

  return {
    version: PROJECT_ASSET_MANIFEST_VERSION,
    projectId: project?.id ?? workflow.id ?? "legacy-project",
    assets,
  };
}

function scrubLocalPaths(value: string): string {
  return value
    .replace(/\bfile:(?:\/\/)?[^\r\n\t"'<>]*/gi, "[local-path-redacted]")
    .replace(/(^|[\s("'=:\[{},])(?:\\\\|\/\/)[^\r\n\t"'<>]*/g, "$1[local-path-redacted]")
    .replace(/(^|[\s("'=:\[{},])[A-Za-z]:[\\/][^\r\n\t"'<>]*/g, "$1[local-path-redacted]")
    .replace(/(^|[\s("'=:\[{},])\/(?!\/)[^\r\n\t"'<>]*/g, "$1[local-path-redacted]");
}

function sanitizePortableString(value: string): string {
  const httpUrl = /https?:\/\/[^\s\r\n\t"'<>]+/gi;
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(httpUrl)) {
    const index = match.index ?? cursor;
    result += scrubLocalPaths(value.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }
  return result + scrubLocalPaths(value.slice(cursor));
}

/** Remove local-only paths and credential-shaped fields before persistence/export. */
export function sanitizePortableValue<T>(value: T, root = true): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePortableValue(item, false)) as T;
  }
  if (typeof value === "string") {
    return sanitizePortableString(value) as T;
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    if (root && key === "directoryPath") continue;
    output[key] = sanitizePortableValue(child, false);
  }
  return output as T;
}

/** Durable temp write followed by a recoverable replacement of the previous file. */
export async function atomicReplaceFile(
  filePath: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const suffix = crypto.randomUUID();
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${suffix}.tmp`);
  const previousPath = `${filePath}.previous`;
  let movedPrevious = false;
  try {
    await fs.writeFile(temporaryPath, contents);
    // Windows requires a write-capable handle for FlushFileBuffers.
    const handle = await fs.open(temporaryPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeCommit?.();
    if (await exists(filePath)) {
      await fs.rm(previousPath, { force: true });
      await fs.rename(filePath, previousPath);
      movedPrevious = true;
    }
    try {
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      if (movedPrevious && !(await exists(filePath))) await fs.rename(previousPath, filePath);
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function savePortableWorkflow(
  directoryPath: string,
  filePath: string,
  workflow: PersistableWorkflow,
  options: AtomicWriteOptions = {},
): Promise<PersistableWorkflow> {
  const manifest = await buildProjectAssetManifest(directoryPath, workflow);
  const portable = sanitizePortableValue({ ...workflow, assetManifest: manifest });
  await atomicReplaceFile(filePath, JSON.stringify(portable, null, 2), options);
  return portable;
}

/** Parse the current file, falling back to the last committed version after corruption. */
export async function readRecoverableJson<T = PersistableWorkflow>(filePath: string): Promise<T> {
  let firstError: unknown;
  for (const candidate of [filePath, `${filePath}.previous`]) {
    try {
      return JSON.parse(await fs.readFile(candidate, "utf8")) as T;
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError instanceof Error ? firstError : new Error("No valid project file found.");
}

export async function auditProjectAssets(
  directoryPath: string,
  manifest?: ProjectAssetManifest,
): Promise<ProjectAssetWarning[]> {
  if (!manifest) return [];
  const warnings: ProjectAssetWarning[] = [];
  for (const asset of manifest.assets) {
    if (!isPortableRelativePath(asset.relativePath)) {
      warnings.push({
        assetId: asset.id,
        code: "unsafe-reference",
        message: `Asset ${asset.id} has an unsafe file reference.`,
      });
      continue;
    }
    const absolutePath = path.join(directoryPath, ...asset.relativePath.split("/"));
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absolutePath);
    } catch {
      warnings.push({
        assetId: asset.id,
        code: "missing",
        message: `Asset ${asset.id} is missing; other project assets remain available.`,
      });
      continue;
    }
    if (sha256(bytes) !== asset.sha256) {
      warnings.push({
        assetId: asset.id,
        code: "hash-mismatch",
        message: `Asset ${asset.id} does not match its saved content hash.`,
      });
    }
  }
  return warnings;
}

export interface ReferencePackageOptions {
  includeUnreviewed?: boolean;
  packageName?: string;
}

export interface ReferencePackageResult {
  packageName: string;
  packagePath: string;
  exportedCandidateIds: string[];
  manifest: Record<string, unknown>;
}

function safeFileSegment(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "");
  return cleaned || fallback;
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[char]!);
}

async function buildOverviewSvg(
  directoryPath: string,
  rows: Array<{ asset: ProjectAssetRecord; title: string; note: string }>,
): Promise<string> {
  const width = 1100;
  const cardWidth = 520;
  const cardHeight = 420;
  const columns = 2;
  const height = 90 + Math.ceil(rows.length / columns) * cardHeight;
  const cards: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const x = 20 + (index % columns) * 540;
    const y = 70 + Math.floor(index / columns) * cardHeight;
    const absolutePath = path.join(directoryPath, ...row.asset.relativePath.split("/"));
    const bytes = await fs.readFile(absolutePath);
    const dataUrl = `data:${row.asset.mimeType};base64,${bytes.toString("base64")}`;
    cards.push(
      `<g transform="translate(${x} ${y})">` +
      `<rect width="520" height="400" rx="8" fill="#202124" stroke="#555"/>` +
      `<image href="${dataUrl}" x="12" y="12" width="496" height="310" preserveAspectRatio="xMidYMid meet"/>` +
      `<text x="16" y="350" fill="#f4f4f4" font-family="sans-serif" font-size="20">${xml(row.title)}</text>` +
      `<text x="16" y="378" fill="#b8b8b8" font-family="sans-serif" font-size="14">${xml(row.note)}</text>` +
      `</g>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="#151515"/>` +
    `<text x="24" y="42" fill="#f4f4f4" font-family="sans-serif" font-size="28">Character reference overview</text>` +
    cards.join("") +
    `</svg>`;
}

/** Create a portable reference package from the committed project and original assets. */
export async function createReferencePackage(
  directoryPath: string,
  workflow: PersistableWorkflow,
  options: ReferencePackageOptions = {},
): Promise<ReferencePackageResult> {
  const portableWorkflow = sanitizePortableValue(workflow);
  const project = portableWorkflow.characterProject;
  const assetManifest = portableWorkflow.assetManifest;
  if (!project || !assetManifest) throw new Error("Save the character project before exporting a reference package.");

  const selectedIds = new Set(Object.values(project.selection));
  const candidates = project.candidates.filter((candidate) => {
    if (!selectedIds.has(candidate.id)) return false;
    return candidate.review === "approved" || options.includeUnreviewed === true;
  });
  if (candidates.length === 0) {
    throw new Error(
      options.includeUnreviewed
        ? "No manually selected candidates are available to export."
        : "No approved selected candidates are available; explicitly include unreviewed candidates to export them with status.",
    );
  }

  const packageBase = safeFileSegment(
    sanitizePortableValue(options.packageName ?? portableWorkflow.name ?? "character"),
    "character",
  );
  const packageName = `${packageBase}-reference-package-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const exportsRoot = path.join(directoryPath, "exports");
  const packagePath = path.join(exportsRoot, packageName);
  const temporaryPath = path.join(exportsRoot, `.${packageName}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(path.join(temporaryPath, "images"), { recursive: true });

  const exportedAssets: ProjectAssetRecord[] = [];
  const overviewRows: Array<{ asset: ProjectAssetRecord; title: string; note: string }> = [];
  try {
    for (const candidate of candidates) {
      const source = assetManifest.assets.find(
        (asset) => asset.kind === "candidate" && asset.candidateId === candidate.id,
      );
      if (!source) throw new Error(`Selected candidate ${candidate.id} is absent from the asset manifest.`);
      if (!isPortableRelativePath(source.relativePath)) throw new Error(`Selected candidate ${candidate.id} has an unsafe file reference.`);
      const sourcePath = path.join(directoryPath, ...source.relativePath.split("/"));
      const bytes = await fs.readFile(sourcePath);
      if (sha256(bytes) !== source.sha256) throw new Error(`Selected candidate ${candidate.id} failed its content hash check.`);
      const part = project.parts.find((item) => item.id === candidate.partId);
      const extension = path.extname(source.relativePath).slice(1) || "png";
      const candidateSegment = safeFileSegment(candidate.id, "candidate").slice(0, 96);
      const filename = `${safeFileSegment(part?.name ?? candidate.partId, "part")}-${safeFileSegment(candidate.view, "view")}-${candidateSegment}.${extension}`;
      const exportRelativePath = portableRelative("images", filename);
      await atomicReplaceFile(path.join(temporaryPath, ...exportRelativePath.split("/")), bytes);
      const exported = { ...source, relativePath: exportRelativePath };
      exportedAssets.push(exported);
      overviewRows.push({
        asset: source,
        title: `${part?.name ?? candidate.partId} · ${candidate.view}`,
        note: `${candidate.review}${candidate.inferenceNotes ? ` · 推测：${candidate.inferenceNotes}` : ""}`,
      });
    }

    for (const optional of assetManifest.assets.filter(
      (asset) => (asset.kind === "mask" || asset.kind === "transparent") && asset.selectedForExport,
    )) {
      if (!isPortableRelativePath(optional.relativePath)) throw new Error(`Optional asset ${optional.id} has an unsafe file reference.`);
      const bytes = await fs.readFile(path.join(directoryPath, ...optional.relativePath.split("/")));
      if (sha256(bytes) !== optional.sha256) throw new Error(`Optional asset ${optional.id} failed its content hash check.`);
      const extension = path.extname(optional.relativePath).slice(1) || "png";
      const filename = `${safeFileSegment(optional.id, optional.kind)}.${extension}`;
      const exportRelativePath = portableRelative("masks", filename);
      await atomicReplaceFile(path.join(temporaryPath, ...exportRelativePath.split("/")), bytes);
      exportedAssets.push({ ...optional, relativePath: exportRelativePath });
    }

    const manifest = sanitizePortableValue({
      version: PROJECT_ASSET_MANIFEST_VERSION,
      projectId: project.id,
      exportStatus: options.includeUnreviewed ? "includes-unreviewed" : "approved-only",
      assets: exportedAssets,
      parts: project.parts.map((part) => ({
        id: part.id,
        name: part.name,
        parentId: part.parentId,
        requirements: part.requirements,
      })),
      references: project.references,
      projectLocks: project.projectLocks,
      runs: project.runs.filter((run) => candidates.some((candidate) => candidate.runId === run.id)),
      selections: Object.fromEntries(
        Object.entries(project.selection).filter(([, candidateId]) => candidates.some((candidate) => candidate.id === candidateId)),
      ),
    });

    const readme = [
      `# ${packageBase} reference package`,
      "",
      `Export status: ${options.includeUnreviewed ? "includes explicitly selected unreviewed candidates" : "approved selected candidates only"}.`,
      "",
      ...candidates.flatMap((candidate) => {
        const part = project.parts.find((item) => item.id === candidate.partId);
        return [
          `## ${part?.name ?? candidate.partId} — ${candidate.view}`,
          "",
          `- Review: ${candidate.review}`,
          `- Requirements: ${part?.requirements.join("; ") || "None recorded"}`,
          `- Inferred content: ${candidate.inferenceNotes || "None recorded"}`,
          `- Candidate: ${candidate.id}`,
          "",
        ];
      }),
    ].join("\n");
    await atomicReplaceFile(path.join(temporaryPath, "README.md"), readme);
    await atomicReplaceFile(path.join(temporaryPath, "asset-manifest.json"), JSON.stringify(manifest, null, 2));
    await atomicReplaceFile(path.join(temporaryPath, "overview.svg"), await buildOverviewSvg(directoryPath, overviewRows));
    await fs.mkdir(exportsRoot, { recursive: true });
    await fs.rename(temporaryPath, packagePath);
    return {
      packageName,
      packagePath,
      exportedCandidateIds: candidates.map((candidate) => candidate.id),
      manifest,
    };
  } catch (error) {
    await fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
