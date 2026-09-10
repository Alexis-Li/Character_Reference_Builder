import * as path from "path";

/**
 * Validates a workflow directory path without confusing path separators with
 * traversal. Windows accepts both native backslashes and forward slashes;
 * POSIX-style absolute paths remain valid for portable callers and fixtures.
 */
export function validateWorkflowPath(inputPath: string): {
  valid: boolean;
  resolved: string;
  error?: string;
} {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    return {
      valid: false,
      resolved: inputPath,
      error: "Path must be absolute",
    };
  }

  const isWindowsDrivePath = /^[A-Za-z]:[\\/]/.test(inputPath);
  const isAbsolute = isWindowsDrivePath
    ? path.win32.isAbsolute(inputPath)
    : path.posix.isAbsolute(inputPath) || path.win32.isAbsolute(inputPath);

  if (!isAbsolute) {
    return {
      valid: false,
      resolved: inputPath,
      error: "Path must be absolute",
    };
  }

  // Reject traversal by segment. Comparing path.resolve() with the original
  // string is not correct on Windows because it changes separators and may
  // apply the current drive to a POSIX-style fixture.
  const segments = inputPath.split(/[\\/]/);
  const resolved = isWindowsDrivePath
    ? path.win32.normalize(inputPath)
    : path.posix.normalize(inputPath);
  if (segments.some((segment) => segment === "..")) {
    return {
      valid: false,
      resolved,
      error: "Path contains traversal sequences",
    };
  }

  const dangerousPrefixes = [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/sys",
    "/proc",
    "/var/run",
    "/System",
    "/Library",
  ];
  const comparable = inputPath
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();

  for (const prefix of dangerousPrefixes) {
    const comparablePrefix = prefix.toLowerCase();
    if (
      comparable === comparablePrefix ||
      comparable.startsWith(comparablePrefix + "/")
    ) {
      return {
        valid: false,
        resolved,
        error: `Access to ${prefix} is not allowed`,
      };
    }
  }

  return {
    valid: true,
    resolved,
  };
}

/** Preserve a portable POSIX-style path while using native joins for drives. */
export function joinWorkflowPath(inputPath: string, ...segments: string[]): string {
  const isPosixStyle = inputPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(inputPath);
  return (isPosixStyle ? path.posix : path).join(inputPath, ...segments);
}
