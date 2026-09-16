import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import * as crypto from "crypto";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock fs/promises before importing the route
const mockStat = vi.fn();
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();
const mockReaddir = vi.fn();

vi.mock("fs/promises", () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
}));

// Mock logger to avoid console noise during tests
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Store original fetch
const originalFetch = global.fetch;

import { POST, getExtensionFromUrl } from "../route";
import { localApiRequest } from "@/test/localApiRequest";

// Helper to create mock NextRequest for POST. The privileged request guard runs
// for real, so the double is wrapped in an authenticated local-API envelope
// (loopback Host, same-origin evidence, session capability, one-time nonce).
function createMockPostRequest(body: unknown): NextRequest {
  return localApiRequest(
    {
      json: vi.fn().mockResolvedValue(body),
    } as unknown as NextRequest,
  );
}

// Helper to compute expected hash for testing
function computeExpectedHash(buffer: Buffer): string {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

// Helper to create base64 data URL from string content
function createBase64DataUrl(content: string, mimeType = "image/png"): string {
  const buffer = Buffer.from(content);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

describe("/api/save-generation route", () => {
  // A real project directory of the shape the user opens in the app: the write
  // scope check authorizes the caller-supplied project directory, which is what
  // a normal save passes. Every filesystem call the route makes is still
  // mocked, so nothing is written for real; `node:fs` is used directly here
  // because `fs/promises` is the mocked module.
  let projectDir: string;

  beforeEach(() => {
    projectDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "crb-save-generation-"));
    vi.clearAllMocks();
    // Reset fetch mock
    global.fetch = originalFetch;
  });

  afterEach(() => {
    vi.resetAllMocks();
    global.fetch = originalFetch;
    nodeFs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe("POST - Save generation", () => {
    it("should save base64 image with hash-based filename", async () => {
      const imageContent = "test-image-content";
      const base64Image = createBase64DataUrl(imageContent, "image/png");
      const expectedHash = computeExpectedHash(Buffer.from(imageContent));

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: base64Image,
        prompt: "A test image",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.isDuplicate).toBe(false);
      expect(data.filename).toContain(expectedHash);
      expect(data.filename.endsWith(".png")).toBe(true);
      expect(data.filePath).toBe(path.join(projectDir, data.filename));
      // The bytes are written inside the project directory the request named.
      expect(mockWriteFile).toHaveBeenCalledWith(path.join(projectDir, data.filename), expect.any(Buffer));
    });

    it("should save base64 video with hash-based filename", async () => {
      const videoContent = "test-video-content";
      const base64Video = createBase64DataUrl(videoContent, "video/mp4");
      const expectedHash = computeExpectedHash(Buffer.from(videoContent));

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        video: base64Video,
        prompt: "A test video",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.isDuplicate).toBe(false);
      expect(data.filename).toContain(expectedHash);
      expect(data.filename.endsWith(".mp4")).toBe(true);
    });

    it("should deduplicate existing files by hash suffix", async () => {
      const imageContent = "duplicate-image-content";
      const base64Image = createBase64DataUrl(imageContent, "image/png");
      const expectedHash = computeExpectedHash(Buffer.from(imageContent));
      const existingFilename = `existing_prompt_${expectedHash}.png`;

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([existingFilename]);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: base64Image,
        prompt: "Another prompt",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.isDuplicate).toBe(true);
      expect(data.filename).toBe(existingFilename);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("should reject missing directoryPath", async () => {
      const request = createMockPostRequest({
        image: createBase64DataUrl("content"),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Missing required fields");
    });

    it("should reject missing content (no image or video)", async () => {
      const request = createMockPostRequest({
        directoryPath: projectDir,
        prompt: "A prompt without content",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Missing required fields");
    });

    it("should reject non-directory path", async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => false,
      });

      const request = createMockPostRequest({
        directoryPath: path.join(projectDir, "file.txt"),
        image: createBase64DataUrl("content"),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path is not a directory");
    });

    it("should reject non-existent directory", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));

      const request = createMockPostRequest({
        directoryPath: path.join(projectDir, "missing-dir"),
        image: createBase64DataUrl("content"),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Directory does not exist");
    });

    it("should handle various MIME types correctly", async () => {
      const testCases = [
        { mimeType: "image/jpeg", expectedExt: ".jpg" },
        { mimeType: "image/gif", expectedExt: ".gif" },
        { mimeType: "image/webp", expectedExt: ".webp" },
        { mimeType: "video/webm", expectedExt: ".webm" },
        { mimeType: "video/quicktime", expectedExt: ".mov" },
      ];

      for (const { mimeType, expectedExt } of testCases) {
        vi.clearAllMocks();

        const content = `test-content-${mimeType}`;
        const dataUrl = createBase64DataUrl(content, mimeType);

        mockStat.mockResolvedValue({
          isDirectory: () => true,
        });
        mockReaddir.mockResolvedValue([]);
        mockWriteFile.mockResolvedValue(undefined);

        const request = createMockPostRequest({
          directoryPath: projectDir,
          image: dataUrl,
          prompt: "Test",
        });

        const response = await POST(request);
        const data = await response.json();

        expect(data.success).toBe(true);
        expect(data.filename.endsWith(expectedExt)).toBe(true);
      }
    });

    it("should handle HTTP URLs by fetching content", async () => {
      const mockContent = "fetched-image-content";
      const expectedHash = computeExpectedHash(Buffer.from(mockContent));

      // Mock fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "image/png"]]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(mockContent).buffer),
      }) as unknown as typeof fetch;

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: "https://example.com/image.png",
        prompt: "Fetched image",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.filename).toContain(expectedHash);
      // Fetch is called with URL and options object containing AbortController signal
      expect(global.fetch).toHaveBeenCalledWith(
        "https://example.com/image.png",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it("should handle failed HTTP fetch", async () => {
      // Mock fetch to return error
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      }) as unknown as typeof fetch;

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: "https://example.com/nonexistent.png",
        prompt: "Missing image",
      });

      const response = await POST(request);
      const data = await response.json();

      // The download seam reports an upstream failure as a bad-gateway refusal
      // when the provider answers with an error status.
      expect(response.status).toBe(502);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Failed to fetch content");
    });

    it("should handle raw base64 without data URL prefix", async () => {
      const content = "raw-base64-content";
      const rawBase64 = Buffer.from(content).toString("base64");
      const expectedHash = computeExpectedHash(Buffer.from(content));

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: rawBase64,
        prompt: "Raw base64",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.filename).toContain(expectedHash);
      // Falls back to png when no data URL prefix
      expect(data.filename.endsWith(".png")).toBe(true);
    });

    it("should sanitize prompt for filename", async () => {
      const imageContent = "content-for-sanitize-test";
      const base64Image = createBase64DataUrl(imageContent, "image/png");

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: base64Image,
        prompt: "Hello! @World# with $pecial chars%",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      // Prompt should be sanitized - no special chars
      expect(data.filename).toMatch(/^[a-z0-9_]+_[a-f0-9]+\.png$/);
    });

    it("should use 'generation' as default prompt snippet when prompt is empty", async () => {
      const imageContent = "content-no-prompt";
      const base64Image = createBase64DataUrl(imageContent, "image/png");

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: base64Image,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.filename).toMatch(/^generation_[a-f0-9]+\.png$/);
    });

    it("should return 500 on write failure", async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockRejectedValue(new Error("Disk full"));

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: createBase64DataUrl("content"),
        prompt: "Test",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Disk full");
    });

    it("should return imageId without extension", async () => {
      const imageContent = "content-for-id-test";
      const base64Image = createBase64DataUrl(imageContent, "image/png");
      const expectedHash = computeExpectedHash(Buffer.from(imageContent));

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: base64Image,
        prompt: "Test",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.imageId).not.toContain(".png");
      expect(data.imageId).toContain(expectedHash);
    });

    it("should use custom filename when provided", async () => {
      const imageContent = "content-for-custom-filename";
      const base64Image = createBase64DataUrl(imageContent, "image/png");
      const expectedHash = computeExpectedHash(Buffer.from(imageContent));

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: base64Image,
        customFilename: "my-custom-output",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.filename).toBe(`my-custom-output_${expectedHash}.png`);
    });

    it("should sanitize custom filename", async () => {
      const imageContent = "content-for-sanitize-custom";
      const base64Image = createBase64DataUrl(imageContent, "image/png");
      const expectedHash = computeExpectedHash(Buffer.from(imageContent));

      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: base64Image,
        customFilename: "My File!@#$%Name",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      // Special chars should be replaced with underscores, multiple underscores collapsed
      expect(data.filename).toBe(`My_File_Name_${expectedHash}.png`);
    });

    it("should create directory when createDirectory is true", async () => {
      const imageContent = "content-for-create-dir";
      const base64Image = createBase64DataUrl(imageContent, "image/png");

      // Directory doesn't exist initially
      mockStat.mockRejectedValue(new Error("ENOENT"));
      mockMkdir.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: base64Image,
        createDirectory: true,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith(projectDir, { recursive: true });
    });

    it("should not create directory when createDirectory is false", async () => {
      // Directory doesn't exist
      mockStat.mockRejectedValue(new Error("ENOENT"));

      const request = createMockPostRequest({
        directoryPath: path.join(projectDir, "missing-dir"),
        image: createBase64DataUrl("content"),
        createDirectory: false,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Directory does not exist");
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it("should handle mkdir failure", async () => {
      // Directory doesn't exist
      mockStat.mockRejectedValue(new Error("ENOENT"));
      mockMkdir.mockRejectedValue(new Error("Permission denied"));

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: createBase64DataUrl("content"),
        createDirectory: true,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Failed to create output directory");
    });

    it("should refuse a media URL to the metadata address over plain http", async () => {
      const fetched = vi.fn();
      global.fetch = fetched as unknown as typeof fetch;
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: "http://169.254.169.254/latest/meta-data/",
        prompt: "Metadata",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("protocol");
      expect(fetched).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("should refuse an https media URL that points at the link-local metadata address", async () => {
      const fetched = vi.fn();
      global.fetch = fetched as unknown as typeof fetch;
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: "https://169.254.169.254/latest/meta-data/",
        prompt: "Metadata over https",
      });

      const response = await POST(request);
      const data = await response.json();

      // The destination address itself is what the refusal names, so no request
      // to the metadata service is ever made.
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("169.254.169.254");
      expect(fetched).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("should refuse an HTML response instead of storing it as an image", async () => {
      const html = "<html><body>not an image</body></html>";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      }) as unknown as typeof fetch;
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: "https://cdn.example.com/actually-html.png",
        prompt: "HTML page",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("text/html");
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("should refuse an SVG payload that carries a script", async () => {
      const activeSvg =
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>';

      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        directoryPath: projectDir,
        image: createBase64DataUrl(activeSvg, "image/svg+xml"),
        prompt: "Active svg",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("SVG");
      expect(data.error).toContain("active content");
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("should refuse a request without the local session capability and write nothing", async () => {
      const fetched = vi.fn();
      global.fetch = fetched as unknown as typeof fetch;
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockMkdir.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([]);
      mockWriteFile.mockResolvedValue(undefined);

      const request = localApiRequest(
        {
          json: vi.fn().mockResolvedValue({
            directoryPath: projectDir,
            image: createBase64DataUrl("unauthenticated-content"),
            prompt: "No session",
          }),
        } as unknown as NextRequest,
        { omitSession: true },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Missing local session capability");
      // The guard rejects before the handler reaches the filesystem or the network.
      expect(mockStat).not.toHaveBeenCalled();
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(fetched).not.toHaveBeenCalled();
    });
  });
});

describe("getExtensionFromUrl", () => {
  it("should extract .glb from a CDN URL", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.glb")).toBe("glb");
  });

  it("should extract .obj extension", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.obj")).toBe("obj");
  });

  it("should extract .fbx extension", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.fbx")).toBe("fbx");
  });

  it("should extract .usdz extension", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.usdz")).toBe("usdz");
  });

  it("should extract .stl extension", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.stl")).toBe("stl");
  });

  it("should extract .gltf extension", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.gltf")).toBe("gltf");
  });

  it("should return null for unrecognized extensions", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/file.xyz")).toBeNull();
  });

  it("should return null for URLs without extensions", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model")).toBeNull();
  });

  it("should return null for invalid URLs", () => {
    expect(getExtensionFromUrl("not-a-url")).toBeNull();
  });

  it("should handle query strings correctly", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.glb?token=abc123")).toBe("glb");
  });

  it("should handle fragments correctly", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.glb#section")).toBe("glb");
  });

  it("should return null for URL ending with dot", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.")).toBeNull();
  });

  it("should not recognize zip as a 3D extension", () => {
    expect(getExtensionFromUrl("https://cdn.example.com/model.zip")).toBeNull();
  });
});
