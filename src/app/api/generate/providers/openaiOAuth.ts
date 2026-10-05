/**
 * Hosted-image mapping adapted from oh-my-pi (MIT),
 * 4819e4f6d59049f307329d42b226b218582bdf38/packages/ai/src/images/openai-hosted.ts.
 * See licenses/oh-my-pi-MIT.txt. No automatic replay or account rotation.
 */
import type { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { imageCapabilities, checkReferenceGaps, effectiveReferences, summarizePurposes, type ProviderCallRecord } from "@/lib/providers/imageCapabilities";
import { oauthSession } from "@/lib/security/oauthSession.server";
import { bindCredentialToDestination } from "@/lib/security/providerConnection";
import { fetchWithConnectionPolicy } from "@/lib/security/outboundPolicy.server";
import { isDecodableRaster } from "@/lib/security/activeContent.server";

export const CODEX_IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_IMAGE_CARRIER = "gpt-5.4";
const INSTRUCTIONS = "Create modeling reference images. Preserve the original character and clothing design, proportions, materials and supplied views. Design fidelity takes priority over filling invisible details and visual polish. Follow the user's part ownership, reference roles and constraints; do not invent unsupported design facts.";
type HostedOutput = { type?: string; result?: string };
type HostedResponse = { output?: HostedOutput[]; tools?: { type?: string; model?: string }[] };
type HostedEvent = { type?: string; item?: HostedOutput; response?: HostedResponse };
type Result = GenerationOutput & { execution: "not-executed" | "submitted" | "unknown"; statusUnknown?: boolean };

/** Strict SSE framing across arbitrary chunks; bounded, terminal completion required. */
async function readHostedResponse(response: Response): Promise<HostedResponse> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("invalid-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0;
  const outputs: HostedOutput[] = [];
  let completed: HostedResponse | null = null;
  const parse = (frame: string) => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as HostedEvent;
    if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") throw new Error("provider-failed");
    if (event.type === "response.output_item.done" && event.item) outputs.push(event.item);
    if ((event.type === "response.completed" || event.type === "response.done") && event.response) completed = event.response;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 128 * 1024 * 1024) throw new Error("response-too-large");
      buffer += decoder.decode(chunk.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        parse(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) parse(buffer);
    if (!completed) throw new Error("stream-ended-before-completion");
    const final = completed as HostedResponse;
    return { ...final, output: final.output?.length ? final.output : outputs };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function generateWithOpenAIOAuth(
  _requestId: string, input: GenerationInput, localSessionId: string, grantId: string,
): Promise<Result> {
  const references = effectiveReferences(input.references ?? [], input.images);
  const capabilities = imageCapabilities("openai", input.model.id, "oauth");
  const gaps = checkReferenceGaps(capabilities, { references, mask: input.mask, prompt: input.prompt });
  if (!capabilities || gaps.length) return { success: false, execution: "not-executed", error: gaps.map(g => g.message).join("; ") || "Unsupported OAuth image entry" };
  const unexpectedDynamicInput = Object.entries(input.dynamicInputs ?? {}).some(([key, value]) =>
    key !== "image" || JSON.stringify(Array.isArray(value) ? value : [value]) !== JSON.stringify(references.map(ref => ref.image)));
  if (unexpectedDynamicInput || Object.keys(input.parameters ?? {}).length) {
    return { success: false, execution: "not-executed", error: "OAuth 图像入口暂不支持这些模型参数，请清除参数后重试。" };
  }
  for (const reference of references) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(reference.image);
    if (!match || !await isDecodableRaster(match[1], Buffer.from(match[2], "base64"))) {
      return { success: false, execution: "not-executed", error: "参考图必须为可解码的 PNG、JPEG 或 WebP。" };
    }
  }
  const adapter = oauthSession();
  await adapter.restore();
  const credential = await adapter.accessTokenForCall(localSessionId, grantId);
  if (!credential.ok) return { success: false, execution: "not-executed", error: `OAuth ${credential.reason}：请在服务商设置中重新连接或确认本次调用。` };
  const account = adapter.browserView().account;
  if (!account?.workspaceId) return { success: false, execution: "not-executed", error: "OAuth 缺少工作区身份，请重新连接。" };
  const binding = bindCredentialToDestination({ provider: "chatgpt-codex", role: "image", endpoint: CODEX_IMAGE_ENDPOINT,
    credential: credential.token, credentialKind: "oauth", credentialSource: "protected-store",
    registeredOrigins: ["https://chatgpt.com"], expiresAt: credential.expiresAt });
  const purposes = summarizePurposes(references);
  const call: Omit<ProviderCallRecord, "stage"> = {
    at: Date.now(), provider: "openai", modelId: input.model.id, displayName: input.model.name,
    resolvedFrom: input.modelSource ?? "node-legacy", declared: true, capabilities,
    referenceCount: references.length, ...purposes, hasMask: false, auth: "oauth",
    carrierModelId: CODEX_IMAGE_CARRIER,
  };
  const content: Record<string, unknown>[] = [{ type: "input_text", text: input.prompt }];
  references.forEach((ref, index) => {
    if (ref.purpose) content.push({ type: "input_text", text: `Reference ${index + 1} purpose: ${ref.purpose}` });
    content.push({ type: "input_image", detail: "auto", image_url: ref.image });
  });
  let sent = false;
  try {
    const result = await fetchWithConnectionPolicy({ connection: binding.connection, url: CODEX_IMAGE_ENDPOINT,
      method: "POST", credential: binding.credential, placement: { header: "Authorization", prefix: "Bearer " },
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream", "ChatGPT-Account-Id": account.workspaceId,
        "OpenAI-Beta": "responses=experimental", "originator": "character_reference_builder" },
      body: JSON.stringify({ model: CODEX_IMAGE_CARRIER, instructions: INSTRUCTIONS,
        input: [{ role: "user", content }], tools: [{ type: "image_generation", action: references.length ? "edit" : "generate", output_format: "webp" }],
        tool_choice: { type: "image_generation" }, store: false, stream: true }),
      signal: AbortSignal.timeout(180_000), maxRedirects: 0,
      fetchImpl: async (...args) => {
        if (!credential.isCurrent()) throw new Error("account-session-ended");
        sent = true;
        return fetch(...args);
      },
    });
    if (!result.ok) return { success: false, execution: sent ? "unknown" : "not-executed", statusUnknown: sent,
      error: `OAuth 请求被接收方策略拒绝：${result.reason}`, ...(sent ? { call: { ...call, stage: "failed" } } : {}) };
    if (!result.response.ok) return { success: false, execution: "submitted", error: `OAuth 图像服务返回 HTTP ${result.response.status}；请检查账号与图像工具可用性。`, call: { ...call, stage: "failed" } };
    const response = await readHostedResponse(result.response);
    const output = response.output?.find(item => item.type === "image_generation_call" && item.result);
    if (!output?.result) return { success: false, execution: "submitted", error: "授权已连接，但该账号未返回图像；图像工具能力尚未通过验收。", call: { ...call, stage: "failed" } };
    const bytes = Buffer.from(output.result, "base64");
    if (!await isDecodableRaster("image/webp", bytes)) throw new Error("invalid-output-image");
    return { success: true, execution: "submitted", outputs: [{ type: "image", data: `data:image/webp;base64,${output.result}` }],
      call: { ...call, stage: "succeeded", ...(response.tools?.find(tool => tool.type === "image_generation")?.model ? { actualImageModelId: response.tools.find(tool => tool.type === "image_generation")!.model } : {}) } };
  } catch {
    return { success: false, execution: sent ? "unknown" : "not-executed", statusUnknown: sent,
      error: sent ? "OAuth 图像请求未取得完整有效结果，上游状态未知。请保留已选版本，确认后再重试。" : "OAuth 账号或网络状态已改变，请重新连接或确认；本次图像请求未提交。",
      ...(sent ? { call: { ...call, stage: "failed" } } : {}) };
  }
}
