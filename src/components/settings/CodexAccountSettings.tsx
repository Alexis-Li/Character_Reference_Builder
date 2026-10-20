"use client";

import { useEffect, useRef, useState } from "react";
import type { BrowserSafeSessionView } from "@/lib/security/oauthSession.server";
import type { SelectedModel } from "@/types";

const STATUS: Record<string, string> = {
  unconfigured: "登录服务未配置", "logged-out": "未连接", "authorization-started": "等待服务商授权",
  "callback-received": "正在完成登录", "token-exchange-pending": "正在完成登录",
  authenticated: "账号已连接", "refresh-pending": "正在刷新授权", "re-authentication-required": "授权失效，请重新连接",
  revoked: "已本地断开", "account-switched": "已断开旧账号",
};
const FAILURES: Record<string, string> = {
  "callback-port-in-use": "本机登录回调端口 1455 被占用。请完成或取消其他应用的登录后重试，也可以选择设备码登录。",
  "browser-start-failed": "无法启动本机登录回调，请重试或选择设备码登录。",
  "authorization-denied": "服务商未批准本次授权，请重新连接。",
  "authorization-expired": "登录等待已过期，请重新连接。",
  "device-expired": "设备码已过期，请重新连接。",
  "device-start-failed": "无法获取设备码，请检查网络及账号的设备码登录设置，或使用浏览器登录。",
  "credential-save-failed": "无法安全保存登录，请检查本机凭据目录的权限和可用空间后重试。",
};

export function CodexAccountSettings({ onSelectModel }: { onSelectModel: (model: SelectedModel) => void }) {
  const [oauth, setOAuth] = useState<BrowserSafeSessionView | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState("");
  const revision = useRef(0);
  const pendingPopup = useRef<Window | null>(null);

  useEffect(() => {
    let active = true;
    const started = revision.current;
    fetch("/api/oauth").then(async response => {
      if (!response.ok) throw new Error("无法读取连接状态，请重试。");
      const result = await response.json();
      if (active && revision.current === started) { setOAuth(result.oauth); setAvailable(result.available); }
    }).catch(error => { if (active && revision.current === started) setMessage(error.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const pending = oauth?.device ?? oauth?.browser;
    if (!pending || busy) return;
    let active = true;
    const started = revision.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let retry = true;
      try {
        const response = await fetch("/api/oauth", oauth?.device ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "poll" }) } : undefined);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "授权状态查询失败，请取消后重试。");
        retry = Boolean(result.oauth?.device || result.oauth?.browser);
        if (active && revision.current === started) { setOAuth(result.oauth); setMessage(""); }
      } catch (error) { if (active && revision.current === started) setMessage(error instanceof Error ? error.message : "授权查询失败，正在重试；也可取消连接。"); }
      finally { if (retry && active && revision.current === started) timer = setTimeout(poll, pending.intervalMs); }
    };
    timer = setTimeout(poll, pending.intervalMs);
    return () => { active = false; clearTimeout(timer); };
  }, [oauth, busy]);

  async function act(action: string, method: "browser" | "device" = "browser") {
    const started = ++revision.current;
    setBusy(true); setMessage("");
    const opening = action === "start" || action === "switch";
    setStarting(opening);
    pendingPopup.current?.close();
    const popup = opening ? window.open("about:blank", "_blank") : null;
    pendingPopup.current = popup;
    if (popup) popup.opener = null;
    try {
      const response = await fetch("/api/oauth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(opening ? { method } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "账号操作失败，请重试。");
      if (revision.current !== started) { popup?.close(); return; }
      setOAuth(result.oauth);
      const authorizationUrl = result.oauth?.browser?.authorizationUrl ?? result.oauth?.device?.verificationUrl;
      if (popup && authorizationUrl) popup.location.href = authorizationUrl;
      else popup?.close();
      if (authorizationUrl && !popup) setMessage("浏览器阻止了新窗口，请点击下方授权页面链接继续登录。");
      if (action === "revoke") setMessage("已本地断开。服务商远端撤销未接入，远端授权状态未知；请在服务商账号安全设置检查授权。");
      if (action === "cancel") setMessage("已取消等待；不会继续轮询或保存迟到的授权。需要时可以重新连接。");
    } catch (error) { popup?.close(); if (revision.current === started) setMessage(error instanceof Error ? error.message : "连接失败"); }
    finally { if (revision.current === started) { setBusy(false); setStarting(false); } }
  }

  const connected = oauth?.state === "authenticated" || oauth?.state === "refresh-pending";
  const pending = oauth?.device || oauth?.browser;
  const button = "px-3 py-1.5 rounded bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-sm";
  return <section aria-label="ChatGPT/Codex 账号连接" className="p-3 bg-neutral-900 rounded-lg border border-neutral-700 space-y-3 text-neutral-100">
    <div className="flex items-center justify-between"><strong>ChatGPT/Codex · OAuth</strong><span role="status">{oauth ? STATUS[oauth.state] ?? oauth.state : "正在读取连接状态"}</span></div>
    {!available && oauth && <p className="text-sm text-amber-300">登录服务未配置，请重启应用后重试。</p>}
    {!connected && <p className="text-xs text-neutral-400">通过服务商页面登录和授权。确认后自动显示登录账号。</p>}
    {oauth?.account && <div className="text-sm space-y-1">
      <p>登录账号：{oauth.account.displayName}</p>
      <p>授权有效期：{oauth.expiresAt ? new Date(oauth.expiresAt).toLocaleString() : "未知"}</p>
    </div>}
    {oauth?.device && <div className="p-3 border border-neutral-600 rounded space-y-2">
      <p>在服务商页面输入设备码：<strong className="font-mono text-lg">{oauth.device.userCode}</strong></p>
      <button type="button" className={button} onClick={async () => {
        try { await navigator.clipboard.writeText(oauth.device!.userCode); setMessage("设备码已复制，请粘贴到服务商页面；确认后回到本应用查看账号。"); }
        catch { setMessage("无法访问剪贴板，请复制本页显示的设备码，再切换到服务商页面输入。"); }
      }}>复制设备码</button>
      <a className="underline" href={oauth.device.verificationUrl} target="_blank" rel="noopener noreferrer">打开服务商授权页面</a>
      <p className="text-xs">若服务商要求启用装置代码登入，请由本人在 <a className="underline" href="https://chatgpt.com/#settings/Security" target="_blank" rel="noopener noreferrer">ChatGPT 安全性设置</a> 开启后，重新获取设备码。无需运行其他应用的登录命令。</p>
      <p className="text-xs">有效期至 {new Date(oauth.device.expiresAt).toLocaleTimeString()}。确认后应用自动完成连接；拒绝或放弃授权时可取消并重试。</p>
      <button type="button" className={button} disabled={busy} onClick={() => act("cancel")}>取消连接</button>
    </div>}
    {oauth?.browser && <div className="p-3 border border-neutral-600 rounded space-y-2">
      <p>请在打开的服务商页面确认登录，完成后这里会自动显示账号。</p>
      <a className="underline" href={oauth.browser.authorizationUrl} target="_blank" rel="noopener noreferrer">打开浏览器授权页面</a>
      <p className="text-xs">有效期至 {new Date(oauth.browser.expiresAt).toLocaleTimeString()}。关闭授权页后也可以在此取消。</p>
      <button type="button" className={button} onClick={() => act("cancel")}>取消连接</button>
    </div>}
    {oauth?.failure && <p role="alert" className="text-sm text-amber-300">{FAILURES[oauth.failure] ?? "授权未完成或已失效，请检查服务商页面后重新连接。"} 当前项目、候选和已选结果已保留。</p>}
    {message && <p role="alert" className="text-sm text-amber-300">{message}</p>}
    {busy && starting && !pending && <button type="button" className={button} onClick={() => act("cancel")}>取消连接</button>}
    <div className="flex flex-wrap gap-2">
      {!pending && <><button type="button" className={button} disabled={busy || !available} onClick={() => act(connected ? "switch" : "start")}>{connected ? "切换账号" : "连接账号 / 重新连接"}</button>
        <button type="button" className={button} disabled={busy || !available} onClick={() => act(connected ? "switch" : "start", "device")}>使用设备码{connected ? "切换账号" : "登录"}</button></>}
      {oauth?.account && <><button type="button" className={button} disabled={busy} onClick={() => act("logout")}>退出账号</button>
        <button type="button" className={button} disabled={busy} onClick={() => act("revoke")}>本地断开并检查远端授权</button></>}
      {connected && <button type="button" className={button} onClick={() => {
        onSelectModel({ provider: "openai", modelId: "codex-image", displayName: "ChatGPT/Codex 图像", authChannel: "oauth" });
        setMessage("已选择为新建图像节点与单部件任务的默认入口；请保存设置。现有节点请重新选择或新建任务。");
      }}>设为图像任务默认入口</button>}
    </div>
  </section>;
}
