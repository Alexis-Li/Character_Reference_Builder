/**
 * Provider connection acceptance suite (CRB-09 / Issue #10).
 *
 * Asserts the credential-recipient matrix as external behavior: which
 * destination may carry which credential, which credential is withheld and for
 * which reason, and which origins a bound connection permits. Nothing here
 * inspects private helpers — every case drives the exported binding seam.
 */

import { describe, it, expect } from "vitest";
import {
  PROVIDER_RECIPIENTS,
  anonymousConnection,
  bindCredentialToDestination,
  credentialAllowedFor,
  redirectAllowedFor,
  type DestinationBindingInput,
  type ProviderConnection,
} from "../providerConnection";

const SYNTHETIC_KEY = "sk-synthetic-not-a-real-key";
const OPENAI_ORIGIN = "https://api.openai.com";
const OPENAI_ENDPOINT = `${OPENAI_ORIGIN}/v1/images/generations`;
const ATTACKER_ORIGIN = "https://attacker.example";
const OVERRIDE_ENDPOINT = `${ATTACKER_ORIGIN}/v1/images/generations`;
const COMFY_ORIGIN = "https://cloud.comfy.org";
const COMFY_ENDPOINT = `${COMFY_ORIGIN}/prompt`;

function bind(overrides: Partial<DestinationBindingInput> = {}) {
  return bindCredentialToDestination({
    provider: "openai",
    role: "image",
    endpoint: OPENAI_ENDPOINT,
    credential: SYNTHETIC_KEY,
    credentialKind: "api-key",
    credentialSource: "browser-supplied",
    ...overrides,
  });
}

function comfyBind(role: DestinationBindingInput["role"], overrides: Partial<DestinationBindingInput> = {}) {
  return bindCredentialToDestination({
    provider: "comfy",
    role,
    endpoint: COMFY_ENDPOINT,
    credential: SYNTHETIC_KEY,
    credentialKind: "api-key",
    credentialSource: "browser-supplied",
    ...overrides,
  });
}

describe("credential recipient matrix", () => {
  it("returns a browser-supplied key for the registered Provider destination", () => {
    const binding = bind();

    expect(binding.credential).toBe(SYNTHETIC_KEY);
    expect(binding.withheld).toBeNull();
    expect(binding.connection.recipientOrigin).toBe(OPENAI_ORIGIN);
    expect(binding.connection.credentialSource).toBe("browser-supplied");
    expect(binding.connection.userAuthorizedDestination).toBe(false);
  });

  it("returns a server environment key for its registered recipient", () => {
    const binding = bind({ credentialSource: "server-environment" });

    expect(binding.credential).toBe(SYNTHETIC_KEY);
    expect(binding.withheld).toBeNull();
  });

  it("withholds a server environment key from a caller-named destination override", () => {
    const binding = bind({
      endpoint: OVERRIDE_ENDPOINT,
      credentialSource: "server-environment",
      userAuthorizedDestination: true,
    });

    expect(binding.credential).toBeNull();
    expect(binding.withheld).toBe("source-not-authorized-for-destination");
    expect(binding.connection.recipientOrigin).toBe(ATTACKER_ORIGIN);
  });

  it("withholds any credential from an override that is neither registered nor user-authorized", () => {
    const browser = bind({ endpoint: OVERRIDE_ENDPOINT });
    expect(browser.credential).toBeNull();
    expect(browser.withheld).toBe("recipient-not-authorized");

    const environment = bind({ endpoint: OVERRIDE_ENDPOINT, credentialSource: "server-environment" });
    expect(environment.credential).toBeNull();
    expect(environment.withheld).toBe("recipient-not-authorized");
  });

  it("returns a browser-supplied key to an override the user authorized, and records the authorization", () => {
    const binding = bind({ endpoint: OVERRIDE_ENDPOINT, userAuthorizedDestination: true });

    expect(binding.credential).toBe(SYNTHETIC_KEY);
    expect(binding.withheld).toBeNull();
    expect(binding.connection.userAuthorizedDestination).toBe(true);
    expect(binding.connection.recipientOrigin).toBe(ATTACKER_ORIGIN);
  });

  it("attaches nothing for a call that carries no credential, whatever destination it names", () => {
    const registered = bind({ credential: null, credentialKind: "none", credentialSource: "none" });
    expect(registered.credential).toBeNull();
    expect(registered.withheld).toBeNull();

    const override = bind({
      endpoint: OVERRIDE_ENDPOINT,
      credential: null,
      credentialKind: "none",
      credentialSource: "none",
    });
    expect(override.credential).toBeNull();
    expect(override.withheld).toBeNull();
    expect(override.connection.recipientOrigin).toBe(ATTACKER_ORIGIN);

    const anonymous = anonymousConnection("openai", "catalog", `${OPENAI_ORIGIN}/v1/models`);
    expect(anonymous.credentialKind).toBe("none");
    expect(credentialAllowedFor(anonymous, `${OPENAI_ORIGIN}/v1/models`)).toBe(false);
  });

  it("attaches nothing for a revoked connection, not even at its own recipient", () => {
    const binding = bind({ revoked: true, credentialSource: "server-environment" });

    expect(binding.connection.revoked).toBe(true);
    expect(binding.credential).toBeNull();
    expect(binding.withheld).toBe("recipient-not-authorized");
    expect(credentialAllowedFor(binding.connection, OPENAI_ENDPOINT)).toBe(false);
    expect(redirectAllowedFor(binding.connection, OPENAI_ENDPOINT)).toBe(false);
  });

  it("keeps engine and partner-node scopes separate for the same Provider URL", () => {
    expect(PROVIDER_RECIPIENTS.comfy?.engine).toContain(COMFY_ORIGIN);
    expect(PROVIDER_RECIPIENTS.comfy?.["partner-node"]).toBeUndefined();
    expect(PROVIDER_RECIPIENTS.openai?.image).toContain(OPENAI_ORIGIN);

    const engine = comfyBind("engine", { credentialSource: "server-environment" });
    const partnerNode = comfyBind("partner-node", { credentialSource: "server-environment" });

    expect(engine.credential).toBe(SYNTHETIC_KEY);
    expect(engine.withheld).toBeNull();
    expect(engine.connection.connectionId).toBe(`comfy:engine:${COMFY_ORIGIN}`);

    expect(partnerNode.credential).toBeNull();
    expect(partnerNode.withheld).toBe("recipient-not-authorized");
    expect(partnerNode.connection.connectionId).not.toBe(engine.connection.connectionId);

    const authorizedPartnerNode = comfyBind("partner-node", {
      userAuthorizedDestination: true,
      credentialSource: "server-environment",
    });
    expect(authorizedPartnerNode.credential).toBeNull();
    expect(authorizedPartnerNode.withheld).toBe("source-not-authorized-for-destination");
  });

  it("permits a credential only at the recipient origin and the recorded redirect origins", () => {
    const { connection } = bind();

    expect(credentialAllowedFor(connection, OPENAI_ENDPOINT)).toBe(true);
    expect(credentialAllowedFor(connection, `${OPENAI_ORIGIN}:443/v1/models`)).toBe(true);
    expect(redirectAllowedFor(connection, OPENAI_ENDPOINT)).toBe(true);
    expect(credentialAllowedFor(connection, "https://evil-api.openai.com/v1/models")).toBe(false);
    expect(credentialAllowedFor(connection, `${OPENAI_ORIGIN}.attacker.example/v1`)).toBe(false);
    expect(credentialAllowedFor(connection, OVERRIDE_ENDPOINT)).toBe(false);
    expect(credentialAllowedFor(connection, "not a url")).toBe(false);
    expect(redirectAllowedFor(connection, OVERRIDE_ENDPOINT)).toBe(false);

    // A Provider CDN hop recorded on the connection is usable; any other host is not.
    const cdnOrigin = "https://cdn.openai.example";
    const withCdn: ProviderConnection = {
      ...connection,
      redirectOrigins: [connection.recipientOrigin, cdnOrigin],
    };
    expect(credentialAllowedFor(withCdn, `${cdnOrigin}/asset.png`)).toBe(true);
    expect(redirectAllowedFor(withCdn, `${cdnOrigin}/asset.png`)).toBe(true);
    expect(credentialAllowedFor(withCdn, "https://other.example/asset.png")).toBe(false);
    expect(redirectAllowedFor(withCdn, "https://other.example/asset.png")).toBe(false);
  });
});
