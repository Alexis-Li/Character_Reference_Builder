"use client";

import { useState, useMemo, useCallback } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useShallow } from "zustand/shallow";
import { ProjectSetupModal } from "./ProjectSetupModal";
import { CostIndicator } from "./CostIndicator";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { WorkflowBrowserModal } from "./WorkflowBrowserModal";

function CommentsNavigationIcon() {
  // Subscribe to nodes so we re-render when comments change
  const nodes = useWorkflowStore((state) => state.nodes);
  const getNodesWithComments = useWorkflowStore((state) => state.getNodesWithComments);
  const viewedCommentNodeIds = useWorkflowStore((state) => state.viewedCommentNodeIds);
  const markCommentViewed = useWorkflowStore((state) => state.markCommentViewed);
  const setNavigationTarget = useWorkflowStore((state) => state.setNavigationTarget);

  // Recalculate when nodes change (nodes in dependency triggers re-render)
  const nodesWithComments = useMemo(() => getNodesWithComments(), [getNodesWithComments, nodes]);
  const unviewedCount = useMemo(() => {
    return nodesWithComments.filter((node) => !viewedCommentNodeIds.has(node.id)).length;
  }, [nodesWithComments, viewedCommentNodeIds]);
  const totalCount = nodesWithComments.length;

  const handleClick = useCallback(() => {
    if (totalCount === 0) return;

    // Find first unviewed comment, or first comment if all viewed
    const targetNode = nodesWithComments.find((node) => !viewedCommentNodeIds.has(node.id)) || nodesWithComments[0];
    if (targetNode) {
      markCommentViewed(targetNode.id);
      setNavigationTarget(targetNode.id);
    }
  }, [totalCount, nodesWithComments, viewedCommentNodeIds, markCommentViewed, setNavigationTarget]);

  // Don't render if no comments
  if (totalCount === 0) {
    return null;
  }

  const displayCount = unviewedCount > 9 ? "9+" : unviewedCount.toString();

  return (
    <button
      onClick={handleClick}
      className="relative p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
      title={`${unviewedCount} unviewed comment${unviewedCount !== 1 ? 's' : ''} (${totalCount} total)`}
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" clipRule="evenodd" />
      </svg>
      {unviewedCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center text-[9px] font-bold text-white bg-blue-500 rounded-full px-0.5">
          {displayCount}
        </span>
      )}
    </button>
  );
}

export function Header() {
  const {
    workflowName,
    workflowId,
    saveDirectoryPath,
    hasUnsavedChanges,
    lastSavedAt,
    isSaving,
    setWorkflowMetadata,
    saveToFile,
    loadWorkflow,
    previousWorkflowSnapshot,
    revertToSnapshot,
    shortcutsDialogOpen,
    setShortcutsDialogOpen,
    setShowQuickstart,
  } = useWorkflowStore(useShallow((state) => ({
    workflowName: state.workflowName,
    workflowId: state.workflowId,
    saveDirectoryPath: state.saveDirectoryPath,
    hasUnsavedChanges: state.hasUnsavedChanges,
    lastSavedAt: state.lastSavedAt,
    isSaving: state.isSaving,
    setWorkflowMetadata: state.setWorkflowMetadata,
    saveToFile: state.saveToFile,
    loadWorkflow: state.loadWorkflow,
    previousWorkflowSnapshot: state.previousWorkflowSnapshot,
    revertToSnapshot: state.revertToSnapshot,
    shortcutsDialogOpen: state.shortcutsDialogOpen,
    setShortcutsDialogOpen: state.setShortcutsDialogOpen,
    setShowQuickstart: state.setShowQuickstart,
  })));

  const [showProjectModal, setShowProjectModal] = useState(false);
  const [projectModalMode, setProjectModalMode] = useState<"new" | "settings">("new");
  const [showWorkflowBrowser, setShowWorkflowBrowser] = useState(false);

  const isProjectConfigured = !!workflowName;
  const canSave = !!(workflowId && workflowName && saveDirectoryPath);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const handleNewProject = () => {
    setProjectModalMode("new");
    setShowProjectModal(true);
  };

  const handleOpenSettings = () => {
    setProjectModalMode("settings");
    setShowProjectModal(true);
  };

  const handleOpenFile = () => {
    setShowWorkflowBrowser(true);
  };

  const handleProjectSave = async (id: string, name: string, path: string) => {
    setWorkflowMetadata(id, name, path); // generationsPath is auto-derived
    setShowProjectModal(false);
    // Small delay to let state update
    setTimeout(() => {
      saveToFile().catch((error) => {
        console.error("Failed to save project:", error);
        alert("Failed to save project. Please try again.");
      });
    }, 50);
  };

  const handleOpenDirectory = async () => {
    if (!saveDirectoryPath) return;

    try {
      const response = await fetch("/api/open-directory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: saveDirectoryPath }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        console.error("Failed to open directory:", result.error);
        alert(`Failed to open project folder: ${result.error || "Unknown error"}`);
        return;
      }
    } catch (error) {
      console.error("Failed to open directory:", error);
      alert("Failed to open project folder. Please try again.");
    }
  };


  const handleRevertAIChanges = useCallback(() => {
    const confirmed = window.confirm(
      "Are you sure? This will restore your previous workflow."
    );
    if (confirmed) {
      revertToSnapshot();
    }
  }, [revertToSnapshot]);

  const settingsButtons = (
    <div className="flex items-center gap-0.5 ml-1 pl-1 border-l border-neutral-700/50">
      <button
        onClick={handleOpenSettings}
        className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
        title="Project settings"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </button>
    </div>
  );

  return (
    <>
      <ProjectSetupModal
        isOpen={showProjectModal}
        onClose={() => setShowProjectModal(false)}
        onSave={handleProjectSave}
        mode={projectModalMode}
      />
      <WorkflowBrowserModal
        isOpen={showWorkflowBrowser}
        onClose={() => setShowWorkflowBrowser(false)}
        onWorkflowLoaded={async (workflow, dirPath) => {
          setShowWorkflowBrowser(false);
          await loadWorkflow(workflow, dirPath);
        }}
      />
      <header className="h-11 bg-neutral-900 border-b border-neutral-800 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowQuickstart(true)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            title="Open welcome screen"
          >
            <img src="/banana_icon.png" alt="Banana" className="w-6 h-6" />
            <h1 className="text-2xl font-semibold text-neutral-100 tracking-tight">
              Node Banana
            </h1>
          </button>

          <div className="flex items-center gap-2 ml-4 pl-4 border-l border-neutral-700">
            {isProjectConfigured ? (
              <>
                <span className="text-sm text-neutral-300">{workflowName}</span>
                <span className="text-neutral-600">|</span>
                <CostIndicator />

                {/* File operations group */}
                <div className="flex items-center gap-0.5 ml-2 pl-2 border-l border-neutral-700/50">
                  <button
                    onClick={() => canSave ? saveToFile() : handleOpenSettings()}
                    disabled={isSaving}
                    className="relative p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors disabled:opacity-50"
                    title={isSaving ? "Saving..." : canSave ? "Save project" : "Configure save location"}
                    data-tutorial="save-button"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                      />
                    </svg>
                    {hasUnsavedChanges && !isSaving && (
                      <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-neutral-900" />
                    )}
                  </button>
                  {saveDirectoryPath && (
                    <button
                      onClick={handleOpenDirectory}
                      className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                      title="Open Project Folder"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                        />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={handleOpenFile}
                    className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                    title="Open project"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                      />
                    </svg>
                  </button>
                </div>

                {settingsButtons}
              </>
            ) : (
              <>
                <span className="text-sm text-neutral-500 italic">Untitled</span>

                {/* File operations group */}
                <div className="flex items-center gap-0.5 ml-2 pl-2 border-l border-neutral-700/50">
                  <button
                    onClick={handleNewProject}
                    className="relative p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                    title="Save project"
                    data-tutorial="save-button"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                      />
                    </svg>
                    <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-neutral-900" />
                  </button>
                  <button
                    onClick={handleOpenFile}
                    className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                    title="Open project"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                      />
                    </svg>
                  </button>
                </div>

                {settingsButtons}
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs">
          {previousWorkflowSnapshot && (
            <button
              onClick={handleRevertAIChanges}
              className="px-2.5 py-1.5 text-xs text-neutral-300 hover:text-neutral-100 bg-neutral-700/50 hover:bg-neutral-700 border border-neutral-600 rounded transition-colors"
              title="Restore workflow from before AI changes"
            >
              Revert AI Changes
            </button>
          )}
          <CommentsNavigationIcon />
          <span className="text-neutral-400">
            {isProjectConfigured ? (
              isSaving ? (
                "Saving..."
              ) : lastSavedAt ? (
                `Saved ${formatTime(lastSavedAt)}`
              ) : (
                "Not saved"
              )
            ) : (
              "Not saved"
            )}
          </span>
          <span className="text-neutral-500">·</span>
          <a
            href="https://x.com/ReflctWillie"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            Made by Willie
          </a>
          <span className="text-neutral-500">·</span>
          <button
            onClick={() => setShortcutsDialogOpen(true)}
            className="text-neutral-400 hover:text-neutral-200 transition-colors"
            title="Keyboard shortcuts (?)"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75A2.25 2.25 0 014.5 4.5h15a2.25 2.25 0 012.25 2.25v10.5A2.25 2.25 0 0119.5 19.5h-15a2.25 2.25 0 01-2.25-2.25V6.75z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
            </svg>
          </button>
        </div>
      </header>
      <KeyboardShortcutsDialog
        isOpen={shortcutsDialogOpen}
        onClose={() => setShortcutsDialogOpen(false)}
      />
    </>
  );
}
