"use client";

import { useEffect, useState } from "react";
import type { BrowserSafeSessionView } from "@/lib/security/oauthSession.server";
import type { SelectedModel } from "@/types";

const STATUS: Record<string, string> = {
  unconfigured: "尚未开放连接", "logged-out": "未连接", "authorization-started": "等待服务商授权",
  authenticated: "账号已连接", "refresh-pending": "正在刷新授权", "re-authentication-required": "授权失效，请重新连接",
  revoked: "已本地断开", "account-switched": "已断开旧账号",
};

export function CodexAccountSettings({ onSelectModel }: { onSelectModel: (model: SelectedModel) => void }) {
  const [oauth, setOAuth] = useState<BrowserSafeSessionView | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/oauth").then(async response => {
      if (!response.ok) throw new Error("无法读取连接状态，请重试。");
      const result = await response.json();
      if (active) { setOAuth(result.oauth); setAvailable(result.available); }
    }).catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!oauth?.device) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/oauth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "poll" }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "授权状态查询失败，请取消后重试。");
        if (active) setOAuth(result.oauth);
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : "授权查询失败"); }
    }, oauth.device.intervalMs);
    return () => { active = false; clearTimeout(timer); };
  }, [oauth]);

  async function act(action: string) {
    setBusy(true); setMessage("");
    const opening = action === "start" || action === "switch";
    const popup = opening ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    try {
      const response = await fetch("/api/oauth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "账号操作失败，请重试。");
      setOAuth(result.oauth);
      if (popup && result.oauth?.device) popup.location.href = result.oauth.device.verificationUrl;
      else popup?.close();
      if (action === "revoke") setMessage("已本地断开。服务商远端撤销未接入，远端授权状态未知；请在服务商账号安全设置检查授权。");
      if (action === "cancel") setMessage("已取消等待；不会继续轮询或保存迟到的授权。需要时可以重新连接。");
    } catch (error) { popup?.close(); setMessage(error instanceof Error ? error.message : "连接失败"); }
    finally { setBusy(false); }
  }

  const connected = oauth?.state === "authenticated" || oauth?.state === "refresh-pending";
  const button = "px-3 py-1.5 rounded bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-sm";
  return <section aria-label="ChatGPT/Codex 账号连接" className="p-3 bg-neutral-900 rounded-lg border border-neutral-700 space-y-3 text-neutral-100">
    <div className="flex items-center justify-between"><strong>ChatGPT/Codex · OAuth</strong><span role="status">{oauth ? STATUS[oauth.state] ?? oauth.state : "正在读取连接状态"}</span></div>
    {!available && oauth && <p className="text-sm text-amber-300">该服务商尚未向本应用开放授权，当前无法连接。接入所需的客户端身份许可仍待确认。</p>}
    <p className="text-xs text-neutral-400">通过服务商页面登录和授权。可使用该浏览器已有登录状态，服务商也可能要求重新验证。连接账号不会自动生成图片。</p>
    {oauth?.account && <div className="text-sm space-y-1">
      <p>账号：{oauth.account.displayName}</p><p>工作区：{oauth.account.workspaceId ?? "未提供"}</p>
      <p>实际授权范围：{oauth.scopesKnown ? oauth.scopes.join("、") || "服务商报告为空" : "服务商未报告，未知"}</p>
      <p>授权有效期：{oauth.expiresAt ? new Date(oauth.expiresAt).toLocaleString() : "未知"}；调用前自动续期。</p>
    </div>}
    <p className="text-xs text-neutral-400">图像工具：待实际验收；额度：未知；费用：未知。支持最多三张参考图的生成／优化协议，暂不支持精确 Mask 编辑。每次调用会单独确认资料外发及可能的费用。</p>
    {oauth?.device && <div className="p-3 border border-neutral-600 rounded space-y-2">
      <p>在服务商页面输入设备码：<strong className="font-mono text-lg">{oauth.device.userCode}</strong></p>
      <a className="underline" href={oauth.device.verificationUrl} target="_blank" rel="noopener noreferrer">打开服务商授权页面</a>
      <p className="text-xs">有效期至 {new Date(oauth.device.expiresAt).toLocaleTimeString()}。确认后应用自动完成连接；拒绝或放弃授权时可取消并重试。</p>
      <button type="button" className={button} disabled={busy} onClick={() => act("cancel")}>取消连接</button>
    </div>}
    {oauth?.failure && <p role="alert" className="text-sm text-amber-300">{oauth.failure === "device-expired" ? "设备码已过期，请重新连接。" : "授权未完成或已失效，请检查服务商页面后重新连接。"} 当前项目、候选和已选结果已保留。</p>}
    {message && <p role="alert" className="text-sm text-amber-300">{message}</p>}
    <div className="flex flex-wrap gap-2">
      {!oauth?.device && <button type="button" className={button} disabled={busy || !available} onClick={() => act(connected ? "switch" : "start")}>{connected ? "切换账号" : "连接账号 / 重新连接"}</button>}
      {oauth?.account && <><button type="button" className={button} disabled={busy} onClick={() => act("logout")}>退出账号</button>
        <button type="button" className={button} disabled={busy} onClick={() => act("revoke")}>本地断开并检查远端授权</button></>}
      {connected && <button type="button" className={button} onClick={() => {
        onSelectModel({ provider: "openai", modelId: "codex-image", displayName: "ChatGPT/Codex 图像", authChannel: "oauth" });
        setMessage("已选择为新建图像节点与单部件任务的默认入口；请保存设置。现有节点请重新选择或新建任务。");
      }}>设为图像任务默认入口</button>}
    </div>
  </section>;
}
