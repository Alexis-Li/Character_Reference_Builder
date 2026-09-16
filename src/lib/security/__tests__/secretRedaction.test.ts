/**
 * Secret redaction acceptance suite (CRB-09 / Issue #10).
 *
 * One confidentiality matrix: every credential shape the seam claims to know
 * (bearer/authorization/cookie headers, provider key formats, JWTs, signed-URL
 * query parameters, PKCE verifier material) is inserted into every surface that
 * can leave the process — nested objects, free text, Character Projects,
 * workflow templates, asset manifests, error messages, console context and log
 * sessions — and the serialized result is searched for the synthetic secrets.
 */

import { describe, expect, it } from "vitest";
import { REDACTED, containsSecretMaterial, redactSecretsDeep, redactSecretsInText } from "../secretRedaction";

const OPENAI_KEY = "sk-synthetic-not-a-real-key-0001";
const GOOGLE_KEY = "AIzaSySynthetic00000000000000000000";
const REPLICATE_KEY = "r8_synthetic000000000000000000";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2N0LXN5bnRoZXRpYy0xIn0.syntheticSignatureSegment";
const JWT_HEADER_SEGMENT = "eyJhbGciOiJIUzI1NiJ9";
const COOKIE_VALUE = "synthetic-capability-value-0001";
const SIGNED_ACCESS_TOKEN_VALUE = "syntheticSignedAccessTokenValue01";
const SIGNED_SIGNATURE_VALUE = "syntheticSignedSignatureValue0001";
const PKCE_VERIFIER = "syntheticPkceVerifierMaterial00000000000000";

const SIGNED_URL = `https://media.example.invalid/synthetic/asset-001.png?access_token=${SIGNED_ACCESS_TOKEN_VALUE}&X-Amz-Signature=${SIGNED_SIGNATURE_VALUE}`;
const VERIFIER_QUERY = `https://auth.example.invalid/oauth2/token?code_verifier=${PKCE_VERIFIER}`;
const SHA256_ZERO = "0".repeat(64);

/** Exact substrings that must not survive redaction in any covered shape. */
const SECRET_SUBSTRINGS = [
  OPENAI_KEY,
  GOOGLE_KEY,
  REPLICATE_KEY,
  JWT,
  JWT_HEADER_SEGMENT,
  COOKIE_VALUE,
  SIGNED_ACCESS_TOKEN_VALUE,
  SIGNED_SIGNATURE_VALUE,
  PKCE_VERIFIER,
];

/** Every supported credential shape, as it would appear inside free text. */
function secretBearingText(label: string): string {
  return [
    `${label}: the Provider rejected the request`,
    `proxy-authorization: Bearer ${OPENAI_KEY}`,
    `upstream echoed the key ${OPENAI_KEY}`,
    `provider key ${GOOGLE_KEY}`,
    `replicate key ${REPLICATE_KEY}`,
    `assertion ${JWT}`,
    `cookie: crb_local_session=${COOKIE_VALUE}`,
    SIGNED_URL,
    VERIFIER_QUERY,
  ].join("\n");
}

function nestedObjectContainer(): Record<string, unknown> {
  return {
    requestId: "req-synthetic-1",
    modelId: "gemini-2.5-flash-image",
    imagePath: "generations/blob-front.png",
    note: secretBearingText("nested object"),
    apiKey: OPENAI_KEY,
    access_token: SIGNED_ACCESS_TOKEN_VALUE,
    refreshToken: JWT,
    code_verifier: PKCE_VERIFIER,
    authorization: `Bearer ${OPENAI_KEY}`,
    cookie: `crb_local_session=${COOKIE_VALUE}`,
    providers: [
      { provider: "google", key: GOOGLE_KEY, model: "veo-3.1" },
      { provider: "replicate", key: REPLICATE_KEY, model: "flux-2" },
    ],
    nested: { deeper: { token: SIGNED_ACCESS_TOKEN_VALUE } },
  };
}

function characterProjectContainer(): Record<string, unknown> {
  return {
    id: "project-synthetic-1",
    notes: `Character sheet notes. ${secretBearingText("character notes")}`,
    prompt: `Full-body portrait sheet. The upstream credential was ${OPENAI_KEY}`,
    projectLocks: [{ id: "lock-1", description: "keep the face consistent" }],
    references: [{ id: "ref-front", source: "assets/ref-front.png", note: "ordinary reference" }],
    candidates: [{ id: "candidate-front", view: "front", inferenceNotes: `debug trace ${JWT}` }],
    selection: { "part-head@front": "candidate-front" },
    workflow: {
      nodes: [
        {
          id: "prompt-1",
          type: "prompt",
          data: { prompt: "calm portrait", model: "gemini-2.5-flash-image" },
        },
        {
          id: "generate-1",
          type: "nanoBanana",
          data: {
            requestId: "req-synthetic-1",
            url: SIGNED_URL,
            headers: {
              authorization: `Bearer ${OPENAI_KEY}`,
              cookie: `crb_local_session=${COOKIE_VALUE}`,
            },
          },
        },
      ],
    },
  };
}

function workflowTemplateContainer(): Record<string, unknown> {
  return {
    id: "template-synthetic-1",
    name: "Synthetic portrait template",
    version: 3,
    description: `Exported template. ${secretBearingText("template description")}`,
    nodes: [
      {
        id: "prompt-1",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { prompt: "calm portrait", model: "gemini-2.5-flash-image" },
      },
      {
        id: "generate-1",
        type: "nanoBanana",
        position: { x: 320, y: 0 },
        data: { token: SIGNED_ACCESS_TOKEN_VALUE, sourceUrl: SIGNED_URL },
      },
    ],
    edges: [{ id: "edge-1", source: "prompt-1", target: "generate-1" }],
  };
}

function assetManifestContainer(): Record<string, unknown> {
  return {
    version: 1,
    projectId: "project-synthetic-1",
    assets: [
      {
        id: "candidate-front",
        kind: "candidate",
        relativePath: "generations/blob-front.png",
        sha256: SHA256_ZERO,
        byteLength: 2048,
        mimeType: "image/png",
        candidateId: "candidate-front",
        sourceUrl: SIGNED_URL,
        inferenceNotes: `uploaded with ${REPLICATE_KEY}. ${secretBearingText("asset manifest")}`,
      },
      {
        id: "source-front",
        kind: "source",
        relativePath: "images/ref-front.png",
        sha256: "1".repeat(64),
        byteLength: 1024,
        mimeType: "image/png",
        accessToken: SIGNED_ACCESS_TOKEN_VALUE,
      },
    ],
  };
}

function consoleContextContainer(): Record<string, unknown> {
  return {
    requestId: "req-synthetic-1",
    provider: "google",
    method: "POST",
    attempt: 2,
    endpoint: VERIFIER_QUERY,
    headers: {
      authorization: `Bearer ${OPENAI_KEY}`,
      "x-api-key": GOOGLE_KEY,
      cookie: `crb_local_session=${COOKIE_VALUE}`,
    },
    body: { note: secretBearingText("console body") },
  };
}

function logSessionContainer(): Record<string, unknown> {
  return {
    sessionId: "log-session-synthetic-1",
    startTime: "2026-09-16T10:00:00.000Z",
    endTime: "2026-09-16T10:05:00.000Z",
    entries: [
      {
        timestamp: "2026-09-16T10:00:01.000Z",
        level: "info",
        category: "api.error",
        message: secretBearingText("log entry"),
        context: {
          token: SIGNED_ACCESS_TOKEN_VALUE,
          endpoint: SIGNED_URL,
          headers: { authorization: `Bearer ${OPENAI_KEY}` },
        },
      },
      {
        timestamp: "2026-09-16T10:00:02.000Z",
        level: "error",
        category: "file.error",
        message: `Failed with ${OPENAI_KEY}`,
        error: { name: "Error", message: `Provider said ${JWT}` },
      },
    ],
  };
}

const CONTAINERS: ReadonlyArray<readonly [string, () => unknown, string]> = [
  ["a nested object with ordinary sibling fields", nestedObjectContainer, "gemini-2.5-flash-image"],
  [
    "a free-text prompt / note string",
    () => secretBearingText("prompt"),
    "the Provider rejected the request",
  ],
  ["a Character-Project-shaped object", characterProjectContainer, "calm portrait"],
  ["a workflow template shape", workflowTemplateContainer, "Synthetic portrait template"],
  ["an asset manifest shape", assetManifestContainer, "generations/blob-front.png"],
  [
    "an error message string",
    () => `Provider request failed (HTTP 401). ${secretBearingText("error report")}`,
    "Provider request failed",
  ],
  ["a console-context object", consoleContextContainer, "req-synthetic-1"],
  ["a log-session-shaped object", logSessionContainer, "log-session-synthetic-1"],
];

describe("secret redaction", () => {
  for (const [label, build, ordinary] of CONTAINERS) {
    describe(label, () => {
      it("keeps no secret value or reversible fragment when secretFields is drop", () => {
        const raw = JSON.stringify(build());
        const serialized = JSON.stringify(redactSecretsDeep(build(), { secretFields: "drop" }));

        for (const secret of SECRET_SUBSTRINGS) {
          // The shape really was present before redaction, so its absence means
          // something.
          expect(raw).toContain(secret);
          expect(serialized).not.toContain(secret);
        }
        expect(serialized).toContain(ordinary);
        expect(serialized).toContain(REDACTED);
      });

      it("marks withheld values when secretFields is replace", () => {
        const serialized = JSON.stringify(redactSecretsDeep(build(), { secretFields: "replace" }));

        for (const secret of SECRET_SUBSTRINGS) {
          expect(serialized).not.toContain(secret);
        }
        expect(serialized).toContain(ordinary);
        expect(serialized).toContain(REDACTED);
      });
    });
  }

  describe("structured values", () => {
    it("drops a secret-named field entirely when secretFields is drop", () => {
      const dropped = redactSecretsDeep(
        { prompt: "calm portrait", apiKey: OPENAI_KEY, nested: { refreshToken: JWT } },
        { secretFields: "drop" },
      );

      expect(dropped).toEqual({ prompt: "calm portrait", nested: {} });
    });

    it("keeps the field name and withholds the value when secretFields is replace", () => {
      const replaced = redactSecretsDeep(
        {
          apiKey: OPENAI_KEY,
          access_token: SIGNED_ACCESS_TOKEN_VALUE,
          refreshToken: JWT,
          code_verifier: PKCE_VERIFIER,
          headers: {
            authorization: `Bearer ${OPENAI_KEY}`,
            cookie: `crb_local_session=${COOKIE_VALUE}`,
          },
        },
        { secretFields: "replace" },
      );

      expect(Object.keys(replaced)).toEqual([
        "apiKey",
        "access_token",
        "refreshToken",
        "code_verifier",
        "headers",
      ]);
      expect(replaced.apiKey).toBe(REDACTED);
      expect(replaced.access_token).toBe(REDACTED);
      expect(replaced.refreshToken).toBe(REDACTED);
      expect(replaced.code_verifier).toBe(REDACTED);
      expect(Object.keys(replaced.headers)).toEqual(["authorization", "cookie"]);
      expect(replaced.headers.authorization).toBe(REDACTED);
      expect(replaced.headers.cookie).toBe(REDACTED);
    });

    it("leaves ordinary values, paths, model ids and credentially-named-but-ordinary fields untouched", () => {
      const ordinary = {
        prompt: "A calm portrait of the synthetic character",
        imagePath: "generations/blob-front.png",
        modelId: "gemini-2.5-flash-image",
        tokenCount: 3,
        modelKey: "nano-banana",
        nodes: [{ id: "prompt-1", data: { prompt: "calm portrait", scale: 2 } }],
      };

      expect(redactSecretsDeep(ordinary, { secretFields: "drop" })).toEqual(ordinary);
      expect(redactSecretsDeep(ordinary, { secretFields: "replace" })).toEqual(ordinary);
    });
  });

  describe("media", () => {
    const PNG_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const CRAFTED_DATA_URL = "data:image/png;base64,AIzaSySyntheticPayload00000000000000";

    it("returns base64 data URLs byte-identical and never rewrites media", () => {
      // The crafted payload reads like a credential to the text scanner, so the
      // exemption — not the absence of a match — is what keeps media intact.
      expect(redactSecretsInText(CRAFTED_DATA_URL)).not.toBe(CRAFTED_DATA_URL);

      const redacted = redactSecretsDeep(
        {
          mediaType: "image/png",
          dataUrl: PNG_DATA_URL,
          craftedDataUrl: CRAFTED_DATA_URL,
          checksum: SHA256_ZERO,
        },
        { secretFields: "drop" },
      );

      expect(redacted.dataUrl).toBe(PNG_DATA_URL);
      expect(redacted.craftedDataUrl).toBe(CRAFTED_DATA_URL);
      expect(redacted.checksum).toBe(SHA256_ZERO);
    });
  });

  describe("containsSecretMaterial", () => {
    const SHAPES: ReadonlyArray<readonly [string, string]> = [
      ["an authorization header", `proxy-authorization: Bearer ${OPENAI_KEY}`],
      ["a provider key", OPENAI_KEY],
      ["a Google-style key", GOOGLE_KEY],
      ["a Replicate-style key", REPLICATE_KEY],
      ["a JWT", JWT],
      ["a cookie header", `cookie: crb_local_session=${COOKIE_VALUE}`],
      ["a signed URL", SIGNED_URL],
      ["a PKCE verifier query parameter", VERIFIER_QUERY],
    ];

    for (const [label, text] of SHAPES) {
      it(`detects ${label} in text and in nested values`, () => {
        expect(containsSecretMaterial(text)).toBe(true);
        expect(containsSecretMaterial({ note: text })).toBe(true);
        expect(containsSecretMaterial([{ data: { deeper: text } }])).toBe(true);
        expect(containsSecretMaterial(redactSecretsDeep({ note: text }, { secretFields: "drop" }))).toBe(
          false,
        );
      });
    }

    it("treats a credential-named field as material regardless of its value", () => {
      expect(containsSecretMaterial({ refreshToken: "placeholder" })).toBe(true);
      expect(containsSecretMaterial({ headers: { cookie: "session=1" } })).toBe(true);
    });

    it("passes a clean project-shaped object", () => {
      const clean = {
        id: "project-synthetic-1",
        notes: "Character sheet notes for the synthetic character",
        prompt: "A calm portrait, neutral background",
        references: [{ id: "ref-front", source: "assets/ref-front.png" }],
        selection: { "part-head@front": "candidate-front" },
        workflow: {
          nodes: [
            {
              id: "prompt-1",
              type: "prompt",
              data: { prompt: "calm portrait", model: "gemini-2.5-flash-image" },
            },
          ],
        },
      };

      expect(containsSecretMaterial(clean)).toBe(false);
    });
  });
});
