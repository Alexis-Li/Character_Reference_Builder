/**
 * CLI / automation authentication (CRB-09 / Issue #10).
 *
 * Tightening the browser boundary must not force an unsafe exception for
 * scripts, so automation authenticates with its own credential instead of
 * borrowing a browser session: a 256-bit random token that is either supplied
 * through `CRB_LOCAL_API_TOKEN` or generated once and kept outside the
 * repository in the runtime state directory (`<CRB_TEMP_ROOT>/runtime/`),
 * created with owner-only permissions.
 *
 * The token is never returned to a browser and never persisted with project
 * data; only its hash is compared, in constant time.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CLI_TOKEN_ENV = "CRB_LOCAL_API_TOKEN";
export const CLI_TOKEN_FILENAME = "local-api-token";

export function resolveRuntimeStateDir(): string {
  const configured = process.env.CRB_TEMP_ROOT?.trim();
  const root =
    configured && configured.length > 0
      ? configured
      : path.join(os.tmpdir(), "Character_Reference_Builder");
  return path.join(root, "runtime");
}

/** Absolute path of the generated CLI token, publishable as operator documentation. */
export function cliTokenPath(): string {
  return path.join(resolveRuntimeStateDir(), CLI_TOKEN_FILENAME);
}

let cachedToken: string | null = null;

function readTokenFile(): string | null {
  try {
    const value = fs.readFileSync(cliTokenPath(), "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeTokenFile(token: string): void {
  const directory = resolveRuntimeStateDir();
  fs.mkdirSync(directory, { recursive: true });
  // `mode` is enforced on POSIX; on Windows the file inherits the profile ACL
  // of the temp root, which is still user-scoped and outside the repository.
  fs.writeFileSync(cliTokenPath(), `${token}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * The token automation must present. Environment wins so a script can pin its
 * own value; otherwise one is generated and reused for this machine.
 */
export function localCliToken(): { token: string; source: "environment" | "file" } {
  const fromEnv = process.env[CLI_TOKEN_ENV]?.trim();
  if (fromEnv) return { token: fromEnv, source: "environment" };

  if (cachedToken) return { token: cachedToken, source: "file" };
  const existing = readTokenFile();
  if (existing) {
    cachedToken = existing;
    return { token: existing, source: "file" };
  }

  const generated = crypto.randomBytes(32).toString("base64url");
  writeTokenFile(generated);
  cachedToken = generated;
  return { token: generated, source: "file" };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Validate a presented CLI bearer token against this instance's token.
 * A missing instance token fails closed rather than accepting anything.
 */
export function authorizeCliToken(candidate: string | null): boolean {
  if (!candidate || candidate.length < 16) return false;
  let expected: string;
  try {
    expected = localCliToken().token;
  } catch {
    return false;
  }
  return constantTimeEquals(candidate, expected);
}

/** Test seam: forget the process-cached token. */
export function resetCliTokenCacheForTest(): void {
  cachedToken = null;
}
