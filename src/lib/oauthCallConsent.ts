/** Request-specific consent; no Provider token is ever returned to the page. */
export async function oauthCallConsent(referenceCount: number): Promise<string> {
  const status = await fetch("/api/oauth", { headers: { Accept: "application/json" } });
  if (!status.ok) throw new Error("无法读取账号，请重新打开服务商设置。");
  const { oauth } = await status.json();
  if (!oauth?.account || !["authenticated", "refresh-pending"].includes(oauth.state)) {
    throw new Error("请先在服务商设置中连接 ChatGPT/Codex 账号。");
  }
  if (!window.confirm(`本次调用使用 ChatGPT/Codex 账号 ${oauth.account.displayName}（工作区 ${oauth.account.workspaceId ?? "未知"}）。\n将向服务商发送提示词和 ${referenceCount} 张参考图。额度与费用未知，图像工具能力尚待实际验证。\n是否授权本次资料外发与可能的费用？`)) {
    throw new Error("已取消本次调用，当前项目与已选结果已保留。");
  }
  const response = await fetch("/api/oauth", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm-call", accountId: oauth.account.accountId, allowExternalData: true, allowUnknownCost: true }) });
  const result = await response.json();
  if (!response.ok || typeof result.grant !== "string") throw new Error(result.error ?? "账号已改变，请重新确认。");
  return result.grant;
}
