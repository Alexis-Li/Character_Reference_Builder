/**
 * Guard coverage suite (CRB-09 / Issue #10).
 *
 * Structural + behavioral evidence that no privileged API entry is left
 * unguarded: every route module under `src/app/api` must either export guarded
 * handlers (the marker the guard sets) or be one of the explicitly reviewed
 * public entries below. Each guarded handler is additionally driven with a
 * hostile request to prove the guard runs *first* — no provider call, file
 * touch or backend contact happens before a decision.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { NextRequest } from "next/server";
import { guardedEffectsOf } from "../requestGuard.server";
import { resetLocalSessionsForTest } from "../localSession.server";
import { resetCliTokenCacheForTest } from "../cliAuth.server";

const API_ROOT = path.join(process.cwd(), "src", "app", "api");

/**
 * Routes intentionally reachable without a local session, each for one reason.
 * Everything else must be guarded; adding an entry here is a reviewed decision.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  "session/route.ts": "session bootstrap: issues the capability, still requires loopback Host and same-origin evidence",
};

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

async function findRouteFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findRouteFiles(absolute)));
      continue;
    }
    if (entry.name === "route.ts") found.push(absolute);
  }
  return found.sort();
}

function relative(absolute: string): string {
  return path.relative(API_ROOT, absolute).replaceAll("\\", "/");
}

describe("privileged API guard coverage", () => {
  beforeEach(() => {
    resetLocalSessionsForTest();
    resetCliTokenCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("guards every API route except the reviewed public entries", async () => {
    const routeFiles = await findRouteFiles(API_ROOT);
    expect(routeFiles.length).toBeGreaterThan(20);

    const unguarded: string[] = [];
    const guarded: string[] = [];

    for (const file of routeFiles) {
      const key = relative(file);
      // Route modules are discovered by walking the API tree, so the specifier
      // is runtime-selected and cannot be a static import. A missed route is
      // exactly the failure this test exists to catch.
      const moduleExports: Record<string, unknown> = await import(/* @vite-ignore */ file);
      const handlers = HTTP_METHODS.map((method) => moduleExports[method]).filter(
        (handler) => typeof handler === "function",
      );
      expect(handlers.length, `${key} exports at least one HTTP handler`).toBeGreaterThan(0);

      const allGuarded = handlers.every((handler) => guardedEffectsOf(handler) !== null);
      if (allGuarded) {
        guarded.push(key);
        continue;
      }
      if (PUBLIC_ROUTES[key]) continue;
      unguarded.push(key);
    }

    expect(unguarded).toEqual([]);
    expect(guarded.length).toBeGreaterThan(20);
  }, 180_000);

  it("refuses a hostile request before any route code runs, for every guarded handler", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const routeFiles = await findRouteFiles(API_ROOT);
    const reached: string[] = [];

    for (const file of routeFiles) {
      const key = relative(file);
      if (PUBLIC_ROUTES[key]) continue;
      const moduleExports: Record<string, unknown> = await import(/* @vite-ignore */ file);

      for (const method of HTTP_METHODS) {
        const handler = moduleExports[method];
        if (typeof handler !== "function") continue;

        const request = new NextRequest("http://127.0.0.1:3210/api/whatever", {
          method,
          headers: {
            // A page from another site reaching the loopback server.
            host: "attacker.example",
            origin: "http://attacker.example",
            "content-type": "application/json",
          },
        });

        const response = await (handler as (request: NextRequest, context: unknown) => Promise<Response>)(
          request,
          { params: Promise.resolve({ id: "1", modelId: "1" }) },
        );

        if (response.status !== 403) {
          reached.push(`${key} ${method} → ${response.status}`);
        }
      }
    }

    expect(reached).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 180_000);
});
