import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

/** stdout the picker command "returns"; the test sets it before each call. */
let execStdout = "";
vi.mock("child_process", () => {
  // The route promisifies `exec`, and Node's `exec` resolves `{ stdout, stderr }`
  // through `promisify.custom` — the double has to provide the same shape.
  const exec = (...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: unknown, stdout: string, stderr: string) => void;
    callback(null, execStdout, "");
    return {} as never;
  };
  (exec as unknown as Record<symbol, unknown>)[promisify.custom] = async () => ({
    stdout: execStdout,
    stderr: "",
  });
  return { exec, default: { exec } };
});
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const mocked = {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
  return { ...mocked, default: mocked };
});

import { normalizeSelectedPath } from "../route";

describe("normalizeSelectedPath", () => {
  it("should strip hostname prefix on macOS", () => {
    expect(normalizeSelectedPath("AT-ALGKG9VR/Users/guy/Desktop", "darwin"))
      .toBe("/Users/guy/Desktop");
  });

  it("should preserve absolute paths on macOS", () => {
    expect(normalizeSelectedPath("/Users/guy/Desktop", "darwin"))
      .toBe("/Users/guy/Desktop");
  });

  it("should remove trailing slash", () => {
    expect(normalizeSelectedPath("/Users/guy/Desktop/", "darwin"))
      .toBe("/Users/guy/Desktop");
  });

  it("should strip hostname and trailing slash", () => {
    expect(normalizeSelectedPath("HOST/Users/guy/", "darwin"))
      .toBe("/Users/guy");
  });

  it("should strip hostname prefix on Linux", () => {
    expect(normalizeSelectedPath("hostname/home/user", "linux"))
      .toBe("/home/user");
  });

  it("should not modify Windows drive paths", () => {
    expect(normalizeSelectedPath("C:\\Users\\guy", "win32"))
      .toBe("C:\\Users\\guy");
  });

  it("should preserve Windows drive root with backslash", () => {
    expect(normalizeSelectedPath("C:\\", "win32"))
      .toBe("C:\\");
  });

  it("should preserve Windows drive root with forward slash", () => {
    expect(normalizeSelectedPath("C:/", "win32"))
      .toBe("C:/");
  });

  it("should preserve Unix root /", () => {
    expect(normalizeSelectedPath("/", "darwin"))
      .toBe("/");
  });

  it("should leave hostname-only (no slash) as-is", () => {
    expect(normalizeSelectedPath("HOSTNAME", "darwin"))
      .toBe("HOSTNAME");
  });
});

/**
 * The native picker is the user's authorization action (CRB-09): the directory
 * it returns becomes a writable project root, and a cancelled pick registers
 * nothing. Without that, a typed path could never be written to; with anything
 * more, a request could authorize its own destination.
 */
describe("GET — picker selection authorizes a project root", () => {
  it("records the picked directory and records nothing when cancelled", async () => {
    const { GET } = await import("../route");
    const { localApiRequest } = await import("@/test/localApiRequest");
    const { isRegisteredProjectRoot, resetProjectRootsForTest } = await import("@/lib/security/projectRoots.server");

    const picked = path.join(os.tmpdir(), "crb-picker-project");
    execStdout = `${picked}\n`;
    resetProjectRootsForTest();

    const response = await GET(localApiRequest({}, { method: "GET" }), {
      params: Promise.resolve({}),
    });
    expect(await response.json()).toMatchObject({ success: true, cancelled: false, path: picked });
    expect(isRegisteredProjectRoot(picked)).toBe(true);

    execStdout = "\n";
    resetProjectRootsForTest();
    const cancelled = await GET(localApiRequest({}, { method: "GET" }), {
      params: Promise.resolve({}),
    });
    expect(await cancelled.json()).toMatchObject({ cancelled: true });
    expect(isRegisteredProjectRoot(picked)).toBe(false);
  });
});
