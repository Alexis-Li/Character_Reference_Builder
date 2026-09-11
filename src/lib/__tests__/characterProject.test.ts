import { describe, expect, it } from "vitest";
import {
  addReference,
  approveCandidate,
  createCharacterProject,
  definePart,
  deserializeProject,
  effectiveConstraints,
  markUpstreamChange,
  recordFailedRun,
  recordSuccessfulRun,
  rejectCandidate,
  resolveDownstream,
  selectCandidate,
  selectionKey,
  serializeProject,
  setPartRequirement,
  setProjectLocks,
  type CharacterProject,
} from "../characterProject";

function fixture(): CharacterProject {
  let project = createCharacterProject("char-1", 0);
  project = addReference(project, { id: "ref-front", kind: "original", source: "sha:front", purpose: "Front" });
  project = addReference(project, { id: "ref-back", kind: "original", source: "sha:back", purpose: "Back" });
  project = addReference(project, { id: "ref-fix", kind: "userCorrection", source: "note:belt-width-3cm" });
  project = addReference(project, { id: "ref-style", kind: "auxiliary", source: "note:style-sheet", purpose: "StyleReference" });
  project = setProjectLocks(project, [
    { id: "lock-layers", description: "skirt keeps three layers", sourceReferenceId: "ref-front" },
  ]);
  project = definePart(project, { id: "belt", name: "Belt", requirements: ["width 3cm"], correctionHistory: [] });
  project = definePart(project, { id: "boot", name: "Boot", requirements: [], correctionHistory: [] });
  return project;
}

function runOk(project: CharacterProject, runId: string, candidateId: string, partId = "belt") {
  return recordSuccessfulRun(project, {
    runId,
    partId,
    view: "front",
    outputs: [{ candidateId, referenceIds: ["ref-front"] }],
  });
}

describe("characterProject domain contract", () => {
  it("keeps reference provenance: fact, correction, auxiliary, and inference stay distinct", () => {
    let project = fixture();
    project = addReference(project, { id: "ref-guess", kind: "inferred", source: "run:run-9", purpose: "Back" });
    const kinds = new Map(project.references.map((item) => [item.id, item.kind]));
    expect(kinds.get("ref-front")).toBe("original");
    expect(kinds.get("ref-fix")).toBe("userCorrection");
    expect(kinds.get("ref-style")).toBe("auxiliary");
    expect(kinds.get("ref-guess")).toBe("inferred");
    expect(project.references.find((item) => item.id === "ref-fix")?.source).toBe("note:belt-width-3cm");
  });

  it("successful runs only append unreviewed candidates and never select", () => {
    let project = runOk(fixture(), "run-1", "cand-1");
    expect(project.candidates).toHaveLength(1);
    expect(project.candidates[0].review).toBe("unreviewed");
    expect(project.selection).toEqual({});
    // Empty on purpose: no selection exists, downstream is explicitly null.
    expect(resolveDownstream(project, "belt", "front")).toBeNull();
  });

  it("downstream pins the selected version until the user reselects", () => {
    let project = runOk(fixture(), "run-1", "cand-1");
    project = selectCandidate(project, "belt", "front", "cand-1");
    expect(resolveDownstream(project, "belt", "front")?.id).toBe("cand-1");
    project = recordSuccessfulRun(project, {
      runId: "run-2",
      partId: "belt",
      view: "front",
      inputCandidateId: "cand-1",
      outputs: [{ candidateId: "cand-2", referenceIds: ["ref-front"] }],
    });
    // New candidate exists but downstream still serves the old selection.
    expect(project.candidates.find((item) => item.id === "cand-2")?.review).toBe("unreviewed");
    expect(resolveDownstream(project, "belt", "front")?.id).toBe("cand-1");
    project = selectCandidate(project, "belt", "front", "cand-2");
    expect(resolveDownstream(project, "belt", "front")?.id).toBe("cand-2");
  });

  it("failed runs append no candidates and keep selection and reviews", () => {
    let project = runOk(fixture(), "run-1", "cand-1");
    project = selectCandidate(project, "belt", "front", "cand-1");
    project = recordFailedRun(project, { runId: "run-2", partId: "belt", view: "front", error: "upstream unavailable" });
    expect(project.candidates).toHaveLength(1);
    expect(project.runs).toHaveLength(2);
    expect(project.runs[1].status).toBe("failed");
    expect(project.runs[1].candidateIds).toEqual([]);
    expect(resolveDownstream(project, "belt", "front")?.id).toBe("cand-1");
    expect(project.candidates[0].review).toBe("selected");
  });

  it("branches from one candidate stay linked and both remain available", () => {
    let project = runOk(fixture(), "run-1", "cand-1");
    project = selectCandidate(project, "belt", "front", "cand-1");
    project = recordSuccessfulRun(project, {
      runId: "run-2a",
      partId: "belt",
      view: "front",
      inputCandidateId: "cand-1",
      outputs: [{ candidateId: "cand-2a", referenceIds: ["ref-front"] }],
    });
    project = recordSuccessfulRun(project, {
      runId: "run-2b",
      partId: "belt",
      view: "front",
      inputCandidateId: "cand-1",
      outputs: [{ candidateId: "cand-2b", referenceIds: ["ref-front"] }],
    });
    const branch = project.candidates.filter((item) => item.parentCandidateId === "cand-1");
    expect(branch.map((item) => item.id).sort()).toEqual(["cand-2a", "cand-2b"]);
    expect(resolveDownstream(project, "belt", "front")?.id).toBe("cand-1");
  });

  it("part requirement edits stay isolated and stale only that part", () => {
    let project = runOk(fixture(), "run-1", "cand-1");
    project = runOk(project, "run-2", "cand-boot-1", "boot");
    project = selectCandidate(project, "belt", "front", "cand-1");
    project = selectCandidate(project, "boot", "front", "cand-boot-1");
    project = setPartRequirement(project, "belt", ["width 4cm"], "widen per ref-fix", 7);
    const belt = project.parts.find((item) => item.id === "belt")!;
    const boot = project.parts.find((item) => item.id === "boot")!;
    expect(belt.correctionHistory).toEqual([{ at: 7, note: "widen per ref-fix" }]);
    expect(boot.correctionHistory).toEqual([]);
    expect(boot.requirements).toEqual([]);
    // The edited part goes stale for re-review; the other part is untouched.
    expect(project.candidates.find((item) => item.id === "cand-1")?.review).toBe("stale");
    expect(project.candidates.find((item) => item.id === "cand-boot-1")?.review).toBe("selected");
    // A stale candidate can be re-selected after review instead of re-running.
    project = selectCandidate(project, "belt", "front", "cand-1");
    expect(resolveDownstream(project, "belt", "front")?.id).toBe("cand-1");
  });

  it("upstream changes stale only related results and start no runs", () => {
    let project = runOk(fixture(), "run-1", "cand-1");
    project = selectCandidate(project, "belt", "front", "cand-1");
    project = approveCandidate(project, "cand-1");
    const runsBefore = project.runs.length;
    const { project: next, affected } = markUpstreamChange(project, { referenceIds: ["ref-front"] });
    expect(affected).toEqual(["cand-1"]);
    expect(next.runs).toHaveLength(runsBefore);
    expect(next.candidates[0].review).toBe("stale");
    // A candidate built from an unrelated reference keeps its state.
    let other = runOk(fixture(), "run-1", "cand-1");
    other = recordSuccessfulRun(other, {
      runId: "run-2",
      partId: "boot",
      view: "front",
      outputs: [{ candidateId: "cand-boot-9", referenceIds: ["ref-back"] }],
    });
    const { project: otherNext, affected: otherAffected } = markUpstreamChange(other, {
      referenceIds: ["ref-front"],
    });
    expect(otherAffected).toEqual(["cand-1"]);
    expect(otherNext.candidates.find((item) => item.id === "cand-boot-9")?.review).toBe("unreviewed");
  });

  it("parts inherit project locks without seeing each other's requirements", () => {
    const project = setPartRequirement(fixture(), "belt", ["width 4cm"], "widen", 1);
    expect(effectiveConstraints(project, "belt")).toEqual(["skirt keeps three layers", "width 4cm"]);
    expect(effectiveConstraints(project, "boot")).toEqual(["skirt keeps three layers"]);
  });

  it("selection key is part-scoped: same candidate id can never serve another target", () => {
    const project = runOk(fixture(), "run-1", "cand-1");
    expect(selectionKey("belt", "front")).not.toBe(selectionKey("boot", "front"));
    expect(() => selectCandidate(project, "boot", "front", "cand-1")).toThrow();
    expect(() => selectCandidate(project, "belt", "front", "missing")).toThrow();
    expect(() => rejectCandidate(project, "missing")).toThrow();
  });

  it("close/reopen round-trips relations and stays explicitly empty without results", () => {
    let project = runOk(fixture(), "run-1", "cand-1");
    project = selectCandidate(project, "belt", "front", "cand-1");
    const reopened = deserializeProject(serializeProject(project));
    expect(reopened.selection).toEqual({ "belt@front": "cand-1" });
    expect(resolveDownstream(reopened, "belt", "front")?.id).toBe("cand-1");
    expect(reopened.candidates[0].parentCandidateId).toBeUndefined();
    const empty = deserializeProject(serializeProject(createCharacterProject("empty", 0)));
    expect(empty.selection).toEqual({});
    expect(resolveDownstream(empty, "belt", "front")).toBeNull();
  });
});
