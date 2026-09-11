/**
 * Character Project domain contract (CRB-02).
 *
 * Minimal asset/version graph for a single character's reference production:
 * design references keep their provenance, runs only append candidates, and
 * the user's explicit selection is a stable version reference that downstream
 * keeps using until the user selects a newer one.
 *
 * Pure data + pure functions. No framework, no I/O, no provider knowledge.
 * File persistence and export belong to CRB-06; this module only guarantees
 * the in-memory relations plus a lossless serialize/deserialize round-trip.
 */

/** Provenance of one design input. AI output never becomes "original". */
export type ReferenceKind =
  | "original"
  | "userCorrection"
  | "auxiliary"
  | "inferred"
  | "confirmedInference";

export interface DesignReference {
  id: string;
  kind: ReferenceKind;
  /** Where it came from: file hash, upstream run, or a human note. Never empty. */
  source: string;
  label?: string;
  /** Front | Side | Back | Detail | StyleReference … */
  purpose?: string;
}

export interface DesignConstraint {
  id: string;
  description: string;
  sourceReferenceId?: string;
}

export interface PartCorrectionEntry {
  at: number;
  note: string;
}

export interface Part {
  id: string;
  name: string;
  parentId?: string;
  /** Part-local effective requirements; project locks are inherited, not copied. */
  requirements: string[];
  /** Per-part correction history. Never shared across parts. */
  correctionHistory: PartCorrectionEntry[];
}

export type CandidateReviewState =
  | "unreviewed"
  | "selected"
  | "approved"
  | "rejected"
  | "stale";

export interface Candidate {
  id: string;
  partId: string;
  view: string;
  runId: string;
  /** Optimization chain: refine/branch always points at its input version. */
  parentCandidateId?: string;
  referenceIds: string[];
  inferenceNotes?: string;
  review: CandidateReviewState;
}

export type RunStatus = "success" | "failed";

export interface ProjectRun {
  id: string;
  partId: string;
  view: string;
  inputCandidateId?: string;
  status: RunStatus;
  /** Candidate ids appended by this run. Failed runs append none. */
  candidateIds: string[];
  error?: string;
}

export interface CharacterProject {
  id: string;
  references: DesignReference[];
  projectLocks: DesignConstraint[];
  parts: Part[];
  candidates: Candidate[];
  runs: ProjectRun[];
  /** selectionKey `${partId}@${view}` -> candidate id. Absent = explicitly empty. */
  selection: Record<string, string>;
  updatedAt: number;
}

export function selectionKey(partId: string, view: string): string {
  return `${partId}@${view}`;
}

export function createCharacterProject(id: string, updatedAt: number = Date.now()): CharacterProject {
  return {
    id,
    references: [],
    projectLocks: [],
    parts: [],
    candidates: [],
    runs: [],
    selection: {},
    updatedAt,
  };
}

function touch<T extends CharacterProject>(project: T, updatedAt: number = Date.now()): T {
  return { ...project, updatedAt };
}

export function addReference(
  project: CharacterProject,
  reference: DesignReference,
): CharacterProject {
  if (!reference.id || !reference.source) {
    throw new Error("Reference needs an id and a source.");
  }
  if (project.references.some((item) => item.id === reference.id)) {
    throw new Error(`Reference ${reference.id} already exists.`);
  }
  return touch({ ...project, references: [...project.references, reference] });
}

export function definePart(project: CharacterProject, part: Part): CharacterProject {
  if (project.parts.some((item) => item.id === part.id)) {
    throw new Error(`Part ${part.id} already exists.`);
  }
  return touch({
    ...project,
    parts: [...project.parts, { ...part, requirements: [...part.requirements], correctionHistory: [...part.correctionHistory] }],
  });
}

export function setProjectLocks(
  project: CharacterProject,
  locks: DesignConstraint[],
): CharacterProject {
  return touch({ ...project, projectLocks: [...locks] });
}

/**
 * Update one part's requirements and record the correction locally.
 * Other parts keep their own requirements and history untouched.
 * The part's active (selected/approved) candidates go stale so a human
 * re-reviews them; nothing is re-run automatically.
 */
export function setPartRequirement(
  project: CharacterProject,
  partId: string,
  requirements: string[],
  correctionNote: string,
  at: number = Date.now(),
): CharacterProject {
  const key = (candidate: Candidate): string => selectionKey(candidate.partId, candidate.view);
  let next = touch({
    ...project,
    parts: project.parts.map((part) =>
      part.id === partId
        ? {
            ...part,
            requirements: [...requirements],
            correctionHistory: [...part.correctionHistory, { at, note: correctionNote }],
          }
        : part,
    ),
  });
  const selectedIds = new Set(
    Object.entries(next.selection)
      .filter(([selection, candidateId]) => {
        const candidate = next.candidates.find((item) => item.id === candidateId);
        return candidate?.partId === partId && selection === key(candidate);
      })
      .map(([, candidateId]) => candidateId),
  );
  next = {
    ...next,
    candidates: next.candidates.map((candidate) =>
      candidate.partId === partId &&
      (candidate.review === "selected" ||
        candidate.review === "approved" ||
        selectedIds.has(candidate.id))
        ? { ...candidate, review: "stale" as CandidateReviewState }
        : candidate,
    ),
  };
  return next;
}

/** Project locks plus the part's own requirements. Parts never see each other's. */
export function effectiveConstraints(project: CharacterProject, partId: string): string[] {
  const part = project.parts.find((item) => item.id === partId);
  if (!part) throw new Error(`Unknown part ${partId}.`);
  return [
    ...project.projectLocks.map((lock) => lock.description),
    ...part.requirements,
  ];
}

export interface SuccessfulRunInput {
  runId: string;
  partId: string;
  view: string;
  inputCandidateId?: string;
  /** One entry per produced image; each becomes an independent candidate. */
  outputs: Array<{ candidateId: string; referenceIds: string[]; inferenceNotes?: string }>;
}

/**
 * Append-only success: new candidates are born "unreviewed" and the current
 * selection is never touched, even when the run refines the selected version.
 */
export function recordSuccessfulRun(
  project: CharacterProject,
  input: SuccessfulRunInput,
): CharacterProject {
  if (project.runs.some((run) => run.id === input.runId)) {
    throw new Error(`Run ${input.runId} already recorded.`);
  }
  for (const output of input.outputs) {
    if (project.candidates.some((candidate) => candidate.id === output.candidateId)) {
      throw new Error(`Candidate ${output.candidateId} already exists.`);
    }
  }
  const candidates: Candidate[] = input.outputs.map((output) => ({
    id: output.candidateId,
    partId: input.partId,
    view: input.view,
    runId: input.runId,
    parentCandidateId: input.inputCandidateId,
    referenceIds: [...output.referenceIds],
    inferenceNotes: output.inferenceNotes,
    review: "unreviewed",
  }));
  const run: ProjectRun = {
    id: input.runId,
    partId: input.partId,
    view: input.view,
    inputCandidateId: input.inputCandidateId,
    status: "success",
    candidateIds: candidates.map((candidate) => candidate.id),
  };
  return touch({
    ...project,
    candidates: [...project.candidates, ...candidates],
    runs: [...project.runs, run],
  });
}

/** Failed runs leave candidates and selection exactly as they were. */
export function recordFailedRun(
  project: CharacterProject,
  input: { runId: string; partId: string; view: string; inputCandidateId?: string; error: string },
): CharacterProject {
  if (project.runs.some((run) => run.id === input.runId)) {
    throw new Error(`Run ${input.runId} already recorded.`);
  }
  const run: ProjectRun = {
    id: input.runId,
    partId: input.partId,
    view: input.view,
    inputCandidateId: input.inputCandidateId,
    status: "failed",
    candidateIds: [],
    error: input.error,
  };
  return touch({ ...project, runs: [...project.runs, run] });
}

/** Explicit human choice. The only writer of the selection map. */
export function selectCandidate(
  project: CharacterProject,
  partId: string,
  view: string,
  candidateId: string,
): CharacterProject {
  const candidate = project.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Unknown candidate ${candidateId}.`);
  if (candidate.partId !== partId || candidate.view !== view) {
    throw new Error(`Candidate ${candidateId} does not belong to ${partId}@${view}.`);
  }
  const key = selectionKey(partId, view);
  const previousId = project.selection[key];
  return touch({
    ...project,
    candidates: project.candidates.map((item) => {
      if (item.id === candidateId) return { ...item, review: "selected" };
      if (item.id === previousId && item.review === "selected") return { ...item, review: "unreviewed" };
      return item;
    }),
    selection: { ...project.selection, [key]: candidateId },
  });
}

/**
 * What downstream uses: the pinned selection, or null when the user has not
 * chosen anything. Never falls back to "latest candidate".
 */
export function resolveDownstream(
  project: CharacterProject,
  partId: string,
  view: string,
): Candidate | null {
  const candidateId = project.selection[selectionKey(partId, view)];
  if (!candidateId) return null;
  return project.candidates.find((item) => item.id === candidateId) ?? null;
}

export function approveCandidate(project: CharacterProject, candidateId: string): CharacterProject {
  if (!project.candidates.some((item) => item.id === candidateId)) {
    throw new Error(`Unknown candidate ${candidateId}.`);
  }
  return touch({
    ...project,
    candidates: project.candidates.map((item) =>
      item.id === candidateId ? { ...item, review: "approved" } : item,
    ),
  });
}

export function rejectCandidate(
  project: CharacterProject,
  candidateId: string,
  note?: string,
): CharacterProject {
  if (!project.candidates.some((item) => item.id === candidateId)) {
    throw new Error(`Unknown candidate ${candidateId}.`);
  }
  return touch({
    ...project,
    candidates: project.candidates.map((item) =>
      item.id === candidateId
        ? { ...item, review: "rejected", inferenceNotes: note ?? item.inferenceNotes }
        : item,
    ),
  });
}

export interface UpstreamChange {
  /** Changed design references or locks: only candidates using them go stale. */
  referenceIds?: string[];
  lockIds?: string[];
  /** Narrow to parts; omit to match every part that uses the changed inputs. */
  partIds?: string[];
  note?: string;
}

/**
 * Upstream edits mark related candidates stale for human re-review.
 * Unrelated candidates keep their review state; no run is started here.
 */
export function markUpstreamChange(
  project: CharacterProject,
  change: UpstreamChange,
): { project: CharacterProject; affected: string[] } {
  const references = new Set(change.referenceIds ?? []);
  const locks = new Set(change.lockIds ?? []);
  const parts = change.partIds ? new Set(change.partIds) : null;
  const lockHit = locks.size > 0 && project.projectLocks.some((lock) => locks.has(lock.id));
  const affected: string[] = [];
  const candidates = project.candidates.map((candidate) => {
    const inScope = !parts || parts.has(candidate.partId);
    const usesReference = candidate.referenceIds.some((id) => references.has(id));
    const related = inScope && (usesReference || lockHit);
    if (related && (candidate.review === "selected" || candidate.review === "approved" || candidate.review === "unreviewed")) {
      affected.push(candidate.id);
      return {
        ...candidate,
        review: "stale" as CandidateReviewState,
        inferenceNotes: change.note ?? candidate.inferenceNotes,
      };
    }
    return candidate;
  });
  return { project: touch({ ...project, candidates }), affected };
}

export function serializeProject(project: CharacterProject): string {
  return JSON.stringify(project);
}

export function deserializeProject(raw: string): CharacterProject {
  const parsed = JSON.parse(raw) as CharacterProject;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.candidates)) {
    throw new Error("Not a character project payload.");
  }
  return {
    id: parsed.id,
    references: parsed.references ?? [],
    projectLocks: parsed.projectLocks ?? [],
    parts: (parsed.parts ?? []).map((part) => ({
      ...part,
      requirements: [...(part.requirements ?? [])],
      correctionHistory: [...(part.correctionHistory ?? [])],
    })),
    candidates: parsed.candidates.map((candidate) => ({ ...candidate })),
    runs: (parsed.runs ?? []).map((run) => ({ ...run, candidateIds: [...(run.candidateIds ?? [])] })),
    selection: { ...(parsed.selection ?? {}) },
    updatedAt: parsed.updatedAt ?? 0,
  };
}
