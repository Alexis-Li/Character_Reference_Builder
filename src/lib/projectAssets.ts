import type { CandidateReviewState } from "./characterProject";

export const PROJECT_ASSET_MANIFEST_VERSION = 1 as const;

export type ProjectAssetKind = "source" | "candidate" | "mask" | "transparent";

export interface ProjectAssetRecord {
  /** Stable logical identity. Candidate rows use the candidate id, not a blob id. */
  id: string;
  kind: ProjectAssetKind;
  /** POSIX-style path relative to the project directory. */
  relativePath: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
  sourceNodeId?: string;
  referenceId?: string;
  candidateId?: string;
  blobId?: string;
  partId?: string;
  view?: string;
  runId?: string;
  parentCandidateId?: string;
  referenceIds?: string[];
  review?: CandidateReviewState;
  selected?: boolean;
  inferenceNotes?: string;
  /** Optional extracted assets enter a package only after an explicit user choice. */
  selectedForExport?: boolean;
}

export interface ProjectAssetManifest {
  version: typeof PROJECT_ASSET_MANIFEST_VERSION;
  projectId: string;
  assets: ProjectAssetRecord[];
}

export type ProjectAssetWarningCode = "missing" | "hash-mismatch" | "unsafe-reference";

export interface ProjectAssetWarning {
  assetId: string;
  code: ProjectAssetWarningCode;
  message: string;
}

export function isPortableRelativePath(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").some((segment) => segment === "..");
}
