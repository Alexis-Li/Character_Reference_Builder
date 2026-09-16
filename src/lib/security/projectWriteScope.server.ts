/**
 * Write-scope confinement (CRB-09 / Issue #10).
 *
 * An API request can write generated or imported media, but only below a root
 * the application has recorded as authorized (see `projectRoots.server.ts`) and
 * never inside the application's own source, static, build or executable
 * subtrees. The development server therefore never starts serving what an
 * import just wrote, and a crafted `workflowPath` cannot turn a media save into
 * code or document execution.
 *
 * The check takes one argument: the path about to be written. Where the
 * project directory comes from is the caller's business only up to the point
 * where it must already be an authorized root — a request cannot authorize its
 * own destination by naming it.
 */

import * as os from "node:os";
import * as path from "node:path";
import { registeredProjectRoots } from "./projectRoots.server";

/**
 * Repository-relative subtrees that must never receive API-written data.
 * `public` is served verbatim by the app; the rest are source, tooling or
 * build output.
 */
export const DENIED_WRITE_SUBTREES: readonly string[] = [
  "src",
  "public",
  "scripts",
  "presets",
  "assets",
  "licenses",
  "docs",
  "node_modules",
  ".next",
  ".git",
];

export type WriteScopeFailure = "not-absolute" | "denied-subtree" | "outside-authorized-root" | "traversal";

export interface WriteScopeCheck {
  ok: boolean;
  reason?: WriteScopeFailure;
  detail?: string;
}

/** Normalize a path for comparison: native separators collapsed, no trailing slash. */
function normalize(candidate: string): string {
  return path.resolve(candidate).replace(/[\\/]+$/, "");
}

/** True when `candidate` is `root` or lives below it. */
export function isInsideDirectory(candidate: string, root: string): boolean {
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

/** The directory that always exists for role project data, outside the repo. */
export function projectDataRoot(): string {
  const configured = process.env.CRB_DATA_ROOT?.trim();
  if (configured) return normalize(configured);
  return normalize(path.join(process.cwd(), "data"));
}

/**
 * The disposable roots: the operating system temp directory, plus the
 * configured `CRB_TEMP_ROOT` when the machine sets one. Writes here are not a
 * security concern for this boundary — the directory is not served, not in the
 * repository, and nothing executes from it on its own.
 */
function tempRoots(): string[] {
  const roots = [normalize(os.tmpdir())];
  const configured = process.env.CRB_TEMP_ROOT?.trim();
  if (configured) roots.push(normalize(configured));
  return roots;
}

function repositoryRoot(): string {
  return normalize(process.cwd());
}

/**
 * Roots an API request may write into: the role project data root, the
 * disposable temp roots, operator-configured roots, and project directories the
 * application has recorded.
 */
export function authorizedWriteRoots(): string[] {
  return [projectDataRoot(), ...tempRoots(), ...registeredProjectRoots()];
}

/**
 * Decide whether a privileged request may write to `targetPath`.
 *
 * Denied application subtrees are refused first, so even an operator-configured
 * root that happens to be the repository does not open `src/` or `public/`.
 */
export function checkWriteTarget(targetPath: string): WriteScopeCheck {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    return { ok: false, reason: "not-absolute" };
  }
  if (!path.isAbsolute(targetPath)) {
    return { ok: false, reason: "not-absolute", detail: targetPath };
  }
  if (targetPath.split(/[\\/]/).some((segment) => segment === "..")) {
    return { ok: false, reason: "traversal", detail: targetPath };
  }

  const resolved = normalize(targetPath);
  const repo = repositoryRoot();
  for (const subtree of DENIED_WRITE_SUBTREES) {
    const denied = path.join(repo, subtree);
    if (isInsideDirectory(resolved, denied)) {
      return { ok: false, reason: "denied-subtree", detail: subtree };
    }
  }

  if (!authorizedWriteRoots().some((root) => isInsideDirectory(resolved, root))) {
    return { ok: false, reason: "outside-authorized-root", detail: resolved };
  }
  return { ok: true };
}

/** True when the target is inside one of the app's own static/executable subtrees. */
export function isReadOnlyApplicationPath(targetPath: string): boolean {
  const resolved = normalize(targetPath);
  const repo = repositoryRoot();
  return DENIED_WRITE_SUBTREES.some(
    (subtree) => subtree !== ".git" && isInsideDirectory(resolved, path.join(repo, subtree)),
  );
}
