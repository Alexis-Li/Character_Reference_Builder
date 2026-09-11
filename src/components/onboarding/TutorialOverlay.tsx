"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useFTUXStore } from "@/store/ftuxStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { ElementHighlight } from "./ElementHighlight";
import { TutorialMessage } from "./TutorialMessage";
import { getTutorialSampleContent } from "@/utils/tutorialDefaults";

/**
 * Main tutorial coordination component.
 * Manages tutorial progression, action detection, and UI rendering.
 */
export function TutorialOverlay() {
  const [mounted, setMounted] = useState(false);
  const [showHighlight, setShowHighlight] = useState(false);
  const nodesPopulated = useRef(false);
  const demonstrateNodesAdded = useRef(false);
  const demonstrateTimeoutIds = useRef<ReturnType<typeof setTimeout>[]>([]);
  const advanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const populateTimeoutIds = useRef<ReturnType<typeof setTimeout>[]>([]);

  const tutorialActive = useFTUXStore((state) => state.tutorialActive);
  const currentTutorialStep = useFTUXStore((state) => state.currentTutorialStep);
  const tutorialSteps = useFTUXStore((state) => state.tutorialSteps);
  const completeCurrentStep = useFTUXStore((state) => state.completeCurrentStep);
  const nextTutorialStep = useFTUXStore((state) => state.nextTutorialStep);
  const skipTutorial = useFTUXStore((state) => state.skipTutorial);
  const connectionMenuShown = useFTUXStore((state) => state.connectionMenuShown);
  const nanoBananaAddedFromMenu = useFTUXStore((state) => state.nanoBananaAddedFromMenu);
  const tutorialSampleImage = useFTUXStore((state) => state.tutorialSampleImage);

  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  // Ensure portal rendering only happens client-side
  useEffect(() => {
    setMounted(true);
  }, []);

  // Action detection: monitor workflow state for required actions
  useEffect(() => {
    if (!tutorialActive || currentTutorialStep >= tutorialSteps.length) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];
    if (currentStep.completed) {
      return;
    }

    // Steps with waitForClick require manual progression
    if (currentStep.waitForClick) {
      return;
    }

    // Steps without requiredAction auto-advance after 3 seconds
    if (!currentStep.requiredAction) {
      const timer = setTimeout(() => {
        completeCurrentStep();
        nextTutorialStep();
      }, 3000);
      return () => clearTimeout(timer);
    }

    let actionCompleted = false;

    // Detect specific actions based on requiredAction type
    switch (currentStep.requiredAction) {
      case "add-image-node":
        actionCompleted = nodes.some((node) => node.type === "imageInput");
        break;

      case "add-output-node":
        actionCompleted = nodes.some((node) => node.type === "output");
        break;

      case "connect-nodes":
        // Check if any edges exist
        actionCompleted = edges.length > 0;
        break;

      case "run-workflow":
        // Check if any node has been executed (has output)
        actionCompleted = nodes.some((node) => {
          const data = node.data as Record<string, unknown>;
          return data.outputImage || data.outputText || data.outputAudio;
        });
        break;

      case "show-connection-menu":
        actionCompleted = connectionMenuShown;
        break;

      case "add-nanoBanana-from-menu":
        actionCompleted = nanoBananaAddedFromMenu;
        break;

      case "add-prompt-node":
        actionCompleted = nodes.some((node) => node.type === "prompt");
        break;

      case "connect-prompt-node":
        // Check if any edge has a prompt node as source
        actionCompleted = edges.some((edge) => {
          const sourceNode = nodes.find((n) => n.id === edge.source);
          return sourceNode?.type === "prompt";
        });
        break;
    }

    if (actionCompleted) {
      // Advance to next step after configurable delay (default 1000ms).
      // Both completeCurrentStep() and nextTutorialStep() are called inside
      // the timeout so that the state update doesn't trigger a re-render
      // whose cleanup would clear the pending timeout.
      const delay = currentStep.advanceDelay !== undefined ? currentStep.advanceDelay : 1000;
      if (advanceTimeoutRef.current) clearTimeout(advanceTimeoutRef.current);
      advanceTimeoutRef.current = setTimeout(() => {
        advanceTimeoutRef.current = null;
        completeCurrentStep();
        nextTutorialStep();
      }, delay);
    }

    return () => {
      if (advanceTimeoutRef.current) {
        clearTimeout(advanceTimeoutRef.current);
        advanceTimeoutRef.current = null;
      }
    };
  }, [
    tutorialActive,
    currentTutorialStep,
    tutorialSteps,
    nodes,
    edges,
    connectionMenuShown,
    nanoBananaAddedFromMenu,
    completeCurrentStep,
    nextTutorialStep,
  ]);

  // Handle highlight delay
  useEffect(() => {
    if (!tutorialActive || currentTutorialStep >= tutorialSteps.length) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];

    if (currentStep.highlightSelector && currentStep.highlightDelay) {
      // Start with highlight hidden
      setShowHighlight(false);
      // Show highlight after delay
      const timer = setTimeout(() => {
        setShowHighlight(true);
      }, currentStep.highlightDelay);
      return () => clearTimeout(timer);
    } else {
      // No delay, show highlight immediately
      setShowHighlight(true);
    }
  }, [tutorialActive, currentTutorialStep, tutorialSteps]);

  // Reset populate ref when tutorial ends
  useEffect(() => {
    if (!tutorialActive) {
      nodesPopulated.current = false;
    }
  }, [tutorialActive]);

  // Auto-populate nodes during the populate-content step.
  // Reads nodes from the store directly (via getState) to avoid depending on
  // `nodes` — which would retrigger the effect and clear the advance timer
  // when updateNodeData mutates node data.
  useEffect(() => {
    if (!tutorialActive || nodesPopulated.current) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];

    // Check if we're on the "populate-content" step
    if (currentStep?.id === "populate-content" && !currentStep.completed) {
      nodesPopulated.current = true;
      const timeoutIds = populateTimeoutIds.current;
      timeoutIds.length = 0;

      // Wait a bit before populating to show the message first
      timeoutIds.push(setTimeout(() => {
        // Read nodes from the store directly to avoid dependency on `nodes`
        const currentNodes = useWorkflowStore.getState().nodes;
        const imageInputNode = currentNodes.find((node) => node.type === "imageInput");
        const promptNode = currentNodes.find((node) => node.type === "prompt");

        // Populate with sample content
        if (imageInputNode) {
          const imageContent = getTutorialSampleContent("imageInput", tutorialSampleImage);
          if (imageContent) {
            updateNodeData(imageInputNode.id, imageContent);
          }
        }

        if (promptNode) {
          const promptContent = getTutorialSampleContent("prompt", tutorialSampleImage);
          if (promptContent) {
            updateNodeData(promptNode.id, promptContent);
          }
        }

        // Auto-advance after populating
        timeoutIds.push(setTimeout(() => {
          completeCurrentStep();
          nextTutorialStep();
        }, 1500));
      }, 1000));

      return () => {
        timeoutIds.forEach(clearTimeout);
        timeoutIds.length = 0;
      };
    }
  }, [tutorialActive, currentTutorialStep, tutorialSteps, tutorialSampleImage, updateNodeData, completeCurrentStep, nextTutorialStep]);

  // Reset demonstrate ref when tutorial ends
  useEffect(() => {
    if (!tutorialActive) {
      demonstrateNodesAdded.current = false;
    }
  }, [tutorialActive]);

  // Auto-add downstream demonstration nodes (minimum image reference loop only)
  useEffect(() => {
    if (!tutorialActive || demonstrateNodesAdded.current) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];

    if (currentStep?.id === "demonstrate-downstream" && !currentStep.completed) {
      demonstrateNodesAdded.current = true;
      const storeState = useWorkflowStore.getState();
      const addNode = storeState.addNode;
      const onConnect = storeState.onConnect;
      const updateNodeData = storeState.updateNodeData;

      // Track all timeouts so cleanup can clear them if tutorial is skipped
      const timeoutIds = demonstrateTimeoutIds.current;
      timeoutIds.length = 0;
      const schedule = (fn: () => void, ms: number) => {
        timeoutIds.push(setTimeout(fn, ms));
      };

      // Initial delay to show message
      schedule(() => {
        // Read nodes from the store directly to avoid dependency on `nodes`
        const currentNodes = useWorkflowStore.getState().nodes;
        // Find the Generate Image node
        const generateNode = currentNodes.find((n) => n.type === "nanoBanana");
        if (!generateNode) return;

        const baseX = generateNode.position.x;
        const baseY = generateNode.position.y;

        // VARIATION BRANCH (top): second prompt -> second image -> output.
        // Uses the first generation as a visual reference for an image variation.
        const variationPromptId = addNode("prompt", {
          x: baseX + 400,
          y: baseY - 350,
        });

        schedule(() => {
          const variationImageId = addNode("nanoBanana", {
            x: baseX + 750,
            y: baseY - 350,
          });

          schedule(() => {
            // Connect Prompt -> Generate Image #2 (text)
            onConnect({
              source: variationPromptId,
              target: variationImageId,
              sourceHandle: "text",
              targetHandle: "text",
            });

            schedule(() => {
              // Connect original image as reference
              onConnect({
                source: generateNode.id,
                target: variationImageId,
                sourceHandle: "image",
                targetHandle: "image",
              });

              schedule(() => {
                // Populate variation prompt
                updateNodeData(variationPromptId, {
                  prompt: "Same bird, resting on a mossy branch at dawn",
                });

                schedule(() => {
                  const variationOutputId = addNode("output", {
                    x: baseX + 1100,
                    y: baseY - 350,
                  });

                  schedule(() => {
                    // Connect Generate Image #2 -> Output
                    onConnect({
                      source: variationImageId,
                      target: variationOutputId,
                      sourceHandle: "image",
                      targetHandle: "image",
                    });

                    // COMPARE/GALLERY BRANCH (bottom): compare both images, collect in gallery.
                    schedule(() => {
                      const compareId = addNode("imageCompare", {
                        x: baseX + 400,
                        y: baseY + 350,
                      });

                      schedule(() => {
                        // Connect original -> Compare (image)
                        onConnect({
                          source: generateNode.id,
                          target: compareId,
                          sourceHandle: "image",
                          targetHandle: "image",
                        });

                        schedule(() => {
                          // Connect variation -> Compare (image-1)
                          onConnect({
                            source: variationImageId,
                            target: compareId,
                            sourceHandle: "image",
                            targetHandle: "image-1",
                          });

                          schedule(() => {
                            const galleryId = addNode("outputGallery", {
                              x: baseX + 750,
                              y: baseY + 350,
                            });

                            schedule(() => {
                              // Collect original in gallery
                              onConnect({
                                source: generateNode.id,
                                target: galleryId,
                                sourceHandle: "image",
                                targetHandle: "image",
                              });

                              schedule(() => {
                                // Collect variation in gallery
                                onConnect({
                                  source: variationImageId,
                                  target: galleryId,
                                  sourceHandle: "image",
                                  targetHandle: "image",
                                });

                                // Final delay before advancing
                                schedule(() => {
                                  completeCurrentStep();
                                  nextTutorialStep();
                                }, 1000);
                              }, 400);
                            }, 400);
                          }, 400);
                        }, 400);
                      }, 400);
                    }, 600);
                  }, 400);
                }, 600);
              }, 500);
            }, 400);
          }, 400);
        }, 400);
      }, 1000);

      return () => {
        timeoutIds.forEach(clearTimeout);
        timeoutIds.length = 0;
      };
    }
  }, [tutorialActive, currentTutorialStep, tutorialSteps, completeCurrentStep, nextTutorialStep]);

  // Don't render during SSR or when tutorial is inactive
  if (!mounted || !tutorialActive || currentTutorialStep >= tutorialSteps.length) {
    return null;
  }

  const currentStep = tutorialSteps[currentTutorialStep];

  const handleContinue = () => {
    completeCurrentStep();
    nextTutorialStep();
  };

  return createPortal(
    <>
      {/* Click-to-continue overlay (when waitForClick is true) */}
      {currentStep.waitForClick && (
        <div
          role="button"
          tabIndex={0}
          onClick={handleContinue}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleContinue();
            }
          }}
          aria-label="Click to continue tutorial"
          className="fixed inset-0 cursor-pointer"
          style={{ zIndex: 92 }}
        />
      )}

      {/* Element highlight (if specified and delay has passed) */}
      {currentStep.highlightSelector && showHighlight && (
        <ElementHighlight selector={currentStep.highlightSelector} />
      )}

      {/* Tutorial message - hide if current step is completed */}
      {!currentStep.completed && (
        <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 93 }}>
          <TutorialMessage
            message={currentStep.message}
            position={currentStep.position}
            waitForClick={currentStep.waitForClick}
            links={currentStep.links}
          />
        </div>
      )}

      {/* Skip tutorial button */}
      <button
        onClick={skipTutorial}
        className="fixed top-20 right-4 px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors pointer-events-auto"
        style={{ zIndex: 94 }}
      >
        Skip tutorial
      </button>
    </>,
    document.body
  );
}
