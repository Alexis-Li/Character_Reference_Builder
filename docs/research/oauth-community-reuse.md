# CRB-09 OAuth 社区复用与接入决策

核查日期：2026-10-05。范围只包含 #10 的登录、认证生命周期及产品图像调用接入。本轮使用源码、合成凭据和本机浏览器验证；没有登录真实账号、读取其他应用认证文件或发起真实生成。

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
| 抽取 OMP 协议与 hosted-image 映射，适配现有 Node 边界 | 维护范围是两个协议模块；fetch、取消、令牌写入和会话归属接回 CRB，允许固定来源对照升级。 | 采用。 |
| 仅照流程重新开发整个 Login | 重复维护已有协议细节，另起状态机。 | 只编写浏览器／Next.js 衔接，沿用现有唯一 `OAuthSessionAdapter`。 |

抽取适配位于 `src/lib/security/codexOAuth.server.ts` 和 `src/app/api/generate/providers/openaiOAuth.ts`，文件头保留固定来源及 MIT 声明，完整许可见 [OMP MIT](../../licenses/oh-my-pi-MIT.txt)。登录交互和生命周期用例参考 CC Switch，许可保留在 [CC Switch MIT](../../licenses/cc-switch-MIT.txt)；未搬入其 Rust 后端或第三方认证文件管理逻辑。

CRB 的必要差异：一个活动账号、显式切换；服务端拥有设备事务与可复用令牌；用户主体与 workspace 组成账号身份；本机会话绑定、过期、取消、旧回调／刷新失效和串行凭据写入继续由现有适配器负责。生产没有新增授权码监听器，原有 PKCE 分支继续用于协议回归。设备码路径不占用 1455 端口，因此回调端口冲突不适用于此生产路径；以后提供授权码入口时仍须单独验收。

不导入 OMP 的自动账号轮换、业务请求重放或 auth recovery；不读取浏览器 Cookie、Codex auth.json 或 OMP/CC Switch 凭据。持久存储从可清理 runtime 迁至本应用私有目录，Windows 使用 CurrentUser DPAPI，POSIX 使用 0700 目录／0600 文件。Windows 实机保护机制仍待验收，不能用 Linux 文件模式替代。

## 具体 Provider 与权限事实

选择 ChatGPT/Codex 设备授权作为首个生产接入目标；下列地址已由两个固定社区实现和官方 Codex [设备实现](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/codex-rs/login/src/device_code_auth.rs)交叉核查。官方快照只作协议核对，不引入其代码。

| 用途 | 固定接收方 |
| --- | --- |
| 用户登录／授权页面 | `https://auth.openai.com/codex/device` |
| 设备启动 | `https://auth.openai.com/api/accounts/deviceauth/usercode` |
| 设备轮询 | `https://auth.openai.com/api/accounts/deviceauth/token` |
| token 交换／刷新 | `https://auth.openai.com/oauth/token` |
| 设备交换 redirect URI | `https://auth.openai.com/deviceauth/callback`（Provider 内部页面，不是本机回调） |
| 图像工具请求 | `https://chatgpt.com/backend-api/codex/responses` |

所有地址为服务端固定值，禁止携密重定向；浏览器不得传入认证端点或 bearer。设备启动仅发送 client identity；不照搬 OMP 浏览器授权的 connector 权限。token 响应若不报告 `scope`，实际权限显示未知，不能以请求参数或订阅名称替代。账号／组织还须允许 Codex device login 和 hosted image tool；实际图像模型、额度、费用和可用性没有实测证据。

两个社区快照使用 `app_EMoamEEZ73f0CkXaXp7hrann`。MIT 授予源码使用权，不能证明该客户端身份允许 CRB 使用。所查社区与官方源码没有提供 CRB 客户端注册成功或获准复用的证据，也未发现可据此承诺的第三方自助注册入口。因此没有内置这个身份；生产仅在服务商允许的客户端身份通过 `CRB_CODEX_OAUTH_CLIENT_ID` 提供后启用连接。此变量是部署接入条件，普通用户不应逐项填写协议参数。未就绪时 UI 显示具体原因，路由返回 `client-registration-required`，不发请求。

下一步接入调查仍由实现方承担。可向 [OpenAI 支持入口](https://help.openai.com/)提交以下已备妥的询问；仅在支持要求账号所有者／管理员操作时由本人执行。不宣称支持一定能注册，也不擅自发送支持消息。

> 应用：Character Reference Builder，本机 Node.js/Next.js 角色／服装建模参考工具，仓库 https://github.com/Alexis-Li/Character_Reference_Builder 。拟由用户亲自确认设备授权，服务端私有保存及刷新令牌，经逐次资料外发／费用确认后调用 Codex Responses 的 image_generation；无凭据导入、账号轮换或自动重放。请确认是否允许此第三方产品接入，能否签发本应用专属 client ID 或明确授权使用已有公开身份，以及 device login、上述固定交换 redirect URI、hosted image tool 所需的最小权限、账号／workspace 条件和撤销方式。现有 client ID 为 Codex 上游身份，本应用尚未使用。

若 Provider 明确不开放此用途，记录拒绝及图像能力缺口，再评估符合产品需求的授权方案，不能用 API Key 或普通聊天成功冒充 OAuth 图像验收。

## 图像调用与用户路径

设置 → Providers → ChatGPT/Codex 连接 → 新页面输入设备码 → 服务端自动轮询与交换 → 账号／workspace／实际权限摘要 → 设为图像任务默认入口并保存 → 新建图像节点或单部件任务 → 逐次确认 → 服务端取令牌发送图像工具请求。登录本身不会生成。

沿用 OMP 的 Responses、按序 `input_image`、`image_generation` 和 SSE 输出映射，删除旧 multipart `/codex/images/edits` 与请求头 bearer 入口。逻辑入口为 `codex-image`，载体模型固定 `gpt-5.4`，实际图像工具模型仅在响应报告后记录；不能把载体名称当作实际图像模型。参考用途标签和 CRB 提示词保持顺序，系统指令优先保留原设计及已有视图，替换上游偏美化的默认描述。

OAuth 能力与 API Key 分开：最多三张参考、单张 7 MB／合计 20 MB 是本应用保守限制，尚未验证效果；不声明精确 Mask 支持，不继承 API Key 模型参数或价格。有效 SSE 终态和可解码 WebP 才算成功。已提交后断流按结果未知处理，费用仍未知，不自动换号或重发；失败和取消保留现有候选、选择、保存及导出路径。

云端结果与剩余验收详见 [安全准入验证第 13 节](../validation/security-gate-issue-10.md#13-2026-10-05-云端产品接入验证)。#10 保持打开，真实端到端验收仍须在客户端许可确认后由用户控制完成。
