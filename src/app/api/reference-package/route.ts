import { NextRequest, NextResponse } from "next/server";
import * as path from "node:path";
import { createReferencePackage, readRecoverableJson, type PersistableWorkflow } from "@/lib/projectFiles.server";
import { joinWorkflowPath, validateWorkflowPath } from "@/utils/pathValidation";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
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
      { success: false, error: error instanceof Error ? error.message : "Reference package export failed." },
      { status: 400 },
    );
  }
}
