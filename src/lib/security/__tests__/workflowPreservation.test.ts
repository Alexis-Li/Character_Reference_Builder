/**
 * Preservation acceptance suite (CRB-09 / Issue #10).
 *
 * The security gate must never cost users their work. These cases drive the
 * real seams against a temporary Character Project and assert that refused or
 * failed authentication leaves the project bytes exactly as they were: no new
 * files, no partial writes, no deleted candidates, and no invalidated
 * selection. Authentication state becomes unusable; project state does not.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as saveGeneration } from "@/app/api/save-generation/route";
import { POST as referencePackage } from "@/app/api/reference-package/route";
import { OAuthSessionAdapter, type OAuthProviderTarget } from "../oauthSession.server";
import { createMemoryCredentialStore } from "../credentialStore.server";
import { issueBrowserSession, resetLocalSessionsForTest } from "../localSession.server";
import { resetCliTokenCacheForTest } from "../cliAuth.server";

const ORIGIN = "http://127.0.0.1:3210";

const TARGET: OAuthProviderTarget = {
  id: "synthetic-oauth-provider",
  implementationSource: "synthetic/fixture",
  implementationVersion: "test-fixture-1",
  provider: "synthetic",
  issuer: "https://issuer.synthetic.test",
  authorizationEndpoint: "https://issuer.synthetic.test/authorize",
  tokenEndpoint: "https://issuer.synthetic.test/token",
  revocationEndpoint: "https://issuer.synthetic.test/revoke",
  clientId: "synthetic-client",
  redirectUri: "http://127.0.0.1:3210/api/oauth/callback",
  minimumScopes: ["images.read"],
  accountRestrictions: "synthetic account only",
};

/** Snapshot every file below a directory: relative path → sha256. */
async function snapshotDirectory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const bytes = await fs.readFile(absolute);
      result[path.relative(root, absolute).replaceAll("\\", "/")] = createHash("sha256")
        .update(bytes)
        .digest("hex");
    }
  };
  await walk(root);
  return result;
}

async function createProject(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, "inputs"), { recursive: true });
  await fs.mkdir(path.join(root, "generations"), { recursive: true });
  await fs.writeFile(
    path.join(root, "character-project.json"),
    JSON.stringify({
      version: "1.0",
      project: { id: "char-001", name: "角色 项目" },
      nodes: [{ id: "n1", type: "imageInput", data: { selectedResultId: "img-approved-1" } }],
    }),
    "utf8",
  );
  await fs.writeFile(path.join(root, "inputs", "design-reference.png"), "not-a-real-png", "utf8");
  await fs.writeFile(path.join(root, "generations", "img-approved-1.png"), "approved-candidate", "utf8");
  return root;
}

describe("authentication failure preserves existing work", () => {
  let projectRoot: string;
  const created: string[] = [];

  beforeEach(async () => {
    resetLocalSessionsForTest();
    resetCliTokenCacheForTest();
    projectRoot = await createProject("crb-09-preserve-");
    created.push(projectRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("a refused media save leaves the project directory byte-identical", async () => {
    const before = await snapshotDirectory(projectRoot);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const refused = await saveGeneration(
      new NextRequest(`${ORIGIN}/api/save-generation`, {
        method: "POST",
        headers: { host: "127.0.0.1:3210", origin: "http://attacker.example", "content-type": "application/json" },
        body: JSON.stringify({
          directoryPath: projectRoot,
          image: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
          prompt: "should never run",
        }),
      }),
      {} as Record<string, never>,
    );

    expect(refused.status).toBeGreaterThanOrEqual(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshotDirectory(projectRoot)).toEqual(before);
  });

  it("a refused reference-package export creates nothing and keeps prior exports readable", async () => {
    await fs.mkdir(path.join(projectRoot, "exports"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "exports", "reference-package-v1.zip"), "previous export", "utf8");
    const before = await snapshotDirectory(projectRoot);

    const refused = await referencePackage(
      new NextRequest(`${ORIGIN}/api/reference-package`, {
        method: "POST",
        headers: { host: "127.0.0.1:3210", "content-type": "application/json" },
        body: JSON.stringify({ directoryPath: projectRoot, filename: "reference-package-v2" }),
      }),
      {} as Record<string, never>,
    );

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await snapshotDirectory(projectRoot)).toEqual(before);
  });

  it("a failed media download writes no partial file and keeps the selected result", async () => {
    const session = issueBrowserSession(ORIGIN);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    const before = await snapshotDirectory(projectRoot);

    const response = await saveGeneration(
      new NextRequest(`${ORIGIN}/api/save-generation`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3210",
          origin: ORIGIN,
          "content-type": "application/json",
          cookie: `crb_local_session=${session.capability}`,
          "x-crb-request-nonce": "preservation-nonce-1",
        },
        body: JSON.stringify({
          directoryPath: projectRoot,
          image: "https://cdn.example.test/generated.png",
          prompt: "attempt",
        }),
      }),
      {} as Record<string, never>,
    );

    // Accepted request, failed upstream: the failure is reported, and nothing
    // partial lands next to the user's approved result.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await snapshotDirectory(projectRoot)).toEqual(before);
  });

  it("logout, account switch, refresh failure and revocation leave the project untouched", async () => {
    const before = await snapshotDirectory(projectRoot);
    const store = createMemoryCredentialStore();
    const adapter = new OAuthSessionAdapter({
      target: TARGET,
      store,
      transports: {
        exchange: async () => ({
          ok: true,
          tokens: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresIn: 3600 },
          account: { sub: "acct-synthetic-1", name: "Synthetic" },
        }),
        refresh: async () => ({ ok: false, status: 400, error: "invalid_grant" }),
      },
    });

    const started = adapter.startAuthorization("session-under-test");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const authenticated = await adapter.handleCallback({
      state: started.state,
      codes: ["synthetic-code"],
      sessionId: "session-under-test",
      issuer: TARGET.issuer,
      clientId: TARGET.clientId,
      redirectUri: TARGET.redirectUri,
    });
    expect(authenticated.ok).toBe(true);

    // Refresh failure: the session says re-authentication is required, the
    // project and the selected result are still there.
    const refreshed = await adapter.refresh();
    expect(refreshed).toMatchObject({ ok: false, reason: "refresh-rejected" });
    expect(adapter.state).toBe("re-authentication-required");
    expect(await snapshotDirectory(projectRoot)).toEqual(before);
    expect(adapter.grantReview().account?.accountId).toBe("acct-synthetic-1");

    // Logout then revocation then account switch.
    await adapter.logout();
    await adapter.revoke();
    await adapter.switchAccount();
    expect(await snapshotDirectory(projectRoot)).toEqual(before);

    const afterLogout = await adapter.accessToken();
    expect(afterLogout.ok).toBe(false);
  });
});
