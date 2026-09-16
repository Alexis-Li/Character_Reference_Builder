"use client";

/**
 * Local session gate (CRB-09 / Issue #10).
 *
 * Installs the browser-side local API seam before any page code can call an
 * API route, then bootstraps the local session capability once. The component
 * renders nothing.
 *
 * The seam is installed at module evaluation (not only in an effect) because a
 * child effect can fire an API call before a parent effect runs; installing
 * during import guarantees no privileged call escapes it.
 */

import { useEffect } from "react";
import { ensureLocalSession, installLocalApiFetch } from "@/lib/localApi";

if (typeof window !== "undefined") {
  installLocalApiFetch();
}

export function LocalSessionGate() {
  useEffect(() => {
    // A bootstrap failure is not fatal: the next privileged call retries, and
    // the resulting 401 names the missing session instead of hiding it.
    void ensureLocalSession().catch(() => undefined);
  }, []);

  return null;
}
