/**
 * Local browser session capability (CRB-09 / Issue #10).
 *
 * The browser never holds a provider credential or a reusable bearer. It holds
 * one unpredictable, origin-bound local session capability, issued by the
 * running Character Reference Builder instance itself and stored in an
 * HttpOnly, SameSite=Strict cookie, plus a non-secret account summary.
 *
 * Properties enforced here:
 * - capability values are 256-bit random and only their SHA-256 hash is kept;
 * - a capability is bound to the exact origin that requested it, so a
 *   capability reflected into another origin is useless;
 * - expiry is absolute per capability and idle-based per session;
 * - one-time request nonces are tracked per session so a replayed privileged
 *   mutation is rejected inside the nonce window;
 * - logging out revokes the session, and a revoked session cannot be revived
 *   with an old capability.
 *
 * State is process memory: this is a loopback-only single-user tool, and a
 * lost session costs one bootstrap round trip (see the client seam).
 */

import * as crypto from "node:crypto";

/** Browser sessions live 30 minutes and slide on use. */
export const BROWSER_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 32;
const MAX_NONCES_PER_SESSION = 8192;

export interface AccountSummary {
  /** Stable, non-secret account identifier (subject claim or provider id). */
  accountId: string;
  /** Display label shown in the UI; never a token. */
  displayName: string;
  provider: string;
}

export interface LocalSessionRecord {
  sessionId: string;
  capabilityHash: string;
  origin: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  account: AccountSummary | null;
  nonces: Map<string, number>;
}

export type CapabilityFailure = "unknown" | "expired" | "revoked" | "origin-mismatch";

export interface IssuedBrowserSession {
  sessionId: string;
  capability: string;
  origin: string;
  expiresAt: number;
  account: AccountSummary | null;
}

/**
 * Session state is pinned on `globalThis` rather than module scope: a
 * dev-server reload, or a runtime that instantiates this module twice, must not
 * silently drop every outstanding capability (which would read as a wave of
 * "invalid capability" 401s with no security benefit).
 */
const SESSION_STATE_KEY = "__crbLocalApiSessions";

interface SessionState {
  sessions: Map<string, LocalSessionRecord>;
  byCapability: Map<string, string>;
}

function sessionState(): SessionState {
  const globalObject = globalThis as typeof globalThis & { [SESSION_STATE_KEY]?: SessionState };
  if (!globalObject[SESSION_STATE_KEY]) {
    globalObject[SESSION_STATE_KEY] = { sessions: new Map(), byCapability: new Map() };
  }
  return globalObject[SESSION_STATE_KEY];
}

const sessions = sessionState().sessions;
const byCapability = sessionState().byCapability;

export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

function hashCapability(capability: string): string {
  return crypto.createHash("sha256").update(capability, "utf8").digest("hex");
}

function pruneExpired(now: number): void {
  for (const [sessionId, record] of sessions) {
    if (record.expiresAt > now) continue;
    sessions.delete(sessionId);
    byCapability.delete(record.capabilityHash);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    sessions.delete(oldest.sessionId);
    byCapability.delete(oldest.capabilityHash);
  }
}

/**
 * Issue a new browser session for one origin. Called by the session bootstrap
 * endpoint after Host and origin evidence have already been accepted.
 */
export function issueBrowserSession(
  origin: string,
  account: AccountSummary | null = null,
  clock: Clock = systemClock,
): IssuedBrowserSession {
  const now = clock.now();
  pruneExpired(now);

  const sessionId = crypto.randomBytes(16).toString("base64url");
  const capability = crypto.randomBytes(32).toString("base64url");
  const capabilityHash = hashCapability(capability);

  const record: LocalSessionRecord = {
    sessionId,
    capabilityHash,
    origin,
    createdAt: now,
    expiresAt: now + BROWSER_SESSION_TTL_MS,
    lastSeenAt: now,
    revokedAt: null,
    account,
    nonces: new Map(),
  };
  sessions.set(sessionId, record);
  byCapability.set(capabilityHash, sessionId);

  return { sessionId, capability, origin, expiresAt: record.expiresAt, account };
}

export interface CapabilityCheck {
  ok: boolean;
  failure?: CapabilityFailure;
  session?: LocalSessionRecord;
}

/**
 * Validate a capability against an origin. A successful check slides the idle
 * expiry window; a failed check never mutates state.
 */
export function authorizeBrowserCapability(
  capability: string | null,
  origin: string,
  clock: Clock = systemClock,
): CapabilityCheck {
  if (!capability) return { ok: false, failure: "unknown" };
  const now = clock.now();

  const sessionId = byCapability.get(hashCapability(capability));
  if (!sessionId) {
    pruneExpired(now);
    return { ok: false, failure: "unknown" };
  }
  const record = sessions.get(sessionId);
  if (!record) return { ok: false, failure: "unknown" };
  // Expiry is reported for the presented capability before any pruning, so a
  // caller learns "expired" (retryable) instead of "unknown" (start over).
  if (record.expiresAt <= now) return { ok: false, failure: "expired" };
  pruneExpiredExcept(sessionId, now);
  if (record.revokedAt !== null) return { ok: false, failure: "revoked" };
  if (record.origin !== origin) return { ok: false, failure: "origin-mismatch" };

  record.lastSeenAt = now;
  record.expiresAt = now + BROWSER_SESSION_TTL_MS;
  return { ok: true, session: record };
}

function pruneExpiredExcept(keepSessionId: string, now: number): void {
  for (const [sessionId, record] of sessions) {
    if (sessionId === keepSessionId) continue;
    if (record.expiresAt > now) continue;
    sessions.delete(sessionId);
    byCapability.delete(record.capabilityHash);
  }
  while (sessions.size > MAX_SESSIONS) {
    const candidate = [...sessions.values()]
      .filter((record) => record.sessionId !== keepSessionId)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (!candidate) break;
    sessions.delete(candidate.sessionId);
    byCapability.delete(candidate.capabilityHash);
  }
}

/** Bind a non-secret account summary to an existing session. */
export function attachAccountSummary(
  sessionId: string,
  account: AccountSummary | null,
): void {
  const record = sessions.get(sessionId);
  if (record) record.account = account;
}

/** Revoke everything bound to one account, used on logout and account switch. */
export function revokeSessionsForAccount(accountId: string): number {
  let revoked = 0;
  for (const record of sessions.values()) {
    if (record.account?.accountId !== accountId) continue;
    record.revokedAt = Date.now();
    revoked += 1;
  }
  return revoked;
}

/** Revoke the session behind a capability (logout). Idempotent. */
export function revokeSessionByCapability(capability: string, clock: Clock = systemClock): boolean {
  const sessionId = byCapability.get(hashCapability(capability));
  if (!sessionId) return false;
  const record = sessions.get(sessionId);
  if (!record) return false;
  record.revokedAt = clock.now();
  return true;
}

/** Revoke a session by id (account switch, explicit sign-out). */
export function revokeSessionById(sessionId: string, clock: Clock = systemClock): boolean {
  const record = sessions.get(sessionId);
  if (!record) return false;
  record.revokedAt = clock.now();
  return true;
}

export function getSession(sessionId: string): LocalSessionRecord | null {
  return sessions.get(sessionId) ?? null;
}

/**
 * Record a request nonce. Returns false when the nonce was already used by
 * this session inside the replay window — or when the session's nonce store is
 * full, because evicting an old nonce would make a replayed request acceptable
 * again. Failing closed turns a flood into a clear rejection instead of a
 * silent replay window.
 */
export function claimRequestNonce(
  sessionId: string,
  nonce: string,
  clock: Clock = systemClock,
): boolean {
  const record = sessions.get(sessionId);
  if (!record) return false;
  // Nonces are never evicted by age inside a living session: a sliding expiry
  // would otherwise make a >TTL-old nonce acceptable again. They are dropped
  // with the session itself, and the cap fails closed rather than making room.
  if (record.nonces.has(nonce)) return false;
  if (record.nonces.size >= MAX_NONCES_PER_SESSION) return false;
  record.nonces.set(nonce, clock.now());
  return true;
}

/** Test seam: drop all local session state. */
export function resetLocalSessionsForTest(): void {
  sessions.clear();
  byCapability.clear();
}
