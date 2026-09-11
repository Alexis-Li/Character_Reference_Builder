import { useCallback } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { readSessionMedia } from "@/store/execution/sessionMedia";

/**
 * Returns a loader that fetches a previously-generated asset by candidate ID.
 * Candidate identity is stable; the generations folder may deduplicate bytes
 * onto a shared file, tracked as the candidate's assetId. Session bytes win,
 * then the generations folder, then the saved workflow's media folders.
 *
 * @param resultField preferred key on the response payload (e.g. "image",
 *   "video", "audio"); falls back to `result.image` when absent.
 * @param label capitalized media label used in log messages (e.g. "Image").
 */
export function useLoadGenerationById(resultField: string, label: string) {
  const generationsPath = useWorkflowStore((state) => state.generationsPath);
  const saveDirectoryPath = useWorkflowStore((state) => state.saveDirectoryPath);

  return useCallback(
    async (id: string): Promise<string | null> => {
      // Fresh candidates live here until the generations folder adopts them.
      const sessionHit = readSessionMedia(id);
      if (sessionHit) return sessionHit;
      const project = useWorkflowStore.getState().characterProject;
      const assetId = project?.candidates.find((candidate) => candidate.id === id)?.assetId ?? id;
      if (assetId !== id) {
        const assetSessionHit = readSessionMedia(assetId);
        if (assetSessionHit) return assetSessionHit;
      }

      const loadFromGenerations = async (fileId: string): Promise<string | null> => {
        if (!generationsPath) return null;
        try {
          const response = await fetch("/api/load-generation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              directoryPath: generationsPath,
              imageId: fileId,
            }),
          });

          const result = await response.json();
          if (!result.success) return null;
          return result[resultField] || result.image;
        } catch (error) {
          console.warn(`Error loading ${label.toLowerCase()}:`, error);
          return null;
        }
      };

      const loadFromWorkflowDir = async (fileId: string): Promise<string | null> => {
        const workflowPath = useWorkflowStore.getState().saveDirectoryPath;
        if (!workflowPath) return null;
        try {
          const params = new URLSearchParams({ workflowPath, imageId: fileId, folder: "generations" });
          const response = await fetch(`/api/workflow-images?${params.toString()}`);
          const result = await response.json();
          if (!result.success) return null;
          return result.imageData || result.image || null;
        } catch (error) {
          console.warn(`Error loading ${label.toLowerCase()}:`, error);
          return null;
        }
      };

      const fileIds = assetId !== id ? [assetId, id] : [id];
      for (const fileId of fileIds) {
        const byGenerations = await loadFromGenerations(fileId);
        if (byGenerations) return byGenerations;
        const byWorkflowDir = await loadFromWorkflowDir(fileId);
        if (byWorkflowDir) return byWorkflowDir;
      }
      if (!generationsPath && !useWorkflowStore.getState().saveDirectoryPath) {
        console.error("Generations path not configured");
        return null;
      }
      // Missing assets are expected when refs point to deleted/moved files
      console.log(`${label} not found: ${id}`);
      return null;
    },
    [generationsPath, saveDirectoryPath, resultField, label]
  );
}
