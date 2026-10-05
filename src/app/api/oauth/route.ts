import { NextResponse } from "next/server";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";
import { oauthSession, accountSummaryOf } from "@/lib/security/oauthSession.server";
import { attachAccountSummary } from "@/lib/security/localSession.server";

export const dynamic = "force-dynamic";

export const GET = withPrivilegedApi(["auth-state-change", "local-file-read"], async (_request, { session }) => {
  const adapter = oauthSession();
  await adapter.restore();
  const oauth = adapter.viewForSession(session.sessionId);
  if (oauth.account) attachAccountSummary(session.sessionId, accountSummaryOf(oauth.account));
  return NextResponse.json({ success: true, oauth, available: Boolean(adapter.providerTarget),
    capability: "image_generation", capabilityStatus: "unverified", quota: "unknown", cost: "unknown", remoteRevocation: "unsupported" }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = withPrivilegedApi(["auth-state-change", "cloud-request", "local-file-read", "local-file-write"], async (request, { session }) => {
  const adapter = oauthSession();
  await adapter.restore();
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ success: false }, { status: 400 });
  const action = body.action;
  try {
    if (action === "start" || action === "switch") {
      if (!adapter.providerTarget) return NextResponse.json({ success: false, reason: "client-registration-required", error: "该服务商尚未向本应用开放授权，当前无法连接。接入状态与后续操作见登录验证记录。" }, { status: 409 });
      // Keep this initiating capability usable; older account-bound pages are revoked.
      attachAccountSummary(session.sessionId, null);
      await adapter.startDeviceAuthorization(session.sessionId);
    } else if (action === "poll") {
      await adapter.pollDeviceAuthorization(session.sessionId);
    } else if (action === "cancel" || action === "logout") {
      attachAccountSummary(session.sessionId, null);
      await adapter.logout();
    } else if (action === "revoke") {
      attachAccountSummary(session.sessionId, null);
      const result = await adapter.revoke();
      return NextResponse.json({ success: result.ok, oauth: adapter.browserView(), remote: result.ok ? result.remote : "unknown" }, { headers: { "Cache-Control": "no-store" } });
    } else if (action === "confirm-call") {
      if (body.allowExternalData !== true || body.allowUnknownCost !== true || typeof body.accountId !== "string") {
        return NextResponse.json({ success: false, error: "请确认本次资料外发与未知费用。" }, { status: 400 });
      }
      const grant = adapter.createCallGrant(session.sessionId, body.accountId);
      if (!grant) return NextResponse.json({ success: false, error: "账号状态已改变，请重新连接或确认。" }, { status: 409 });
      return NextResponse.json({ success: true, grant }, { headers: { "Cache-Control": "no-store" } });
    } else return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
    const oauth = adapter.viewForSession(session.sessionId);
    if (oauth.account) attachAccountSummary(session.sessionId, accountSummaryOf(oauth.account));
    return NextResponse.json({ success: true, oauth }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ success: false, error: "账号操作失败，请重试；当前项目和已选结果已保留。" }, { status: 500 });
  }
});
