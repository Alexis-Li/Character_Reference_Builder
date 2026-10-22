/**
 * OAuth image boundary originally adapted from oh-my-pi (MIT); see
 * licenses/oh-my-pi-MIT.txt. Wire contract follows official Codex 0.163.0,
 * 83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/{images.rs,endpoint/images.rs}.
 * JSON image requests, no automatic replay, endpoint fallback or account rotation.
 */
import { inputEvidence, imageSha256, reportedUsage } from "@/lib/providers/callEvidence.server";
import type { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import { imageCapabilities, checkReferenceGaps, effectiveReferences, summarizePurposes, type ProviderCallRecord } from "@/lib/providers/imageCapabilities";
import { oauthSession } from "@/lib/security/oauthSession.server";
import { bindCredentialToDestination } from "@/lib/security/providerConnection";
import { fetchWithConnectionPolicy } from "@/lib/security/outboundPolicy.server";
import { isDecodableRaster } from "@/lib/security/activeContent.server";

export const CODEX_IMAGE_EDIT_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/edits";
export const CODEX_IMAGE_GENERATE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations";
export const CODEX_IMAGE_MODEL = "gpt-image-2";
const INSTRUCTIONS = "Create modeling reference images. Preserve the original character and clothing design, proportions, materials and supplied views. Design fidelity takes priority over filling invisible details and visual polish. Follow the user's part ownership, reference roles and constraints; do not invent unsupported design facts.";
type Result = GenerationOutput & { execution: "not-executed" | "submitted" | "unknown"; statusUnknown?: boolean };

async function readJson(response: Response, limit: number): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("invalid-json-response");
  }
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder();
    let bytes = 0, text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("response-too-large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Only fixed diagnostic vocabulary may leave the Provider boundary. Error
 * bodies can echo prompts, image data or credentials, so never return them. */
async function providerRejection(response: Response): Promise<string> {
  const codes = new Set(["invalid_request_error", "invalid_value", "unsupported_value", "unsupported_parameter",
    "model_not_found", "model_not_supported", "insufficient_quota", "rate_limit_exceeded", "access_denied"]);
  const parameters = new Set(["model", "tools", "tools[0].action", "tools.0.action", "tools[0].output_format",
    "tools.0.output_format", "tool_choice", "input", "instructions", "store", "stream"]);
  let hint = "服务商未提供可安全显示的具体原因";
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel().catch(() => {});
    return "服务商返回非 JSON 错误页，请检查网络或服务商状态";
  }
  const reader = response.body?.getReader();
  if (!reader) return hint;
  try {
    let bytes = 0, text = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16384) return "服务商错误响应过大，具体内容已省略";
      text += decoder.decode(chunk.value, { stream: true });
    }
    const parsed = JSON.parse(text + decoder.decode());
    const error = parsed?.error && typeof parsed.error === "object" ? parsed.error
      : { message: typeof parsed?.detail === "string" ? parsed.detail : parsed?.message };
    if (!error || typeof error !== "object") return hint;
    const parts: string[] = [];
    if (codes.has(error.code)) parts.push(error.code);
    else if (codes.has(error.type)) parts.push(error.type);
    if (parameters.has(error.param)) parts.push(`参数 ${error.param}`);
    // Some native endpoints report only a message. Map known concepts to
    // static hints; none of the untrusted message text is copied to the UI.
    if (typeof error.message === "string") {
      if (/(?:image_generation|image generation).*(?:not supported|not available|not allowed)/i.test(error.message)) parts.push("该账号或模型未开放图像工具");
      else if (/model.*not supported/i.test(error.message)) parts.push("该账号或端点不支持所选图像模型");
      else if (/unsupported.*output_format/i.test(error.message)) parts.push("图像输出格式参数不受支持");
      else if (/unsupported.*tool_choice/i.test(error.message)) parts.push("工具选择参数不受支持");
    }
    if (parts.length) hint = parts.join("；");
  } catch { /* Keep the fixed safe fallback, never raw text or parser errors. */ }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return hint;
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
  const endpoint = references.length ? CODEX_IMAGE_EDIT_ENDPOINT : CODEX_IMAGE_GENERATE_ENDPOINT;
  const binding = bindCredentialToDestination({ provider: "chatgpt-codex", role: "image", endpoint,
    credential: credential.token, credentialKind: "oauth", credentialSource: "protected-store",
    registeredOrigins: ["https://chatgpt.com"], expiresAt: credential.expiresAt });
  const purposes = summarizePurposes(references);
  const call: Omit<ProviderCallRecord, "stage"> = {
    at: Date.now(), provider: "openai", modelId: input.model.id, displayName: input.model.name,
    resolvedFrom: input.modelSource ?? "node-legacy", declared: true, capabilities,
    referenceCount: references.length, ...purposes, hasMask: false, auth: "oauth",
  };
  const referenceRoles = references.flatMap((ref, index) => ref.purpose ? [`Reference ${index + 1} purpose: ${ref.purpose}`] : []);
  const wirePrompt = [INSTRUCTIONS, ...referenceRoles, input.prompt].join("\n\n");
  Object.assign(call, inputEvidence(wirePrompt, references), { requestedModelId: CODEX_IMAGE_MODEL });
  let sent = false;
  try {
    const result = await fetchWithConnectionPolicy({ connection: binding.connection, url: endpoint,
      method: "POST", credential: binding.credential, placement: { header: "Authorization", prefix: "Bearer " },
      headers: { "Content-Type": "application/json", "Accept": "application/json", "ChatGPT-Account-Id": account.workspaceId,
        "originator": "character_reference_builder" },
      body: JSON.stringify({ model: CODEX_IMAGE_MODEL, prompt: wirePrompt,
        background: "opaque", quality: "auto", size: "auto",
        ...(references.length ? { images: references.map(ref => ({ image_url: ref.image })) } : {}) }),
      signal: AbortSignal.timeout(180_000), maxRedirects: 0,
      fetchImpl: async (...args) => {
        if (!credential.isCurrent()) throw new Error("account-session-ended");
        sent = true;
        return fetch(...args);
      },
    });
    if (!result.ok) return { success: false, execution: sent ? "unknown" : "not-executed", statusUnknown: sent,
      error: `OAuth 请求被接收方策略拒绝：${result.reason}`, ...(sent ? { call: { ...call, completedAt: Date.now(), stage: "failed" } } : {}) };
    if (!result.response.ok) return { success: false, execution: "submitted",
      error: `OAuth 图像服务返回 HTTP ${result.response.status}（${await providerRejection(result.response)}）；本次不会自动重试。`, call: { ...call, completedAt: Date.now(), stage: "failed" } };
    const response = await readJson(result.response, 48 * 1024 * 1024) as { data?: { b64_json?: unknown }[]; usage?: unknown };
    Object.assign(call, reportedUsage("codex-images", response?.usage));
    if (!Array.isArray(response?.data) || response.data.length !== 1) throw new Error("invalid-image-result");
    const encoded = response.data[0]?.b64_json;
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("invalid-output-image");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 32 * 1024 * 1024) throw new Error("output-too-large");
    for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
      if (await isDecodableRaster(mime, bytes)) return { success: true, execution: "submitted",
        outputs: [{ type: "image", data: `data:${mime};base64,${encoded}` }],
        call: { ...call, completedAt: Date.now(), outputSha256: [imageSha256(`data:${mime};base64,${encoded}`)], stage: "succeeded" } };
    }
    throw new Error("invalid-output-image");
  } catch {
    return { success: false, execution: sent ? "unknown" : "not-executed", statusUnknown: sent,
      error: sent ? "OAuth 图像请求未取得完整有效结果，上游状态未知。请保留已选版本，确认后再重试。" : "OAuth 账号或网络状态已改变，请重新连接或确认；本次图像请求未提交。",
      ...(sent ? { call: { ...call, completedAt: Date.now(), stage: "failed" } } : {}) };
  }
}
