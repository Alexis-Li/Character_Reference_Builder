/**
 * Authorized project roots (CRB-09 / Issue #10).
 *
 * A write target is only authorized when it sits below a root the application
 * has actually recorded: the role project data root, the disposable temp root,
 * an operator-configured root, or a directory the user pointed the app at
 * (native folder picker, or a project path the app has read/written in this
 * process). A request cannot authorize its own destination — that was the
 * difference between "confined to the project" and "confined to whatever the
 * caller names".
 *
 * This registry is defense in depth: the privileged-request guard is what stops
 * a page that is not this application from reaching a writing route at all.
 * The registry stops a *bug or a crafted project value* from turning an
 * authorized call into a write outside the user's own project directories.
 *
 * State is process memory, pinned on `globalThis` so a dev-server reload or a
 * duplicated module instance does not silently drop authorization.
 */

import * as fsSync from "node:fs";
import * as path from "node:path";
import { resolveRuntimeStateDir } from "./cliAuth.server";

interface RootRegistry {
  roots: Set<string>;
}

const REGISTRY_KEY = "__crbAuthorizedProjectRoots";

function registry(): RootRegistry {
  const globalObject = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: RootRegistry;
  };
  if (!globalObject[REGISTRY_KEY]) {
    globalObject[REGISTRY_KEY] = { roots: new Set<string>() };
  }
  return globalObject[REGISTRY_KEY];
}

function normalize(candidate: string): string {
  return path.resolve(candidate).replace(/[\\/]+$/, "");
}

/**
 * Operator-declared roots, comma separated. The only way to authorize a
 * directory the app has never seen, and therefore a deliberate configuration
 * decision rather than a request-supplied one.
 */
function configuredRoots(): string[] {
  const raw = process.env.CRB_PROJECT_ROOTS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(normalize);
}

/**
 * Record a directory the user pointed the application at. Called from the
 * folder picker and from operator configuration — never from a bare request
 * body, because a request that can name its own write destination has not been
 * confined to anything.
 */
export function registerProjectRoot(root: string | null | undefined): string | null {
  if (!root || root.trim().length === 0) return null;
  if (!path.isAbsolute(root)) return null;
  const resolved = normalize(root);
  if (resolved.length === 0) return null;
  loadPersistedRoots();
  if (!registry().roots.has(resolved)) {
    registry().roots.add(resolved);
    persistRoots(registry().roots);
  }
  return resolved;
}

/**
 * Roots survive a restart, so a project the user picked once stays writable
 * after the app (or the operating system) is restarted. The file lives in the
 * runtime state directory, outside the repository, owner-readable, and is
 * written by the server — not by a request.
 */
function rootsFilePath(): string {
  return path.join(resolveRuntimeStateDir(), "project-roots.json");
}

let persistedLoaded = false;

/** Tests must not mutate the machine's recorded roots. */
function persistenceEnabled(): boolean {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}

function loadPersistedRoots(): void {
  if (persistedLoaded) return;
  persistedLoaded = true;
  if (!persistenceEnabled()) return;
  try {
    const raw = fsSync.readFileSync(rootsFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (typeof entry === "string" && path.isAbsolute(entry)) {
        registry().roots.add(normalize(entry));
      }
    }
  } catch {
    // No persisted roots yet, or unreadable: an empty set is the safe answer.
  }
}

function persistRoots(roots: Set<string>): void {
  if (!persistenceEnabled()) return;
  try {
    fsSync.mkdirSync(resolveRuntimeStateDir(), { recursive: true });
    fsSync.writeFileSync(rootsFilePath(), JSON.stringify([...roots], null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // A failed persist costs a re-pick after restart; it never widens access.
  }
}

/** Every root that currently authorizes a write. */
export function registeredProjectRoots(): string[] {
  loadPersistedRoots();
  return [...configuredRoots(), ...registry().roots];
}

/** True when the directory itself was recorded (not merely below a root). */
export function isRegisteredProjectRoot(root: string | null | undefined): boolean {
  if (!root) return false;
  const resolved = normalize(root);
  return registeredProjectRoots().includes(resolved);
}

/** Test seam: drop every recorded root (operator roots and the file stay). */
export function resetProjectRootsForTest(): void {
  persistedLoaded = true;
  registry().roots.clear();
}
