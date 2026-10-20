# CRB-09 OAuth 社区复用与接入决策

核查日期：2026-10-20。范围只包含 #10 的登录、认证生命周期及产品图像调用接入。本轮使用固定源码、安装版本协议、合成凭据和 Windows 本机浏览器验证；没有登录真实账号、读取其他应用认证文件或发起真实生成。2026-10-05 的“独立 client ID 申请前置”判断已撤回，下文为当前决策。

## 固定来源与完整调用链

| 来源 | 固定版本与许可 | 已追踪的调用链 |
| --- | --- | --- |
| OMP / `can1357/oh-my-pi` | `4819e4f6d59049f307329d42b226b218582bdf38`，包声明 18.4.3，MIT | coding-agent 的 `commands/login.ts` / `cli/login-cli.ts` → session/AuthStorage → `registry/oauth/index.ts` 与 provider registry → `registry/oauth/openai-codex.ts` → 设备码启动、浏览器打开提示、轮询、授权码交换 → `auth-storage.ts` 的 `OAuthAccounts` → 凭据池；续期委派 `auth/refresh.ts` 的 `OAuthRefresher`。浏览器授权码路径另经 `callback-server.ts`、PKCE 与 catalog 授权规则。退出／移除由认证存储与账号操作处理。 |
| CC Switch / `farion1231/cc-switch` | `f678f7c539c90ed0e43872680b7f7162db5d0ef2`，MIT | `useCodexOauth.ts` → `useManagedAuth.ts` → `src/lib/api/auth.ts` → Tauri auth commands → `proxy/providers/codex_oauth_auth.rs` 的 `CodexOAuthManager` → start、打开外部页面、poll、exchange、保存、按账号锁刷新、remove/default 切换；前后端 generation 同时处理取消与迟到结果。 |

关键固定源码入口：

- OMP：[设备协议及账号解析](https://github.com/can1357/oh-my-pi/blob/4819e4f6d59049f307329d42b226b218582bdf38/packages/ai/src/registry/oauth/openai-codex.ts)、[回调服务器](https://github.com/can1357/oh-my-pi/blob/4819e4f6d59049f307329d42b226b218582bdf38/packages/ai/src/registry/oauth/callback-server.ts)、[AuthStorage](https://github.com/can1357/oh-my-pi/blob/4819e4f6d59049f307329d42b226b218582bdf38/packages/ai/src/auth-storage.ts)、[账号操作](https://github.com/can1357/oh-my-pi/blob/4819e4f6d59049f307329d42b226b218582bdf38/packages/ai/src/auth/oauth.ts)、[续期与竞态](https://github.com/can1357/oh-my-pi/blob/4819e4f6d59049f307329d42b226b218582bdf38/packages/ai/src/auth/refresh.ts)、[授权规则](https://github.com/can1357/oh-my-pi/blob/4819e4f6d59049f307329d42b226b218582bdf38/packages/catalog/src/compat/rules/auth/openai-codex.kdl)、[hosted 图像](https://github.com/can1357/oh-my-pi/blob/4819e4f6d59049f307329d42b226b218582bdf38/packages/ai/src/images/openai-hosted.ts)。
- CC Switch：[登录 hook](https://github.com/farion1231/cc-switch/blob/f678f7c539c90ed0e43872680b7f7162db5d0ef2/src/components/providers/forms/hooks/useManagedAuth.ts)、[Codex manager 与测试](https://github.com/farion1231/cc-switch/blob/f678f7c539c90ed0e43872680b7f7162db5d0ef2/src-tauri/src/proxy/providers/codex_oauth_auth.rs)。测试检查包含同 workspace 不同用户、取消时等待账号锁、过期提交、旧 generation、原子保存失败和刷新代次。

已阅读这些路径的实现及相关测试；没有运行上游 Bun、Rust/Tauri 套件。上游用例用于确定 CRB 回归输入，其存在不算本产品验证通过。上游设备响应与轮询错误是 Codex 专用协议，不能把它当作通用 RFC 8628 实现；邮箱和 workspace 也不能单独充当用户身份。

## 采用方案与差异

| 方案 | 兼容性及维护成本 | 决定 |
| --- | --- | --- |
| 直接依赖 OMP 或 CC Switch 的完整认证模块 | OMP 依赖 Bun、内部 catalog/utils/native、凭据池及 SQLite；CC Switch 依赖 Rust/Tauri 和 Codex live auth 文件。会带入另一套会话、凭据与恢复策略。 | 不整体引入。 |
| 抽取 OMP 浏览器／设备协议与 hosted-image 映射，适配现有 Node 边界 | 维护认证与图像协议；fetch、取消、令牌写入和会话归属接回 CRB，允许固定来源对照升级。 | 采用。默认浏览器授权，设备码由用户明确选择。 |
| 官方 Codex App Server | 本机安装 `codex-cli 0.163.0`，已运行版本及 `app-server generate-ts` 检查。实际生成的 v2 类型包含 `chatgpt`、`chatgptDeviceCode`、按 loginId 取消、账号读取、退出和外部托管令牌；账号读取只返回摘要，不导出 refresh token。托管登录会引入其凭据保存／刷新归属，外部令牌模式仍需 CRB 自己取得和刷新令牌。 | 本轮不把 App Server 作为认证宿主，以维持唯一适配器和现有 Windows DPAPI 合约；未来实际模型调用需要时可评估其外部令牌模式。未启动其登录或读取其认证文件。 |
| 仅照流程重新开发整个 Login | 重复维护已有协议细节，另起状态机。 | 只编写浏览器／Next.js 衔接，沿用现有唯一 `OAuthSessionAdapter`。 |

抽取适配位于 `src/lib/security/codexOAuth.server.ts` 和 `src/app/api/generate/providers/openaiOAuth.ts`，文件头保留固定来源及 MIT 声明，完整许可见 [OMP MIT](../../licenses/oh-my-pi-MIT.txt)。登录交互和生命周期用例参考 CC Switch，许可保留在 [CC Switch MIT](../../licenses/cc-switch-MIT.txt)；未搬入其 Rust 后端或第三方认证文件管理逻辑。

CRB 的必要差异：一个活动账号、显式切换；服务端拥有浏览器／设备事务与可复用令牌；用户主体与 workspace 组成账号身份；本机会话绑定、过期、取消、旧回调／刷新失效和串行凭据写入继续由现有 `OAuthSessionAdapter` 负责。默认浏览器路径先绑定 `127.0.0.1:1455/auth/callback`，再返回一次性 state／PKCE 授权 URL；回调不依赖跨端口 Cookie，使用服务端保存的发起会话与 state 绑定，仅原发起会话可读取待完成链接。HTTP 传输只负责固定 Host／路径／方法、静态无敏感响应和监听器清理，没有第二套账号状态。成功、拒绝、取消、十分钟超时和退出均释放监听器；端口占用如实报告，用户可明确选择设备码。Next.js 的路由及热重载共享进程内适配器和刷新锁。

不导入 OMP 的自动账号轮换、业务请求重放或 auth recovery；不读取浏览器 Cookie、Codex auth.json 或 OMP/CC Switch 凭据。持久存储位于本应用私有目录，Windows 使用 CurrentUser DPAPI，POSIX 使用 0700 目录／0600 文件。Windows 同用户加密保存及应用跨进程重启已用合成凭据验证；跨 Windows 用户不可解密仍待独立用户上下文验证，不能由同用户结果外推。

## 具体 Provider 与权限事实

选择 ChatGPT/Codex 原生浏览器授权作为默认接入，保留设备码；下列地址由固定社区实现、官方 Codex [设备实现](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/codex-rs/login/src/device_code_auth.rs)及与安装版本一致的 [0.163.0 浏览器实现](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/server.rs)核查。后者实际使用 IPv4 回环 redirect URI，因此 CRB 无需声明 localhost 的双栈监听。官方源码只作协议核对，不引入其代码。

| 用途 | 固定接收方 |
| --- | --- |
| 浏览器授权 | `https://auth.openai.com/oauth/authorize` |
| 本机浏览器回调 | `http://127.0.0.1:1455/auth/callback`（只在一次登录期间监听） |
| 用户登录／授权页面 | `https://auth.openai.com/codex/device` |
| 设备启动 | `https://auth.openai.com/api/accounts/deviceauth/usercode` |
| 设备轮询 | `https://auth.openai.com/api/accounts/deviceauth/token` |
| token 交换／刷新 | `https://auth.openai.com/oauth/token` |
| 设备交换 redirect URI | `https://auth.openai.com/deviceauth/callback`（Provider 内部页面，不是本机回调） |
| 图像工具请求 | `https://chatgpt.com/backend-api/codex/responses` |

所有地址为服务端固定值，禁止携密重定向；浏览器不得传入认证端点或 bearer。浏览器请求最小 `openid profile email offline_access`，保留上游组织摘要／简化登录参数，originator 标识为 `character_reference_builder`，不照搬 connector 权限。设备启动仅发送 client identity。token 响应若不报告 `scope`，实际权限显示未知，不能以请求参数或订阅名称替代。刷新响应不报告 `expires_in` 时由固定 HTTPS 响应内 access JWT 的 `exp` 确定有效期。账号／组织须允许所选 Codex 登录方式；图像工具、模型、额度、费用分别验证。

两个社区快照使用同一 Codex 原生公共 client ID `app_EMoamEEZ73f0CkXaXp7hrann`；CRB 现在默认内置，`CRB_CODEX_OAUTH_CLIENT_ID` 只保留为兼容部署覆盖项。普通用户不申请独立客户端。MIT 源码许可与服务使用条件分别判断：2026-10-20 读取的[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server#authentication-endpoints)明确说明本地／开源应用可继续使用其认证，而商业或托管服务不在该允许范围，推荐迁移至另行注册的 Sign in with ChatGPT。该说明支持本项目本机集成方向；它不是对抽取协议或所有图像用途的独立法律保证。未来商业／托管产品须重新核对路线，不能复用本次结论。此前将另一商业接入的注册条件套用为当前登录前置，没有真实拒绝证据，已撤回。没有向支持发送消息。

Windows 本机实测 DNS 将 `auth.openai.com` 映射到 `198.18.x.x`，原出站策略在交换前拒绝。按 [Mihomo Fake-IP 文档](https://wiki.metacubex.one/en/config/dns/)和 [Node TLS 合约](https://nodejs.org/download/release/latest-v24.x/docs/api/tls.html#tlscheckserveridentityhostname-cert)，新增严格限定的兼容：仅三个固定 HTTPS 认证 POST、固定 Provider／role／端点、零重定向允许 IPv4 `198.18/15`；TLS 校验被关闭时仍拒绝。没有放行私网、回环、元数据、其他保留地址、媒体、用户 URL 或其他 Provider。实际不含账号的 TLS 握手验证通过（TLS 1.3）；这不能证明真实 token 交换或图像访问通过。

## 图像调用与用户路径

设置 → Providers → ChatGPT/Codex 连接 → 服务商浏览器确认 → 本机回调／交换（或用户明确选择设备码后自动轮询）→ 账号／workspace／实际权限摘要 → 设为图像任务默认入口并保存 → 新建图像节点或单部件任务 → 逐次确认 → 服务端取令牌发送图像工具请求。登录本身不会生成。

沿用 OMP 的 Responses、按序 `input_image`、`image_generation` 和 SSE 输出映射，删除旧 multipart `/codex/images/edits` 与请求头 bearer 入口。逻辑入口为 `codex-image`，载体模型固定 `gpt-5.4`，实际图像工具模型仅在响应报告后记录；不能把载体名称当作实际图像模型。参考用途标签和 CRB 提示词保持顺序，系统指令优先保留原设计及已有视图，替换上游偏美化的默认描述。

OAuth 能力与 API Key 分开：最多三张参考、单张 7 MB／合计 20 MB 是本应用保守限制，尚未验证效果；不声明精确 Mask 支持，不继承 API Key 模型参数或价格。有效 SSE 终态和可解码 WebP 才算成功。已提交后断流按结果未知处理，费用仍未知，不自动换号或重发；失败和取消保留现有候选、选择、保存及导出路径。

历史云端结果和当前 Windows 证据见[安全准入验证](../validation/security-gate-issue-10.md)。#10 保持打开；真实浏览器账号、订阅／图像调用以及跨 Windows 用户隔离分别待验收，不再以用户申请客户端作为前置。
