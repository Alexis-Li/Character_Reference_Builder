/**
 * Write-scope confinement acceptance suite (CRB-09 / Issue #10).
 *
 * Asserts which absolute paths a privileged API request may write to and the
 * exact refusal for each hostile shape. The property under test is the one the
 * boundary promises: a request cannot authorize its own destination. A
 * directory is writable only because the application already recorded it (data
 * root, disposable temp root, operator configuration, folder picker, or a
 * project the app has read), and the repository's own source, static and build
 * subtrees are never writable.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DENIED_WRITE_SUBTREES,
  authorizedWriteRoots,
  checkWriteTarget,
  isReadOnlyApplicationPath,
  projectDataRoot,
} from "../projectWriteScope.server";
import { isRegisteredProjectRoot, registerProjectRoot, resetProjectRootsForTest } from "../projectRoots.server";

const REPO_ROOT = process.cwd();
const READ_ONLY_SUBTREES = ["src", "public", ".next", "node_modules", "scripts", "presets", "assets"];

let workDirs: string[] = [];

async function makeWorkDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

/**
 * A directory that exists but is none of the authorized roots: not the OS temp
 * root (where these tests' scratch space lives), not the repository, and not
 * configured. Created under the user profile, which the app has no reason to
 * write into.
 */
async function makeOutsideDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.homedir(), ".crb-outside-"));
  workDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetProjectRootsForTest();
  // Ambient configuration must not decide whether these cases pass.
  vi.stubEnv("CRB_DATA_ROOT", "");
  vi.stubEnv("CRB_TEMP_ROOT", "");
  vi.stubEnv("CRB_PROJECT_ROOTS", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetProjectRootsForTest();
  for (const dir of workDirs) await fs.rm(dir, { recursive: true, force: true });
  workDirs = [];
});

describe("privileged write scope", () => {
  it("allows a write inside the default role project data root", () => {
    expect(projectDataRoot()).toBe(path.join(REPO_ROOT, "data"));
    expect(checkWriteTarget(path.join(REPO_ROOT, "data", "media", "render.png")).ok).toBe(true);
    expect(checkWriteTarget(path.join(projectDataRoot(), "projects", "p1", "out.png")).ok).toBe(true);
  });

  it("honors CRB_DATA_ROOT and stops authorizing the repository data folder", async () => {
    const dataRoot = await makeWorkDir("crb-data-");
    vi.stubEnv("CRB_DATA_ROOT", dataRoot + path.sep);

    expect(projectDataRoot()).toBe(path.resolve(dataRoot));
    expect(checkWriteTarget(path.join(dataRoot, "projects", "p1", "out.png")).ok).toBe(true);
    expect(checkWriteTarget(path.join(REPO_ROOT, "data", "media", "out.png"))).toMatchObject({
      ok: false,
      reason: "outside-authorized-root",
    });
  });

  it("does not let a request authorize its own destination", async () => {
    const projectDir = await makeOutsideDir();
    const target = path.join(projectDir, "generations", "render.png");

    // Naming the directory in the request is not authorization.
    expect(checkWriteTarget(target)).toMatchObject({
      ok: false,
      reason: "outside-authorized-root",
      detail: path.resolve(target),
    });

    // The application recording it — folder picker, project read, operator
    // configuration — is authorization.
    expect(registerProjectRoot(projectDir + path.sep)).toBe(path.resolve(projectDir));
    expect(isRegisteredProjectRoot(projectDir)).toBe(true);
    expect(checkWriteTarget(target).ok).toBe(true);

    // Dropping the record drops the authorization with it.
    resetProjectRootsForTest();
    expect(checkWriteTarget(target)).toMatchObject({ ok: false, reason: "outside-authorized-root" });
  });

  it("keeps a recorded root across the process, and only via the recording path", () => {
    // The recording path is the folder picker (and operator configuration):
    // one call records it for later writes, including new subdirectories
    // below it, which is how a first save into a fresh project works.
    const projectDir = path.join(os.homedir(), ".crb-recorded-root");

    expect(checkWriteTarget(path.join(projectDir, "generations", "out.png"))).toMatchObject({
      ok: false,
      reason: "outside-authorized-root",
    });

    registerProjectRoot(projectDir);
    expect(checkWriteTarget(path.join(projectDir, "generations", "out.png")).ok).toBe(true);
    expect(checkWriteTarget(path.join(projectDir)).ok).toBe(true);

    // A sibling that merely shares a prefix is still refused.
    expect(checkWriteTarget(`${path.resolve(projectDir)}-sibling/out.png`)).toMatchObject({
      ok: false,
      reason: "outside-authorized-root",
    });
  });

  it("denies every repository subtree that must never receive API data", async () => {
    // These checks only mean something against the real repository.
    await expect(fs.stat(path.join(REPO_ROOT, "package.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(REPO_ROOT, "src"))).resolves.toBeDefined();

    // Even with the repository itself recorded as the project root.
    registerProjectRoot(REPO_ROOT);

    for (const subtree of READ_ONLY_SUBTREES) {
      expect(DENIED_WRITE_SUBTREES).toContain(subtree);
      const target = path.join(REPO_ROOT, subtree, "nested", "payload.bin");
      expect(checkWriteTarget(target)).toMatchObject({
        ok: false,
        reason: "denied-subtree",
        detail: subtree,
      });
    }

    expect(checkWriteTarget(path.join(REPO_ROOT, "src"))).toMatchObject({
      ok: false,
      reason: "denied-subtree",
    });
    expect(checkWriteTarget(path.join(REPO_ROOT, "public") + path.sep)).toMatchObject({
      ok: false,
      reason: "denied-subtree",
    });
  });

  it("refuses a relative or empty target as not-absolute", () => {
    expect(checkWriteTarget("data/media/out.png")).toMatchObject({
      ok: false,
      reason: "not-absolute",
    });
    expect(checkWriteTarget(path.join("data", "media", "out.png"))).toMatchObject({
      ok: false,
      reason: "not-absolute",
    });
    expect(checkWriteTarget("data/../escape.png")).toMatchObject({
      ok: false,
      reason: "not-absolute",
    });
    expect(checkWriteTarget("")).toMatchObject({ ok: false, reason: "not-absolute" });
    expect(checkWriteTarget("   ")).toMatchObject({ ok: false, reason: "not-absolute" });
    expect(checkWriteTarget(undefined as unknown as string)).toMatchObject({
      ok: false,
      reason: "not-absolute",
    });
  });

  it("refuses a traversal segment even when it resolves back inside an authorized root", () => {
    const dataRoot = projectDataRoot();
    const sep = path.sep;

    expect(checkWriteTarget(`${dataRoot}${sep}..${sep}escape.png`)).toMatchObject({
      ok: false,
      reason: "traversal",
    });
    // Resolves inside the data root, and is still refused: the form is the problem.
    expect(checkWriteTarget(`${dataRoot}${sep}media${sep}..${sep}inside.png`)).toMatchObject({
      ok: false,
      reason: "traversal",
    });
    // Mixed separators do not hide the segment.
    expect(checkWriteTarget(`${dataRoot}/media/../inside.png`)).toMatchObject({
      ok: false,
      reason: "traversal",
    });
  });

  it("authorizes the disposable temp roots without authorizing the rest of the machine", async () => {
    const inTemp = path.join(os.tmpdir(), "crb-in-temp", "out.png");
    expect(checkWriteTarget(inTemp).ok).toBe(true);

    const configuredTemp = await makeWorkDir("crb-temp-root-");
    vi.stubEnv("CRB_TEMP_ROOT", configuredTemp);
    expect(checkWriteTarget(path.join(configuredTemp, "runtime", "out.log")).ok).toBe(true);

    // A directory the app has never been pointed at stays refused.
    const outside = await makeOutsideDir();
    expect(checkWriteTarget(path.join(outside, "out.png"))).toMatchObject({
      ok: false,
      reason: "outside-authorized-root",
    });
  });

  it("refuses a path that only textually prefixes an authorized root", async () => {
    expect(checkWriteTarget(path.join(REPO_ROOT, "datastore", "out.png"))).toMatchObject({
      ok: false,
      reason: "outside-authorized-root",
    });

    const projectDir = await makeOutsideDir();
    registerProjectRoot(projectDir);
    expect(checkWriteTarget(`${path.resolve(projectDir)}-sibling/out.png`)).toMatchObject({
      ok: false,
      reason: "outside-authorized-root",
    });
  });

  it("lists only roots outside the repository plus recorded project directories", async () => {
    const projectDir = await makeOutsideDir();
    registerProjectRoot(projectDir);

    const roots = authorizedWriteRoots();
    expect(roots).toContain(projectDataRoot());
    expect(roots).toContain(path.resolve(projectDir));
    expect(roots).not.toContain(REPO_ROOT);
  });

  it("agrees with isReadOnlyApplicationPath about the app's static and executable subtrees", () => {
    for (const subtree of READ_ONLY_SUBTREES) {
      expect(isReadOnlyApplicationPath(path.join(REPO_ROOT, subtree, "asset.png"))).toBe(true);
    }
    expect(isReadOnlyApplicationPath(path.join(projectDataRoot(), "asset.png"))).toBe(false);
    expect(isReadOnlyApplicationPath(path.join(os.tmpdir(), "crb-asset.png"))).toBe(false);
  });
});
