import { NextResponse } from "next/server";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";
import { checkWriteTarget } from "@/lib/security/projectWriteScope.server";
import { registerProjectRoot } from "@/lib/security/projectRoots.server";
import { loadWorkflowDirectory } from "@/lib/workflowDirectory.server";
import { validateWorkflowPath } from "@/utils/pathValidation";

export const maxDuration = 300;

/** Explicit user action, separate from reads and saves: open an existing project for editing. */
export const POST = withPrivilegedApi(["local-file-read", "local-file-write"], async request => {
  let directoryPath: unknown;
  try {
    directoryPath = (await request.json())?.directoryPath;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid project open request" }, { status: 400 });
  }
  if (typeof directoryPath !== "string") {
    return NextResponse.json({ success: false, error: "Project directory path required" }, { status: 400 });
  }
  const validation = validateWorkflowPath(directoryPath);
  if (!validation.valid) {
    return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
  }

  // User intent can add a root, but cannot bypass source/build bans, traversal
  // or junction checks. Ordinary reads and write requests never add roots.
  const scope = checkWriteTarget(directoryPath);
  if (!scope.ok && scope.reason !== "outside-authorized-root") {
    return NextResponse.json({ success: false, error: `Project directory not writable (${scope.reason})` }, { status: 400 });
  }
  const result = await loadWorkflowDirectory(directoryPath);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }
  registerProjectRoot(directoryPath);
  return NextResponse.json(result);
});
