import { describe, expect, it } from "vitest";
import { validateWorkflowPath } from "@/utils/pathValidation";

describe("validateWorkflowPath", () => {
  it("accepts native Windows absolute paths", () => {
    expect(validateWorkflowPath("E:\\Characters\\Knight").valid).toBe(true);
    expect(validateWorkflowPath("E:/Characters/Knight").valid).toBe(true);
  });

  it("accepts portable POSIX-style absolute paths", () => {
    expect(validateWorkflowPath("/test/dir").valid).toBe(true);
  });

  it("rejects traversal in either separator style", () => {
    expect(validateWorkflowPath("E:\\Characters\\..\\outside")).toMatchObject({
      valid: false,
      error: "Path contains traversal sequences",
    });
    expect(validateWorkflowPath("E:/Characters/../outside")).toMatchObject({
      valid: false,
      error: "Path contains traversal sequences",
    });
  });
});
