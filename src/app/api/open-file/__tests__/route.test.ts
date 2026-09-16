// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Use vi.hoisted so mock fns are available during vi.mock() hoisting
const { mockExecFileAsync, mockStat, mockPlatform, mockHomedir } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockStat: vi.fn(),
  mockPlatform: vi.fn(),
  mockHomedir: vi.fn(),
}));

vi.mock(import("child_process"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock(import("util"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    promisify: () => mockExecFileAsync,
  };
});

vi.mock(import("fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    stat: (...args: unknown[]) => mockStat(...args),
  };
});

vi.mock(import("os"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual,
      platform: () => mockPlatform(),
      homedir: () => mockHomedir(),
    },
    platform: () => mockPlatform(),
    homedir: () => mockHomedir(),
  };
});

import { POST } from "../route";
import { localApiRequest, TEST_LOCAL_ORIGIN } from "@/test/localApiRequest";

// Helper to create mock NextRequest. The privileged request guard runs for
// real, so the double is wrapped in an authenticated local-API envelope, which
// supplies the loopback Host the session capability is bound to. A case that
// names its own Host (e.g. a spoofed non-loopback one) still presents it.
function createMockRequest(
  body: unknown,
  headers?: Record<string, string>
): NextRequest {
  return localApiRequest(
    {
      json: vi.fn().mockResolvedValue(body),
      headers: new Headers(headers),
    } as unknown as NextRequest,
    { url: `${TEST_LOCAL_ORIGIN}/api/open-file`, headers },
  );
}

describe("/api/open-file route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.mockReturnValue("darwin");
    mockHomedir.mockReturnValue("/Users/testuser");
  });

  describe("localhost guard", () => {
    it("should return 403 for non-localhost x-forwarded-for", async () => {
      const request = createMockRequest(
        { filePath: "/Users/testuser/file.glb" },
        { "x-forwarded-for": "203.0.113.50" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("Forbidden: localhost only");
    });

    it("should return 403 for non-localhost host header", async () => {
      const request = createMockRequest(
        { filePath: "/Users/testuser/file.glb" },
        { host: "example.com" }
      );

      const response = await POST(request);
      const data = await response.json();

      // A non-loopback Host is now refused by the shared request guard, before
      // the route's own localhost gate runs. The route gate still handles the
      // forwarded-address cases below.
      expect(response.status).toBe(403);
      expect(data.reason).toBe("unexpected-host");
      expect(data.error).toBe("Request host is not this local instance");
    });

    it("should allow requests from 127.0.0.1 x-forwarded-for", async () => {
      mockStat.mockResolvedValue({ isFile: () => true });
      mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const request = createMockRequest(
        { filePath: "/Users/testuser/file.glb" },
        { "x-forwarded-for": "127.0.0.1" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should allow requests from ::1 x-forwarded-for", async () => {
      mockStat.mockResolvedValue({ isFile: () => true });
      mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const request = createMockRequest(
        { filePath: "/Users/testuser/file.glb" },
        { "x-forwarded-for": "::1" }
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should allow requests with a loopback host header", async () => {
      mockStat.mockResolvedValue({ isFile: () => true });
      mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const request = createMockRequest({ filePath: "/Users/testuser/file.glb" });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("should return 400 for missing filePath", async () => {
      const request = createMockRequest({});

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("File path is required");
    });

    it("should return 400 for empty filePath", async () => {
      const request = createMockRequest({ filePath: "" });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("File path is required");
    });

    it("should return 400 for non-string filePath", async () => {
      const request = createMockRequest({ filePath: 12345 });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("File path is required");
    });
  });

  describe("path restriction", () => {
    it("should return 403 for path outside home directory", async () => {
      const request = createMockRequest({ filePath: "/etc/passwd" });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe("Path is outside allowed directory");
    });
  });

  describe("file validation", () => {
    it("should return 400 when path is a directory", async () => {
      mockStat.mockResolvedValue({ isFile: () => false });

      const request = createMockRequest({
        filePath: "/Users/testuser/generations",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Path is not a file");
    });

    it("should return 400 when file does not exist", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));

      const request = createMockRequest({
        filePath: "/Users/testuser/nonexistent.glb",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("File does not exist");
    });
  });

  describe("platform commands", () => {
    it("should call 'open -R' on macOS", async () => {
      mockPlatform.mockReturnValue("darwin");
      mockStat.mockResolvedValue({ isFile: () => true });
      mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const request = createMockRequest({
        filePath: "/Users/testuser/generations/model.glb",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith("open", [
        "-R",
        "/Users/testuser/generations/model.glb",
      ]);
    });

    it("should call 'xdg-open' with parent directory on Linux", async () => {
      mockPlatform.mockReturnValue("linux");
      mockStat.mockResolvedValue({ isFile: () => true });
      mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const request = createMockRequest({
        filePath: "/Users/testuser/generations/model.glb",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith("xdg-open", [
        "/Users/testuser/generations",
      ]);
    });

    it("should return 500 when command execution fails", async () => {
      mockStat.mockResolvedValue({ isFile: () => true });
      mockExecFileAsync.mockRejectedValue(new Error("Command not found"));

      const request = createMockRequest({
        filePath: "/Users/testuser/generations/model.glb",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Failed to open file location");
    });
  });
});
