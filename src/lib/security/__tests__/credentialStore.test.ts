// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { credentialStorePath, createProtectedFileCredentialStore } from "../credentialStore.server";

afterEach(() => vi.unstubAllEnvs());
describe("persistent application-private credential storage", () => {
  it("does not place Provider credentials in the project or disposable runtime", () => {
    vi.stubEnv("CRB_CREDENTIAL_DIRECTORY", path.join(process.cwd(), "data", "auth"));
    expect(() => credentialStorePath()).toThrow(/outside project/);
    vi.stubEnv("CRB_TEMP_ROOT", path.resolve("../.tmp"));
    vi.stubEnv("CRB_CREDENTIAL_DIRECTORY", path.resolve("../.tmp", "auth"));
    expect(() => credentialStorePath()).toThrow(/temporary directories/);
  });
  it.skipIf(process.platform === "win32")("reopens owner-only atomic storage with synthetic values", async () => {
    const root = path.resolve(process.env.CRB_TEMP_ROOT || "../.tmp", "validation", "issue-10-oauth");
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, "credential-fixture-"));
    const file = path.join(directory, "auth", "credentials.json");
    try {
      const store = createProtectedFileCredentialStore(file);
      await store.set("synthetic", "仅合成凭据");
      const reopened = createProtectedFileCredentialStore(file);
      expect(await reopened.get("synthetic")).toBe("仅合成凭据");
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      expect((await fs.readdir(path.dirname(file))).filter(name => name.endsWith(".tmp"))).toEqual([]);
      await reopened.delete("synthetic");
      expect(await store.keys()).toEqual([]);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
