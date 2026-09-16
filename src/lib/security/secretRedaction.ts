/**
 * Secret redaction (CRB-09 / Issue #10).
 *
 * One shared, isomorphic redaction seam for every surface that can leave the
 * process or the machine: console output, process logs, error responses,
 * project persistence, workflow/template export, reference packages, browser
 * downloads and shareable diagnostics.
 *
 * Two mechanisms, both required:
 * - structured: a field whose *name* is credential-shaped is dropped (or
 *   replaced) wherever it appears in a nested object;
 * - free text: credential-shaped *values* (bearer headers, provider key
 *   formats, signed-URL query parameters, cookie/authorization headers) are
 *   replaced inside arbitrary strings, so a secret pasted into a prompt,
 *   error message or note cannot survive.
 */

/** Replacement marker for redacted values. Stable: tests and audits match it. */
export const REDACTED = "[redacted]";

/**
 * Field names that carry credentials, tokens or verifier material.
 *
 * Anchored (full-name) matching keeps ordinary fields such as `tokenCount` or
 * `modelKey` untouched; plural and camel/snake/kebab spellings are covered.
 */
export const SECRET_FIELD_PATTERN =
  /^(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth(?:orization)?|authorization[-_]?header|auth[-_]?code|authorization[-_]?code|code[-_]?verifier|client[-_]?secret|password|passwd|secret|credential|token|signature|cookies|cookie|set[-_]?cookie|bearer)s?$/i;

/**
 * Value shapes that are credentials regardless of the field they sit in.
 *
 * Order matters: header forms run before bare key formats so `Authorization:
 * Bearer sk-…` loses the whole header value.
 */
const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization / cookie headers in log or error text.
  [/((?:proxy-)?authorization\s*[:=]\s*)[^\r\n,;}"']+/gi, `$1${REDACTED}`],
  [/((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Provider key formats.
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\br8_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  // Custom credential headers echoed into text, e.g. `X-Kie-Key: …` or
  // `x-comfy-api-key=…` in a logged request line. Providers whose keys have no
  // recognisable shape (kie, wavespeed, comfy) are only visible this way.
  [/(x-[a-z0-9-]*(?:key|token|secret)\s*[:=]\s*)[^\s,;"']+/gi, `$1${REDACTED}`],
  // JWT-shaped bearer material (access/refresh/id tokens, signed assertions).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Signed URLs and sensitive query parameters.
  [
    /([?&](?:access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|token|key|signature|sig|code|code[-_]?verifier|client[-_]?secret|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature)=)[^&#\s"']+/gi,
    `$1${REDACTED}`,
  ],
];

/** Replace credential-shaped values inside free text. */
export function redactSecretsInText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** True when a string still carries credential-shaped material. */
export function containsSecretMaterial(value: unknown): boolean {
  if (typeof value === "string") {
    return redactSecretsInText(value) !== value;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretMaterial(item));
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_PATTERN.test(key)) return true;
      if (containsSecretMaterial(child)) return true;
    }
  }
  return false;
}

export interface RedactOptions {
  /**
   * `drop` removes a secret-named field entirely (used by persistence and
   * export, matching the historical project-file contract).
   * `replace` keeps the field with a marker so a reviewer can see that a value
   * was present and withheld (used by logs and diagnostics).
   */
  secretFields?: "drop" | "replace";
  /** Optional key filter, applied after the secret-name filter. */
  omit?: (key: string, path: readonly string[]) => boolean;
}

/**
 * Deep-redact a value: secret-named fields are dropped or replaced, and every
 * remaining string is scanned for credential-shaped values.
 */
export function redactSecretsDeep<T>(value: T, options: RedactOptions = {}): T {
  const secretFields = options.secretFields ?? "replace";
  return redactValue(value, options, secretFields, []) as T;
}

function redactValue(
  value: unknown,
  options: RedactOptions,
  secretFields: "drop" | "replace",
  path: string[],
): unknown {
  if (typeof value === "string") {
    // Base64 payloads are not text to scan: rewriting inside them would corrupt
    // media while protecting nothing (a data URL carries no header material).
    if (/^data:[^;,]+;base64,/.test(value)) return value;
    return redactSecretsInText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options, secretFields, path));
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (SECRET_FIELD_PATTERN.test(key) || options.omit?.(key, childPath)) {
      if (secretFields === "replace") output[key] = REDACTED;
      continue;
    }
    output[key] = redactValue(child, options, secretFields, childPath);
  }
  return output;
}
