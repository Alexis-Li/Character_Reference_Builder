/**
 * Protected server-side credential storage (CRB-09 / Issue #10).
 *
 * Refresh tokens and any reusable bearer material live here — never in a
 * Character Project, a template, an export, a browser download, a console log
 * or the browser itself. The browser receives an account summary and a
 * short-lived local session capability, nothing more.
 *
 * Persistent application-private storage outside projects and disposable
 * runtime directories. Windows uses CurrentUser DPAPI; POSIX uses an owner-only
 * directory/file. No credentials from other applications are imported.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** In-memory store: tests and any run that has no protected directory yet. */
export function createMemoryCredentialStore(): CredentialStore {
  const entries = new Map<string, string>();
  return {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
    async keys() {
      return [...entries.keys()];
    },
  };
}

export function credentialStorePath(): string {
  const directory = process.env.CRB_CREDENTIAL_DIRECTORY || (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CharacterReferenceBuilder", "auth")
    : path.join(os.homedir(), ".local", "share", "character-reference-builder", "auth"));
  const resolved = path.resolve(directory);
  const below = (root: string) => { const relative = path.relative(path.resolve(root), resolved); return !relative.startsWith("..") && !path.isAbsolute(relative); };
  if (below(process.cwd()) || (process.env.CRB_TEMP_ROOT && below(process.env.CRB_TEMP_ROOT))) {
    throw new Error("Credential directory must be persistent and outside project/temporary directories");
  }
  return path.join(resolved, process.platform === "win32" ? "credentials.dpapi" : "credentials.json");
}

/** Windows CurrentUser DPAPI; values travel via stdin, never command arguments. */
function windowsProtect(value: string, decrypt: boolean): string {
  const script = `Add-Type -AssemblyName System.Security; $v = [Console]::In.ReadToEnd(); ` + (decrypt
    ? `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))`
    : `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($v), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))`);
  const input = decrypt ? value : Buffer.from(value, "utf8").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error("Windows credential protection failed");
  return decrypt ? Buffer.from(result.stdout.trim(), "base64").toString("utf8") : result.stdout.trim();
}

/**
 * Owner-only JSON file store. Reads tolerate a missing or unreadable file
 * (treated as "no credentials") and writes replace the file atomically so a
 * crash never leaves a partially written secret file behind.
 */
export function createProtectedFileCredentialStore(filePath: string = credentialStorePath()): CredentialStore {
  const read = (): Record<string, string> => {
    try {
      const bytes = fs.readFileSync(filePath, "utf8");
      const raw = process.platform === "win32" ? windowsProtect(bytes, true) : bytes;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") result[key] = value;
      }
      return result;
    } catch {
      return {};
    }
  };

  const write = (entries: Record<string, string>): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(path.dirname(filePath), 0o700);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const serialized = JSON.stringify(entries);
    fs.writeFileSync(temporary, process.platform === "win32" ? windowsProtect(serialized, false) : serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  };

  return {
    async get(key) {
      return read()[key] ?? null;
    },
    async set(key, value) {
      const entries = read();
      entries[key] = value;
      write(entries);
    },
    async delete(key) {
      const entries = read();
      if (!(key in entries)) return;
      delete entries[key];
      write(entries);
    },
    async keys() {
      return Object.keys(read());
    },
  };
}

let storeOverride: CredentialStore | null = null;

/** Test seam: pin a store for the process. `null` restores the default. */
export function setCredentialStoreForTest(store: CredentialStore | null): void {
  storeOverride = store;
}

export function defaultCredentialStore(): CredentialStore {
  return storeOverride ?? createProtectedFileCredentialStore();
}
