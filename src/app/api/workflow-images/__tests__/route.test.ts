import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mockStat = vi.fn();
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();
const mockAtomicReplaceFile = vi.fn();

vi.mock("fs/promises", () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

vi.mock("@/lib/projectFiles.server", () => ({
  atomicReplaceFile: (...args: unknown[]) => mockAtomicReplaceFile(...args),
}));

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { POST } from "../route";
import { localApiRequest } from "@/test/localApiRequest";

// The privileged request guard runs for real, so the double is wrapped in an
// authenticated local-API envelope (loopback Host, same-origin evidence,
// session capability, one-time nonce).
function createMockPostRequest(body: unknown): NextRequest {
  return localApiRequest(
    {
      json: vi.fn().mockResolvedValue(body),
    } as unknown as NextRequest,
  );
}

describe("/api/workflow-images route", () => {
  // A real project directory of the shape the user opens in the app: the write
  // scope check authorizes the caller-supplied project directory, so saving
  // into it is what a normal save does. Every filesystem call the route makes
  // is still mocked, so nothing is written for real; `node:fs` is used directly
  // here because `fs/promises` is the mocked module.
  let projectDir: string;

  beforeEach(() => {
    projectDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "crb-workflow-images-"));
    vi.clearAllMocks();
    mockAtomicReplaceFile.mockImplementation(
      async (filePath: string, bytes: Uint8Array) => mockWriteFile(filePath, bytes),
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
    nodeFs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe("POST - Save workflow image", () => {
    it("should save image when workflow directory exists", async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        workflowPath: projectDir,
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.imageId).toBe("img_123");
      expect(data.filePath).toBe(path.join(projectDir, "inputs", "img_123.png"));
      expect(mockMkdir).toHaveBeenCalledWith(path.join(projectDir, "inputs"), { recursive: true });
      // The image is replaced inside the project directory the request named.
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(projectDir, "inputs", "img_123.png"),
        expect.any(Buffer),
      );
    });

    it("should create missing workflow directory and save image", async () => {
      const workflowDir = path.join(projectDir, "new-workflow");

      mockStat.mockRejectedValue(new Error("ENOENT"));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        workflowPath: workflowDir,
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.filePath).toBe(path.join(workflowDir, "inputs", "img_123.png"));
      expect(mockMkdir).toHaveBeenCalledWith(workflowDir, { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith(path.join(workflowDir, "inputs"), { recursive: true });
    });

    it("should reject path traversal attempts", async () => {
      const request = createMockPostRequest({
        workflowPath: "/test/../etc/passwd",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path contains traversal sequences");
    });

    it("should reject non-absolute paths", async () => {
      const request = createMockPostRequest({
        workflowPath: "relative/path",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path must be absolute");
    });

    it("should reject dangerous system paths", async () => {
      const request = createMockPostRequest({
        workflowPath: "/etc/workflows",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Access to /etc is not allowed");
    });

    it("should refuse a save into the application's own source tree", async () => {
      // The caller-supplied project directory authorizes a save inside itself,
      // but never inside the app's source or static subtrees.
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        workflowPath: path.join(process.cwd(), "src", "app"),
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Write target not authorized");
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockAtomicReplaceFile).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});
