/**
 * The classic ComfyUI HTTP surface: `POST /api/prompt`, poll `/api/history`,
 * fetch results from `/api/view`.
 *
 * Every ComfyUI serves this, with or without the `/api` prefix (the server
 * registers both), which makes it the only option for a stock local install.
 * Comfy Cloud serves it too — authenticated with `X-API-Key` — and adds a
 * cheaper `/api/job/{id}/status` poll plus a job record at `/api/jobs/{id}`,
 * both of which this engine prefers when talking to the cloud.
 *
 * Every request goes through {@link engineRequest}, so the connection's
 * credential rides only to its bound destination, every hop is checked against
 * the connection's address policy, and a redirect to any other host fails the
 * call rather than forwarding the key. The one exception is an output download
 * from an HTTPS engine, where the engine's own 302 to a signed storage URL is
 * how the bytes arrive; there the media seam follows the chain with the
 * credential scoped to the engine's origin — see
 * {@link LegacyComfyEngine.downloadOutput}.
 */

import { ACCEPTED_ASSET_MEDIA_TYPES } from "@/lib/security/activeContent";
import { downloadSafeMedia } from "@/lib/security/safeMedia.server";

import { mediaTypeForFilename, mimeForFilename } from "../graph";
import type { ComfyConnection, ComfyGraph, ComfyObjectInfo, ComfyRawOutputs } from "../types";
import { createMediaFetch, engineRequest, providerConnectionFor } from "./connection";
import {
  ComfyEngineError,
  type ComfyEngine,
  type ComfyJobState,
  type ComfyOutputAsset,
  type ComfySubmitOptions,
  type ComfyUploadInput,
} from "./engine";
import { CATALOG_RETRIES, CATALOG_TIMEOUT_MS } from "./fetch";

/**
 * Media types an engine output may declare. Wider than
 * {@link ACCEPTED_ASSET_MEDIA_TYPES} by the 3D and audio containers the engine
 * writes (`usdz`, `obj`, `stl`, `ply`, `m4a`, `opus`), so a file the engine
 * really produced is not refused by a download guard that never saw it.
 */
const OUTPUT_MEDIA_TYPES: readonly string[] = [
  ...ACCEPTED_ASSET_MEDIA_TYPES,
  "model/vnd.usdz+zip",
  "model/obj",
  "model/stl",
  "model/ply",
  "audio/mp4",
  "audio/opus",
];

/** Extensions accepted for outputs a CDN serves as an opaque binary. */
const OUTPUT_OPAQUE_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "mkv",
  "avi",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "opus",
  "m4a",
  "glb",
  "gltf",
  "usdz",
  "obj",
  "stl",
  "ply",
  "splat",
  "spz",
];

/** Hard cap on one downloaded output (500 MB), as `/api/save-generation` uses. */
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

/** A file reference in a `/history` or `/api/jobs` outputs object. */
interface RawFileRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

function isFileRef(value: unknown): value is RawFileRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { filename?: unknown }).filename === "string"
  );
}

/**
 * Every file a run produced, across all output nodes and media kinds.
 *
 * Scans every array-valued field rather than just `images`/`videos`/`gifs`, so
 * packs that report their results under a bespoke key (3D savers, for example)
 * are picked up too. Files written by output nodes are preferred over
 * temp/preview copies when both exist for the same run.
 */
export function collectOutputFiles(
  outputs: ComfyRawOutputs | undefined
): Array<RawFileRef & { nodeId: string }> {
  const files: Array<RawFileRef & { nodeId: string }> = [];
  for (const [nodeId, node] of Object.entries(outputs ?? {})) {
    for (const value of Object.values(node ?? {})) {
      if (!Array.isArray(value)) continue;
      for (const ref of value) {
        if (isFileRef(ref)) files.push({ ...ref, nodeId });
      }
    }
  }
  const saved = files.filter((f) => f.type === "output");
  return saved.length > 0 ? saved : files;
}

/** Text a sink node surfaced into the outputs, keyed by node. */
export function collectOutputText(
  outputs: ComfyRawOutputs | undefined
): Array<{ nodeId: string; text: string }> {
  const results: Array<{ nodeId: string; text: string }> = [];
  for (const [nodeId, node] of Object.entries(outputs ?? {})) {
    const raw = (node as { text?: unknown } | null)?.text;
    if (!Array.isArray(raw)) continue;
    const text = raw.filter((t) => typeof t === "string").join("").trim();
    if (text.length > 0) results.push({ nodeId, text });
  }
  return results;
}

/** Terminal statuses reported by Comfy Cloud's job endpoints. */
const CLOUD_SUCCESS = new Set(["completed", "success"]);
const CLOUD_FAILURE = new Set(["failed", "error", "cancelled", "canceled"]);

interface LegacyJobRaw {
  outputs?: ComfyRawOutputs;
}

export class LegacyComfyEngine implements ComfyEngine {
  readonly label: string;

  constructor(readonly connection: ComfyConnection) {
    this.label = connection.mode === "cloud" ? "Comfy Cloud" : "ComfyUI";
  }

  private get base(): string {
    return this.connection.baseUrl;
  }

  /** Cloud exposes richer job endpoints the OSS server does not have. */
  private get isCloud(): boolean {
    return this.connection.mode === "cloud";
  }

  async ping(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    // `/api/queue` needs auth on Cloud, so a 401 there is a *key* problem, not
    // a reachability problem — worth distinguishing in the message.
    const path = this.isCloud ? "/api/queue" : "/api/system_stats";
    try {
      const res = await engineRequest(this.connection, `${this.base}${path}`, {
        timeoutMs: 8_000,
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `${this.label} rejected the API key` };
      }
      if (res.status === 429) {
        return { ok: false, detail: "Comfy Cloud subscription is inactive" };
      }
      if (!res.ok) return { ok: false, detail: `${this.label} responded ${res.status}` };
      return { ok: true, detail: this.base };
    } catch {
      return { ok: false, detail: `Could not reach ${this.base}` };
    }
  }

  async objectInfo(signal?: AbortSignal): Promise<ComfyObjectInfo> {
    const res = await engineRequest(this.connection, `${this.base}/api/object_info`, {
      timeoutMs: CATALOG_TIMEOUT_MS,
      retries: CATALOG_RETRIES,
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ComfyEngineError(`${this.label} rejected the API key`, 401);
    }
    if (!res.ok) {
      throw new ComfyEngineError(`Could not read the node catalog from ${this.label}`);
    }
    return (await res.json()) as ComfyObjectInfo;
  }

  async upload(input: ComfyUploadInput, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append(
      "image",
      new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
      input.filename
    );
    form.append("type", "input");
    form.append("overwrite", "true");
    const res = await engineRequest(this.connection, `${this.base}/api/upload/image`, {
      method: "POST",
      body: form,
      timeoutMs: 120_000,
      retries: 2, // safe to retry — the upload sets overwrite
      signal,
    });
    if (!res.ok) {
      throw new ComfyEngineError(
        `${this.label} rejected the upload of ${input.filename} (${res.status})`
      );
    }
    const body = (await res.json()) as { name?: string; subfolder?: string };
    if (!body.name) throw new ComfyEngineError(`${this.label} returned no filename for the upload`);
    // A file placed in a subfolder must be referenced as `subfolder/name`.
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
  }

  async submit(graph: ComfyGraph, options: ComfySubmitOptions = {}): Promise<string> {
    const res = await engineRequest(this.connection, `${this.base}/api/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: graph,
        client_id: `node-banana-${crypto.randomUUID()}`,
        ...(options.orgApiKey
          ? { extra_data: { api_key_comfy_org: options.orgApiKey } }
          : {}),
      }),
      timeoutMs: 120_000,
      // No retries — a re-POST could enqueue a duplicate (billable) job.
      signal: options.signal,
    });
    if (res.status === 402) {
      throw new ComfyEngineError("Comfy Cloud: insufficient credits", 402);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ComfyEngineError(`${this.label} rejected the API key`, 401);
    }
    if (!res.ok) {
      throw new ComfyEngineError(await describeSubmitFailure(res, this.label), 422);
    }
    const body = (await res.json()) as { prompt_id?: string; node_errors?: unknown };
    if (!body.prompt_id) {
      throw new ComfyEngineError(`${this.label} accepted the workflow but returned no job id`);
    }
    return body.prompt_id;
  }

  async poll(jobId: string, signal?: AbortSignal): Promise<ComfyJobState> {
    return this.isCloud ? this.pollCloud(jobId, signal) : this.pollHistory(jobId, signal);
  }

  /** Cloud: a cheap status endpoint, then the job record once it is done. */
  private async pollCloud(jobId: string, signal?: AbortSignal): Promise<ComfyJobState> {
    const statusRes = await engineRequest(
      this.connection,
      `${this.base}/api/job/${jobId}/status`,
      {
        timeoutMs: 20_000,
        retries: 2,
        signal,
      }
    );
    if (!statusRes.ok) {
      return { status: "pending", terminal: false, error: null, raw: null };
    }
    const body = (await statusRes.json()) as { status?: string; error_message?: string | null };
    const status = body.status ?? "pending";

    if (CLOUD_FAILURE.has(status) || status.includes("error")) {
      return { status, terminal: true, error: cloudErrorDetail(status, body.error_message), raw: null };
    }
    // `executed` is an intermediate Cloud state (a node finished) — NOT final.
    // Reading outputs then is premature: file and text sinks may not be
    // surfaced yet, so a job that succeeded would look empty.
    if (!CLOUD_SUCCESS.has(status)) {
      return { status, terminal: false, error: null, raw: null };
    }

    const jobRes = await engineRequest(this.connection, `${this.base}/api/jobs/${jobId}`, {
      timeoutMs: 30_000,
      retries: 3,
      signal,
    });
    if (!jobRes.ok) {
      throw new ComfyEngineError(`Could not read Comfy Cloud job details (${jobRes.status})`);
    }
    const job = (await jobRes.json()) as { outputs?: ComfyRawOutputs; status?: string };
    return {
      status,
      terminal: true,
      error: null,
      raw: { outputs: job.outputs } satisfies LegacyJobRaw,
    };
  }

  /** OSS: `/history/{id}` is empty until the run finishes, then holds outputs. */
  private async pollHistory(jobId: string, signal?: AbortSignal): Promise<ComfyJobState> {
    const res = await engineRequest(this.connection, `${this.base}/api/history/${jobId}`, {
      timeoutMs: 20_000,
      retries: 2,
      signal,
    });
    if (!res.ok) return { status: "running", terminal: false, error: null, raw: null };

    const history = (await res.json()) as Record<
      string,
      { status?: { status_str?: string; messages?: unknown }; outputs?: ComfyRawOutputs }
    >;
    const entry = history[jobId];
    if (!entry) {
      // Not in history yet — still queued or executing. Ask the queue so a job
      // the engine silently dropped doesn't poll until the timeout.
      const queued = await this.isQueued(jobId, signal);
      return {
        status: queued ? "running" : "pending",
        terminal: false,
        error: null,
        raw: null,
      };
    }
    if (entry.status?.status_str === "error") {
      const detail = historyErrorDetail(entry.status);
      return {
        status: "error",
        terminal: true,
        error: detail?.message ?? "ComfyUI reported an execution error",
        ...(detail?.nodeId ? { errorNodeId: detail.nodeId } : {}),
        raw: null,
      };
    }
    const hasFiles = collectOutputFiles(entry.outputs).length > 0;
    const hasText = collectOutputText(entry.outputs).length > 0;
    if (!hasFiles && !hasText) {
      return { status: "running", terminal: false, error: null, raw: null };
    }
    return {
      status: "completed",
      terminal: true,
      error: null,
      raw: { outputs: entry.outputs } satisfies LegacyJobRaw,
    };
  }

  private async isQueued(jobId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await engineRequest(this.connection, `${this.base}/api/queue`, {
        timeoutMs: 8_000,
        signal,
      });
      if (!res.ok) return true; // unknown — assume still running rather than failing the run
      const queue = (await res.json()) as {
        queue_running?: Array<[number, string]>;
        queue_pending?: Array<[number, string]>;
      };
      return [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some(
        ([, id]) => id === jobId
      );
    } catch {
      return true;
    }
  }

  async collect(state: ComfyJobState, signal?: AbortSignal): Promise<ComfyOutputAsset[]> {
    const outputs = (state.raw as LegacyJobRaw | null)?.outputs;
    const assets: ComfyOutputAsset[] = [];

    for (const { nodeId, text } of collectOutputText(outputs)) {
      assets.push({ nodeId, type: "text", text });
    }

    for (const file of collectOutputFiles(outputs)) {
      const view = new URL(`${this.base}/api/view`);
      view.searchParams.set("filename", file.filename);
      // Cloud ignores `subfolder` (its storage is content-addressed); the OSS
      // server needs it. Sending it is correct for both.
      view.searchParams.set("subfolder", file.subfolder ?? "");
      view.searchParams.set("type", file.type ?? "output");
      assets.push({
        nodeId: file.nodeId,
        type: mediaTypeForFilename(file.filename),
        bytes: await this.downloadOutput(view, file.filename, signal),
        contentType: mimeForFilename(file.filename),
        filename: file.filename,
      });
    }
    return assets;
  }

  /**
   * One output's bytes.
   *
   * Two paths, because the two engines answer a view request differently:
   *
   * - An HTTP engine (local mode, a LAN install) serves the file itself, so the
   *   request goes through the policy seam like every other engine call: the
   *   credential rides to the bound destination only, and a redirect anywhere
   *   else fails the download instead of being followed.
   * - An HTTPS engine may answer with a 302 to a signed storage URL — Comfy
   *   Cloud does exactly that — which the policy seam would refuse as an
   *   unapproved redirect. There the download goes through the media seam
   *   instead, whose per-hop checks (scheme, resolved address, size, media
   *   type) are what a redirect chain needs, and whose fetch
   *   ({@link createMediaFetch}) attaches the API key to the engine's own
   *   origin only — the signed-storage hop is followed *without* the key.
   */
  private async downloadOutput(
    view: URL,
    filename: string,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (view.protocol === "http:") {
      const res = await engineRequest(this.connection, view.toString(), {
        timeoutMs: 180_000, // generous — one video output can be large
        retries: 3,
        signal,
      });
      if (!res.ok) {
        throw new ComfyEngineError(`Could not download output ${filename} (${res.status})`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }

    const allowNonPublic = providerConnectionFor(this.connection).allowNonPublicDestination;
    const download = await downloadSafeMedia(view.toString(), {
      authorizedOrigins: "provider-output",
      allowedMediaTypes: OUTPUT_MEDIA_TYPES,
      allowOctetStreamForMediaPaths: true,
      extensionsForOpaqueMedia: OUTPUT_OPAQUE_EXTENSIONS,
      maxBytes: MAX_OUTPUT_BYTES,
      // The engine is user-named: a loopback or LAN engine is the point, and
      // this is the same decision the policy seam applies on the other path.
      allowLoopback: allowNonPublic,
      allowPrivate: allowNonPublic,
      fetchImpl: createMediaFetch(this.connection),
      signal,
    });
    if (!download.ok) {
      throw new ComfyEngineError(
        `Could not download output ${filename} (${download.status ?? download.reason})`,
        502
      );
    }
    return download.bytes;
  }

  async cancel(jobId: string, signal?: AbortSignal): Promise<void> {
    // Best-effort, and never throws — a cancel must not fail the cancel.
    //
    // `/api/interrupt` has no job id: it kills whatever is executing. So it is
    // only used once this job is confirmed to be the running one, or the user
    // would stop someone else's render on a shared engine (or their own, in
    // another ComfyUI tab).
    try {
      await engineRequest(this.connection, `${this.base}/api/jobs/${jobId}/cancel`, {
        method: "POST",
        timeoutMs: 8_000,
        signal,
      });
    } catch {
      /* ignore */
    }

    let running = false;
    try {
      const res = await engineRequest(this.connection, `${this.base}/api/queue`, {
        timeoutMs: 8_000,
        signal,
      });
      if (res.ok) {
        const queue = (await res.json()) as {
          queue_running?: Array<[number, string]>;
          queue_pending?: Array<[number, string]>;
        };
        running = (queue.queue_running ?? []).some(([, id]) => id === jobId);
        // A job still queued is simply deleted — nothing has started yet.
        if ((queue.queue_pending ?? []).some(([, id]) => id === jobId)) {
          await engineRequest(this.connection, `${this.base}/api/queue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delete: [jobId] }),
            timeoutMs: 8_000,
            signal,
          }).catch(() => null);
        }
      }
    } catch {
      /* ignore */
    }

    if (!running) return;
    try {
      await engineRequest(this.connection, `${this.base}/api/interrupt`, {
        method: "POST",
        timeoutMs: 8_000,
        signal,
      });
    } catch {
      /* ignore */
    }
  }
}

/** Turn a `/prompt` rejection into something a user can act on. */
async function describeSubmitFailure(res: Response, label: string): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; details?: string };
      node_errors?: Record<string, { errors?: Array<{ message?: string; details?: string }> }>;
    };
    const nodeError = Object.entries(body.node_errors ?? {})
      .flatMap(([nodeId, entry]) =>
        (entry.errors ?? []).map((e) => `node ${nodeId}: ${e.message ?? ""} ${e.details ?? ""}`.trim())
      )
      .filter(Boolean)[0];
    const detail = nodeError ?? body.error?.message ?? body.error?.details;
    if (detail) return `${label} rejected the workflow — ${detail}`;
  } catch {
    /* fall through to the raw body */
  }
  return `${label} rejected the workflow (${res.status}) ${text.slice(0, 300)}`.trim();
}

/** Cloud reports the real reason inside a JSON-encoded `error_message`. */
function cloudErrorDetail(status: string, raw: string | null | undefined): string {
  if (!raw) return `Comfy Cloud job ${status}`;
  try {
    const parsed = JSON.parse(raw) as { exception_message?: string };
    if (parsed.exception_message) return `Comfy Cloud job ${status}: ${parsed.exception_message}`;
  } catch {
    /* keep the raw detail */
  }
  return `Comfy Cloud job ${status}: ${raw}`;
}

/** Pull the node-level message out of a `/history` error entry. */
function historyErrorDetail(
  status: { messages?: unknown } | undefined
): { message: string; nodeId?: string } | null {
  const messages = status?.messages;
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue;
    const [kind, payload] = message as [unknown, Record<string, unknown>];
    if (kind !== "execution_error" || typeof payload !== "object" || payload === null) continue;
    const nodeType = typeof payload.node_type === "string" ? payload.node_type : "a node";
    const detail =
      typeof payload.exception_message === "string" ? payload.exception_message : "execution failed";
    const nodeId =
      typeof payload.node_id === "string" || typeof payload.node_id === "number"
        ? String(payload.node_id)
        : undefined;
    return { message: `${nodeType}: ${detail}`, ...(nodeId ? { nodeId } : {}) };
  }
  return null;
}
