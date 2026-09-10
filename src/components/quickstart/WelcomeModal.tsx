"use client";

import { useState, useCallback } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import { QuickstartView } from "@/types/quickstart";
import { QuickstartInitialView } from "./QuickstartInitialView";
import { WorkflowBrowserView } from "./WorkflowBrowserView";

interface WelcomeModalProps {
  onWorkflowGenerated: (workflow: WorkflowFile, directoryPath?: string) => void;
  onClose: () => void;
  onNewProject: () => void;
}

export function WelcomeModal({
  onWorkflowGenerated,
  onClose,
  onNewProject,
}: WelcomeModalProps) {
  const [currentView, setCurrentView] = useState<QuickstartView>("initial");

  const handleNewProject = useCallback(() => {
    onNewProject();
  }, [onNewProject]);

  const handleSelectLoad = useCallback(() => {
    setCurrentView("browse");
  }, []);

  const handleBack = useCallback(() => {
    setCurrentView("initial");
  }, []);

  const dialogWidth = "max-w-2xl";
  const dialogHeight = currentView === "browse" ? "max-h-[85vh]" : "max-h-[80vh]";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onWheelCapture={(e) => e.stopPropagation()}
      onClick={onClose}
    >
      <div className={`w-full ${dialogWidth} mx-4 bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl overflow-clip ${dialogHeight} flex flex-col`} onClick={(e) => e.stopPropagation()}>
        {currentView === "initial" && (
          <QuickstartInitialView
            onNewProject={handleNewProject}
            onSelectLoad={handleSelectLoad}
          />
        )}
        {currentView === "browse" && (
          <WorkflowBrowserView
            onBack={handleBack}
            onWorkflowLoaded={(workflow, dirPath) =>
              onWorkflowGenerated(workflow, dirPath)
            }
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
