import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { setAddressResolverForTest } from "@/lib/security/networkTargets.server";

// Security seams resolve destination addresses before connecting. Automated
// tests never perform DNS: every host resolves to a documentation address
// (TEST-NET-3) so the destination class checks still run, hermetically.
beforeAll(() => {
  setAddressResolverForTest(async () => ["203.0.113.10"]);
});

afterAll(() => {
  setAddressResolverForTest(null);
});

// Mock ResizeObserver for React Flow tests
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

global.ResizeObserver = ResizeObserverMock;

// Mock DOMMatrixReadOnly for React Flow
class DOMMatrixReadOnlyMock {
  m22: number = 1;
  constructor() {
    this.m22 = 1;
  }
}

global.DOMMatrixReadOnly = DOMMatrixReadOnlyMock as unknown as typeof DOMMatrixReadOnly;

// Cleanup after each test to ensure DOM is reset
afterEach(() => {
  cleanup();
});
