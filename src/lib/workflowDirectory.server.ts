import * as fs from "node:fs/promises";
import * as path from "node:path";
import { joinWorkflowPath } from "@/utils/pathValidation";
import { auditProjectAssets, readRecoverableJson, type PersistableWorkflow } from "./projectFiles.server";
import type { ProjectAssetWarning } from "./projectAssets";

type DirectoryLoadResult =
  | { success: true; workflow: PersistableWorkflow; filename: string; assetWarnings: ProjectAssetWarning[] }
  | { success: false; error: string; status: number };

/** Read a validated directory without granting write access or changing files. */
export async function loadWorkflowDirectory(directoryPath: string): Promise<DirectoryLoadResult> {
  try {
    if (!(await fs.stat(directoryPath)).isDirectory()) {
      return { success: false, error: "Path is not a directory", status: 400 };
    }
    const entries = await fs.readdir(directoryPath);
    const jsonFiles = Array.from(new Set(entries
      .filter(file => file.endsWith(".json") || file.endsWith(".json.previous"))
      .map(file => file.replace(/\.previous$/, ""))));
    const candidates: { jsonFile: string; filePath: string; mtime: number }[] = [];
    for (const jsonFile of jsonFiles) {
      const filePath = joinWorkflowPath(directoryPath, jsonFile);
      try {
        const stat = await fs.stat(filePath).catch(() => fs.stat(`${filePath}.previous`));
        candidates.push({ jsonFile, filePath, mtime: stat.mtimeMs });
      } catch {
        // Skip unreadable candidates; a previous valid project may still exist.
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const { jsonFile, filePath } of candidates) {
      try {
        const workflow = await readRecoverableJson<PersistableWorkflow>(filePath);
        if (workflow && typeof workflow.version === "number" &&
          Array.isArray(workflow.nodes) && Array.isArray(workflow.edges)) {
          return { success: true, workflow, filename: path.basename(jsonFile, ".json"),
            assetWarnings: await auditProjectAssets(directoryPath, workflow.assetManifest) };
        }
      } catch {
        // A malformed JSON must not hide another valid workflow in this directory.
      }
    }
    return { success: false, error: "No workflow file found in directory", status: 404 };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { success: false, error: missing ? "Project directory does not exist" : "Failed to read project directory",
      status: missing ? 404 : 400 };
  }
}
