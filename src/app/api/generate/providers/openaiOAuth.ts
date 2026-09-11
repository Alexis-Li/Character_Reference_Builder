/**
 * OpenAI OAuth-experimental image entry (CRB-03).
 *
 * Second transport for the same business input as the API-key entry, kept on
 * a separate code path so the two channels can never impersonate each other.
 * The request semantics (every reference in fixed order, mask in its own
 * field, prompt/design constraints verbatim) match `openai.ts`; only the
 * transport differs (experimental endpoint + OAuth bearer).
 *
 * Fixture-only: no real OAuth token handling, no production claim. Real-call
 * evidence belongs to CRB-07.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";

function extractBase64Data(dataUrl: string): { data: string; mimeType: string } {
  if (dataUrl.includes("base64,")) {
    const [header, data] = dataUrl.split("base64,");
    const mimeMatch = header.match(/data:([^;]+)/);
    return { data, mimeType: mimeMatch ? mimeMatch[1] : "image/png" };
  }
  return { data: dataUrl, mimeType: "image/png" };
}

/** Experimental transport endpoint. Never the official API-key endpoint. */
export const OAUTH_EXPERIMENTAL_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/images/edits";

export async function generateWithOpenAIOAuth(
  requestId: string,
  oauthToken: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  const modelId = input.model.id;
  const parameters = input.parameters || {};
  const formData = new FormData();
  formData.append("model", modelId);
  formData.append("prompt", input.prompt);
  if (parameters.size) formData.append("size", String(parameters.size));
  if (parameters.quality) formData.append("quality", String(parameters.quality));

  const orderedImages = input.references?.length
    ? input.references.map((reference) => ({
        data: reference.image,
        filenameSuffix: reference.purpose ? `-${reference.purpose}` : "",
      }))
    : (input.images ?? []).map((image) => ({ data: image, filenameSuffix: "" }));

  orderedImages.forEach((image, index) => {
    const { data, mimeType } = extractBase64Data(image.data);
    const ext = mimeType === "image/jpeg" ? "jpg" : "png";
    const blob = new Blob([Buffer.from(data, "base64")], { type: mimeType });
    formData.append("image", blob, `${index + 1}${image.filenameSuffix}.${ext}`);
  });

  if (input.mask) {
    const { data, mimeType } = extractBase64Data(input.mask);
    const blob = new Blob([Buffer.from(data, "base64")], { type: mimeType });
    formData.append("mask", blob, "mask.png");
  }

  console.log(
    `[API:${requestId}] OpenAI OAuth-experimental request: ${orderedImages.length} image(s), model=${modelId}`
  );

  const response = await fetch(OAUTH_EXPERIMENTAL_ENDPOINT, {
    method: "POST",
    headers: {
      // Distinct header from the API-key path (`Authorization: Bearer sk-...`).
      // A recorded `oauth-experimental` call always rode this header.
      "Authorization": `Bearer ${oauthToken}`,
      "X-Experimental-Transport": "codex-oauth",
    },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    return {
      success: false,
      error: `OAuth-experimental request failed: HTTP ${response.status}${errorText ? ` - ${errorText.substring(0, 200)}` : ""}`,
    };
  }

  const data = await response.json();
  const b64Json = data.data?.[0]?.b64_json;
  if (!b64Json) {
    return { success: false, error: "No image in OAuth-experimental response" };
  }
  const dataUrl = `data:image/png;base64,${b64Json}`;
  return {
    success: true,
    outputs: [{ type: "image", data: dataUrl }],
  };
}
