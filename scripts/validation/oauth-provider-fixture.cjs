// Explicit Node preload for the managed synthetic browser check ONLY.
// This file is never imported by the application or selected by product config.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
assert.equal(process.env.CRB_SYNTHETIC_OAUTH_VALIDATION, "1", "Use oauth-ui.cjs to launch this fixture");
assert.ok(path.basename(process.env.CRB_CREDENTIAL_DIRECTORY || "").startsWith("crb-oauth-synthetic-"), "Refuse a real credential directory");
const nativeFetch = global.fetch;
const jwt = claims => `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic`;
const client = "app_EMoamEEZ73f0CkXaXp7hrann";
let user = "one", polls = 0;
const token = () => {
  const claims = { iss: "https://auth.openai.com", aud: client, sub: `synthetic-${user}`, email: `synthetic-${user}@example.invalid`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-workspace", chatgpt_user_id: `synthetic-${user}` } };
  // oauth-ui stops the first process before entering the renewal window.
  return { access_token: jwt(claims), id_token: jwt(claims), refresh_token: `synthetic-refresh-${user}`, expires_in: 60, scope: "openid profile email offline_access" };
};
global.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return nativeFetch(input, init);
  if (url.origin !== "https://auth.openai.com" || init?.method !== "POST") throw new Error("Synthetic validation blocked an external request");
  if (url.pathname === "/api/accounts/deviceauth/usercode") {
    polls = 0;
    return Response.json({ device_auth_id: "synthetic-device-private", user_code: "CRB-SYNTH", interval: 1, expires_in: 900 });
  }
  if (url.pathname === "/api/accounts/deviceauth/token") {
    if (++polls < 2) return new Response(null, { status: 403 });
    return Response.json({ authorization_code: "synthetic-code-device", code_verifier: "synthetic-device-verifier" });
  }
  if (url.pathname === "/oauth/token") {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("client_id"), client);
    if (body.get("grant_type") === "authorization_code") {
      assert.match(body.get("code"), /^synthetic-code-(one|two|device)$/);
      assert.ok(body.get("code_verifier"));
      if (body.get("code") !== "synthetic-code-device") user = body.get("code").slice("synthetic-code-".length);
      return Response.json(token());
    }
    if (body.get("grant_type") === "refresh_token") {
      assert.match(body.get("refresh_token"), /^synthetic-refresh-(one|two)$/);
      user = body.get("refresh_token").slice("synthetic-refresh-".length);
      assert.ok(process.env.CRB_SYNTHETIC_REFRESH_AUDIT && process.env.CRB_SYNTHETIC_SERVER_GENERATION);
      fs.appendFileSync(process.env.CRB_SYNTHETIC_REFRESH_AUDIT, JSON.stringify({ generation: process.env.CRB_SYNTHETIC_SERVER_GENERATION, event: "refresh" }) + "\n");
      return Response.json({ ...token(), expires_in: 3600, refresh_token: `synthetic-refresh-${user}-rotated` });
    }
  }
  throw new Error("Unexpected synthetic authentication request");
};
