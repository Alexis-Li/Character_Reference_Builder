/**
 * Protected server-side credential storage (CRB-09 / Issue #10).
 *
 * Refresh tokens and any reusable bearer material live here — never in a
 * Character Project, a template, an export, a browser download, a console log
 * or the browser itself. The browser receives an account summary and a
 * short-lived local session capability, nothing more.
 *
 * The default implementation keeps credentials in a single owner-only file
 * outside the repository (under the runtime state directory). The interface is
 * deliberately narrow so a platform credential facility (Windows Credential
 * Manager, Keychain) can replace it without touching the OAuth adapter, and
 * that substitution is recorded as a remaining limitation of this gate rather
 * than implied to be done.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRuntimeStateDir } from "./cliAuth.server";

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
  return path.join(resolveRuntimeStateDir(), "credentials.json");
}

/**
 * Owner-only JSON file store. Reads tolerate a missing or unreadable file
 * (treated as "no credentials") and writes replace the file atomically so a
 * crash never leaves a partially written secret file behind.
 */
export function createProtectedFileCredentialStore(filePath: string = credentialStorePath()): CredentialStore {
  const read = (): Record<string, string> => {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
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
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries), { encoding: "utf8", mode: 0o600 });
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
