import { NextRequest, NextResponse } from "next/server";
import * as path from "node:path";
import { createReferencePackage, readRecoverableJson, type PersistableWorkflow } from "@/lib/projectFiles.server";
import { joinWorkflowPath, validateWorkflowPath } from "@/utils/pathValidation";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";
import { checkWriteTarget } from "@/lib/security/projectWriteScope.server";
import { redactSecretsInText } from "@/lib/security/secretRedaction";

export const maxDuration = 300;

export const POST = withPrivilegedApi(
  ["local-file-read", "local-file-write"],
  async (request: NextRequest) => {
  try {
    const body = await request.json() as {
      directoryPath?: string;
      filename?: string;
      includeUnreviewed?: boolean;
    };
    if (!body.directoryPath || !body.filename) {
      return NextResponse.json(
        { success: false, error: "Missing project directory or filename." },
        { status: 400 },
      );
    }
    const validation = validateWorkflowPath(body.directoryPath);
    if (!validation.valid) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    // The package is written below `directoryPath` (`exports/<name>/`), so a
    // single write-scope check on the project root also covers the export
    // target: a crafted directoryPath cannot land in src/, public/ or build
    // output.
    const writeScope = checkWriteTarget(body.directoryPath);
    if (!writeScope.ok) {
      return NextResponse.json(
        {
          success: false,
          error:
            writeScope.reason === "outside-authorized-root"
              ? `Write target not authorized (${writeScope.reason}). Choose the project directory with the folder picker, or list it in CRB_PROJECT_ROOTS.`
              : `Write target not authorized (${writeScope.reason})`,
        },
        { status: 400 },
      );
    }
    const safeName = body.filename.replace(/[^a-zA-Z0-9-_]/g, "_");
    const projectFile = joinWorkflowPath(body.directoryPath, `${safeName}.json`);
    const workflow = await readRecoverableJson<PersistableWorkflow>(projectFile);
    const result = await createReferencePackage(body.directoryPath, workflow, {
      includeUnreviewed: body.includeUnreviewed === true,
      packageName: path.basename(body.filename),
    });
    return NextResponse.json({
      success: true,
      packageName: result.packageName,
      exportedCandidateIds: result.exportedCandidateIds,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: redactSecretsInText(
          error instanceof Error ? error.message : "Reference package export failed.",
        ),
      },
      { status: 400 },
    );
  }
});
