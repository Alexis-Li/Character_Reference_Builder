import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAccountSettings } from "../settings/CodexAccountSettings";
import { oauthCallConsent } from "@/lib/oauthCallConsent";

const base = { state: "logged-out", provider: "chatgpt-codex", account: null, scopes: [], scopesKnown: false, device: null };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("OAuth account settings", () => {
  it("opens the default browser flow and automatically reads the connected account without device input", async () => {
    const browser = { authorizationUrl: "https://auth.openai.com/oauth/authorize?state=synthetic", intervalMs: 5, expiresAt: Date.now() + 600_000 };
    const network = vi.fn().mockResolvedValueOnce(Response.json({ oauth: base, available: true }))
      .mockResolvedValueOnce(Response.json({ oauth: { ...base, state: "authorization-started", browser } }))
      .mockResolvedValueOnce(Response.json({ oauth: { ...base, state: "authenticated", account: { accountId: "synthetic", displayName: "Browser User" } } }));
    vi.stubGlobal("fetch", network);
    const popup = { opener: {}, location: { href: "about:blank" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    render(<CodexAccountSettings onSelectModel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "连接账号 / 重新连接" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "连接账号 / 重新连接" }));
    await screen.findByRole("link", { name: "打开浏览器授权页面" });
    expect(popup.location.href).toBe(browser.authorizationUrl);
    expect(JSON.parse(network.mock.calls[1][1].body)).toEqual({ action: "start", method: "browser" });
    await screen.findByText("账号：Browser User");
    expect(network.mock.calls[2][1]).toBeUndefined();
  });

  it("does not let a late status poll overwrite cancellation", async () => {
    const browser = { authorizationUrl: "https://auth.openai.com/oauth/authorize?state=synthetic", intervalMs: 5, expiresAt: Date.now() + 600_000 };
    let resolvePoll!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { resolvePoll = resolve; });
    const network = vi.fn().mockResolvedValueOnce(Response.json({ oauth: { ...base, state: "authorization-started", browser }, available: true }))
      .mockReturnValueOnce(pending).mockResolvedValueOnce(Response.json({ oauth: base }));
    vi.stubGlobal("fetch", network);
    render(<CodexAccountSettings onSelectModel={vi.fn()} />);
    await waitFor(() => expect(network).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
    await screen.findByText(/已取消等待/);
    await act(async () => { resolvePoll(Response.json({ oauth: { ...base, state: "authenticated", account: { displayName: "Old User" } } })); await pending; });
    expect(screen.queryByText("账号：Old User")).toBeNull();
    expect(screen.getByRole("button", { name: "连接账号 / 重新连接" })).toBeEnabled();
  });

  it("leaves a usable authorization link when a popup is blocked", async () => {
    const browser = { authorizationUrl: "https://auth.openai.com/oauth/authorize?state=synthetic", intervalMs: 60_000, expiresAt: Date.now() + 600_000 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ oauth: base, available: true }))
      .mockResolvedValueOnce(Response.json({ oauth: { ...base, state: "authorization-started", browser } })));
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<CodexAccountSettings onSelectModel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "连接账号 / 重新连接" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "连接账号 / 重新连接" }));
    await screen.findByText(/浏览器阻止了新窗口/);
    expect(screen.getByRole("link", { name: "打开浏览器授权页面" })).toHaveAttribute("href", browser.authorizationUrl);
  });

  it("reports a missing local login service without inventing a Provider refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ oauth: { ...base, state: "unconfigured" }, available: false })));
    render(<CodexAccountSettings onSelectModel={vi.fn()} />);
    await screen.findByText(/登录服务未配置，请重启应用/);
    expect(screen.getByRole("button", { name: "连接账号 / 重新连接" })).toBeDisabled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("opens the Provider page, displays only the user code, polls, and selects an explicit OAuth default", async () => {
    const device = { userCode: "SYNTH-CODE", verificationUrl: "https://auth.openai.com/codex/device", intervalMs: 5, expiresAt: Date.now() + 900_000 };
    const network = vi.fn().mockResolvedValueOnce(Response.json({ oauth: base, available: true }))
      .mockResolvedValueOnce(Response.json({ oauth: { ...base, state: "authorization-started", device } }))
      .mockResolvedValueOnce(Response.json({ oauth: { ...base, state: "authenticated", account: { accountId: "synthetic", displayName: "Synthetic User", workspaceId: "workspace" } } }));
    vi.stubGlobal("fetch", network);
    const popup = { opener: {}, location: { href: "about:blank" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const select = vi.fn();
    render(<CodexAccountSettings onSelectModel={select} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "连接账号 / 重新连接" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "连接账号 / 重新连接" }));
    await screen.findByText("SYNTH-CODE");
    expect(popup.location.href).toBe(device.verificationUrl);
    expect(popup.opener).toBeNull();
    await screen.findByText("账号：Synthetic User");
    expect(screen.getByText(/服务商未报告，未知/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设为图像任务默认入口" }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ modelId: "codex-image", authChannel: "oauth" }));
    expect(network.mock.calls.map(call => call[0])).toEqual(["/api/oauth", "/api/oauth", "/api/oauth"]);
  });

  it("cancels polling and reports local-only disconnection honestly", async () => {
    const device = { userCode: "SYNTH", verificationUrl: "https://auth.openai.com/codex/device", intervalMs: 60_000, expiresAt: Date.now() + 900_000 };
    const network = vi.fn().mockResolvedValueOnce(Response.json({ oauth: { ...base, state: "authorization-started", device }, available: true }))
      .mockResolvedValueOnce(Response.json({ oauth: base }));
    vi.stubGlobal("fetch", network);
    render(<CodexAccountSettings onSelectModel={vi.fn()} />);
    await screen.findByText("SYNTH");
    fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
    await screen.findByText(/已取消等待/);
    expect(screen.queryByText("SYNTH")).toBeNull();
    expect(JSON.parse(network.mock.calls[1][1].body).action).toBe("cancel");
  });

  it("does not acquire an operation grant when the user refuses external data/cost authorization", async () => {
    const network = vi.fn().mockResolvedValueOnce(Response.json({ oauth: { ...base, state: "authenticated", account: { accountId: "synthetic", displayName: "User", workspaceId: "workspace" } } }));
    vi.stubGlobal("fetch", network);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await expect(oauthCallConsent(3)).rejects.toThrow(/已取消/);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("3 张参考图"));
    expect(network).toHaveBeenCalledTimes(1);
  });
});
