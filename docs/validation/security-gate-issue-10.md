# CRB-09 本机 API 与真实 OAuth 登录安全边界验证

最新验证日期：2026-10-20。范围为 Issue #10 指定的安全准入及 OAuth 产品接入。第 2–15 节保留对应基线的历史实现与证据；当前状态以第 17 节为准。第 13 节的“先申请客户端许可”结论已撤回，不能继续作为登录前置；历史实验 bearer 开关已删除。自动回归使用合成凭据；另有本人控制的真实登录、刷新及三次分别获准的真实图像请求：前两次 HTTP 400，原生 JSON 修复后一次成功，费用仍未知。

## 1. 结论

| 准入项 | 结果 | 依据 |
| --- | --- | --- |
| 本机特权请求边界（调用方认证、Host／Origin／媒体类型／nonce） | **pass** | 第 2、7 节 |
| Provider 接收方与凭据绑定（含 Comfy 引擎与 partner 节点分流） | **pass** | 第 3、7 节 |
| 媒体下载、活动内容与写入范围隔离 | **pass** | 第 4、7 节 |
| OAuth 会话适配器协议行为（授权码 + PKCE S256、一次性 state、刷新、退出、撤销、切换） | **pass**（合成提供方） | 第 5、7 节 |
| 凭据保密（项目、模板、导出、日志、错误、控制台） | **pass** | 第 6、7 节 |
| Codex 浏览器 PKCE／可选设备码、设置入口、恢复与图像调用集成 | **pass**（合成凭据；本轮 Windows 浏览器覆盖登录及生命周期，图像调用保持合成回归） | 第 13–14 节 |
| Windows 启动器、DPAPI 同用户保存、跨进程恢复及跨用户不可解密 | **pass**；跨用户使用一次性 GitHub Windows VM 和合成凭据 | 第 16 节 |
| 真实 OAuth 浏览器／设备码登录、刷新及本地退出 | **已验收所记录范围**；直接账号切换按本人新要求移出产品范围 | 第 15–17 节 |
| 真实图像能力调用 | **本次两参考路径 pass**：真实生成、选择、保存重开及导出通过；费用未知 | 第 16 节 |

**总判定：登录实现及合成验证已交付，真实账号与整项准入尚未闭环，#10 保持打开。** 默认入口直接打开 Codex 服务商浏览器授权，支持可选设备码、持久恢复、自动刷新和取消／退出／切换；不要求普通用户申请独立 client ID。Windows 合成浏览器验证通过不等于 Plus 账号、订阅调用或图像能力通过。Issue #8 的质量与费用矩阵未执行。

## 2. 本机特权请求边界

所有 30 个 `src/app/api/**/route.ts` 路由都在同一调用方认证入口之后：唯一例外是会话引导端点（它用于签发能力，本身仍校验回环 Host 与同源证据），并在覆盖测试中显式登记。

- 浏览器调用必须携带应用自身签发、绑定来源的本机会话能力（HttpOnly、SameSite=Strict cookie），状态变动请求另带一次性 `x-crb-request-nonce`，并声明 `application/json`；无法证明无请求体的写请求一律拒绝。nonce 在会话存活期内不去重淘汰（存满即拒绝），客户端遇到 `duplicate-request-nonce` 会以新 nonce 重试一次。
- 固定回环 Host；`Origin: null`、跨站 `Sec-Fetch-Site`、外部 Origin、跨主机名能力一律拒绝。
- 脚本／自动化使用独立 CLI 凭据（`Authorization: Bearer`，令牌位于仓库外、仅本用户可读），不复用浏览器会话能力，也不在浏览器路径上开设例外。
- 守卫在路由处理体之前运行；拒绝先于凭据解析、文件系统变更、可配置后端访问与认证状态变更。
- 结果契约包含调用方身份（sessionId、requestClass、绑定来源、非秘密账号摘要）与稳定的拒绝原因（`unexpected-host`、`unexpected-origin`、`null-origin`、`missing-origin`、`missing-capability`、`invalid-capability`、`expired-capability`、`revoked-capability`、`invalid-content-type`、`missing-request-nonce`、`invalid-request-nonce`、`duplicate-request-nonce`、`invalid-cli-credential`）。

## 3. Provider 接收方与凭据绑定

- 连接记录包含 Provider、角色、接收方 origin、协议、凭据来源、授权范围、有效期与撤销状态；同一 Provider 的引擎凭据与 partner 节点凭据是两条独立连接，不相互回退。
- 请求指定的接收方不继承服务器环境凭据：环境凭据只发送到已登记接收方；请求指定的目标只有在同时携带自己的凭据（用户显式授权）时才可用于该目标，否则凭据被扣留并记录原因。
- Provider 返回的 URL（fal 的 `status_url`/`response_url`、WaveSpeed 的 poll URL、Replicate 分页 `next`）在跟随前必须属于该连接的接收方，否则停止而不是带着凭据跟随。
- 携密请求使用 `redirect: "manual"`，跨源重定向按拒绝处理而不是转发凭据。
- Comfy：请求指定的引擎地址不再继承 `COMFY_API_KEY`；partner/org 凭据只来自其自身来源，不再回退到引擎密钥；引擎调用经逐跳地址校验，用户声明的本地/局域网引擎只放行回环、私有、ULA 与 CGNAT 地址，云元数据、链路本地、组播与保留地址始终拒绝（无论请求如何声明模式或携带何种密钥）；明文只允许出现在该本地/局域网引擎路径，Provider 连接一律要求加密。Comfy SDK 自带传输层无法被本边界管辖，因此只用于已登记的 Comfy Cloud 接收方；其余引擎（含请求自带密钥授权的 HTTPS 目标）走受策略控制、逐跳校验且拒绝重定向的引擎路径。

## 4. 媒体、活动内容与写入范围

- Provider 输出与导入的远程媒体统一经过同一媒体下载入口：逐跳校验协议、解析地址与授权来源，回环、RFC1918、链路本地、CGNAT、组播、保留段与云元数据地址一律拒绝；DNS 解析发生在连接之前。
- 非媒体响应不会被改名为图片保存；活动 SVG（脚本、事件处理器、外部引用、`foreignObject`、实体声明）拒绝，惰性 SVG 只作为下载产物提供（`Content-Disposition: attachment`、`default-src 'none'; sandbox`、`nosniff`），不进入应用来源的内联渲染。
- 上载／保存路径按声明的媒体类型与大小上限处理；超限返回拒绝而不是截断。
- 写入范围只包含应用已记录的角色项目根目录：角色项目数据根、可丢弃的临时根、`CRB_DATA_ROOT`／`CRB_PROJECT_ROOTS` 显式配置，以及用户通过本机目录选择器选定的目录（记录保存在仓库外的运行时目录，重启后仍有效）。仓库自身的 `src`、`public`、`scripts`、`presets`、`assets`、`licenses`、`docs`、`node_modules`、`.next`、`.git` 永不作为写入目标。
- 请求不能为自己的目标授权：写入检查只接收目标路径，登记行为只来自选择器与配置，任何路由都不会依据请求体或查询参数登记写入根。拒绝信息会指明改用目录选择器或配置项。

## 5. OAuth 会话适配器

- 授权码 + PKCE S256；`state` 一次性，且绑定发起它的本机会话、Provider 目标、client 与 redirect URI，先消费后交换。
- 回调校验 issuer、client、redirect URI、唯一 code、授权有效期与账号主体；交换失败、账号缺失、state 重放均有独立结果且不写入令牌。
- 显式状态：`unconfigured`、`authorization-started`、`callback-received`、`token-exchange-pending`、`authenticated`、`refresh-pending`、`re-authentication-required`、`logged-out`、`revoked`、`account-switched`。
- 刷新轮换、并发刷新单飞（同一账号只发起一次刷新）、刷新失败标记为需要重新认证且不删除账号摘要；退出、撤销与账号切换只作用于认证会话并撤销该账号的本机会话，不触碰项目资产、候选、审核结果与人工选定结果。
- 浏览器只得到状态与非秘密账号摘要（含授权范围与有效期），refresh token 等可复用凭据保存在仓库外的受保护存储中。
- 首次真实调用需要显式确认：未确认前不返回访问令牌。
- 未登记 Provider 目标时所有授权尝试返回 `provider-not-configured`；实验性 OpenAI OAuth 传输默认关闭，仅在 `CRB_ENABLE_OAUTH_EXPERIMENTAL_TRANSPORT=1` 且调用方为 CLI 时可用，浏览器路径不能提供可复用 bearer。

## 6. 凭据保密

- 统一清理入口同时处理结构化字段名与自由文本值：令牌、cookie、authorization 头、签名 URL 查询参数、授权码、PKCE verifier、各 Provider 密钥形态与自定义凭据头。
- 应用位置：控制台、进程日志与会话日志、项目持久化、工作流／模板导出、参考包、错误响应与可分享诊断；日志会话在写入前二次清理，日志目录移至 `CRB_TEMP_ROOT/runtime/`。
- 数据 URL 载荷在清理时保持不变，媒体不被改写；项目文件仍不包含保存目录与凭据字段。

## 7. 自动验证

合成回归全部使用合成令牌、合成账号与注入的解析器／fetch／文件边界，不访问真实 OAuth 服务器、Provider 或浏览器配置。安全准入套件位于 `src/lib/security/__tests__/` 与 `src/test/localApiRequest.ts`：

| 套件 | 覆盖 | 用例数 |
| --- | --- | --- |
| `requestGuard.test.ts` | 可信同源、缺失／null／异常 Origin、异常 Host、缺失／未知／过期／已撤销能力、跨来源能力、非 JSON 媒体类型、缺失／畸形／重复 nonce、CLI 认证、拒绝先于处理体、效果声明 | 13 |
| `guardCoverage.test.ts` | 每个 API 路由都被守卫（或属于显式登记的公开端点），且敌意请求在任何路由代码运行前被拒绝 | 2 |
| `providerConnection.test.ts` | 固定接收方、用户授权自定义目标、环境凭据不得随请求指定目标、引擎与 partner 角色独立、撤销后不附带凭据 | 9 |
| `outboundPolicy.test.ts` | 首跳匹配、同源重定向、跨源重定向拒绝、无凭据跳转、重定向解析到私有地址、本地引擎放行、查询参数携密、重定向上限 | 17 |
| `safeMedia.test.ts` | 回环／RFC1918／链路本地／IPv6 本地／CGNAT／IPv4-mapped／NAT64／6to4、DNS 重绑定、重定向到私有地址、超限、错误媒体类型、合法 Provider 输出、字节级一致性 | 120 |
| `projectWriteScope.test.ts` | 项目数据根、配置根、临时根、路径不得自我授权（含新子目录与同级前缀）、仓库子树始终拒绝、相对路径与穿越 | 11 |
| `secretRedaction.test.ts` | 各类密钥形态在对象、自由文本、项目、模板、清单、错误、控制台上下文与日志会话中都不残留；数据 URL 不被改写 | 30 |
| `oauthSession.test.ts` | 未配置、授权开始、PKCE 匹配、state 一次性、错误 issuer／client／redirect URI／会话、缺失与重复 code、账号不匹配、交换失败、成功、刷新轮换、并发刷新、刷新失败、退出、撤销、账号切换 | 19 |
| `workflowPreservation.test.ts` | 被拒请求、导出被拒、下载失败、刷新失败、退出、撤销与账号切换后项目与人工选定结果逐字节不变 | 4 |

运行结果：`npx vitest run src/lib/security/__tests__/` 全绿（9 个文件、225 项）。全量 `npm run test:run` 与生产构建结果见第 8 节。

## 8. 手工浏览器回归与本机运行

开发（`npm run dev`，`scripts/server.js`）与生产（`npm run build` + `next start --hostname 127.0.0.1 --port 3210`）两种启动模式均执行，使用真实 Chromium 与真实回环 HTTP，另起一个 `http://127.0.0.1:3211` 的无关来源页面作为不可信页面。

不可信页面（`127.0.0.1:3211`）：

- CORS 模式的 JSON 写请求与携带凭据的读取请求都得不到可用响应（预检无应答／响应不可读）。
- 无需预检的 `no-cors` 简单写请求可以发出，但服务器拒绝：目标目录未被创建，项目目录未被修改（逐文件 SHA-256 与目录列表核对）。
- 生产与开发两种模式下结果一致；应用的 `public/`、`src/` 目录没有出现任何新文件。

应用页面（`127.0.0.1:3210`）：

- 页面正常加载；经客户端入口的受保护读取返回 200，同一页面用未被入口覆盖的原生 XHR 发送状态变动请求返回 `400 missing-request-nonce`，说明授权来自会话能力与一次性 nonce，而不是「本机进程」这一假设。
- `document.cookie` 读不到会话能力（HttpOnly）。
- 活动 SVG（含 `<script>`）返回 400：`Refused: SVG payload contains active content`。
- 元数据地址：`http://169.254.169.254/...` 与 `https://169.254.169.254/...` 均返回 400，分别按协议与地址类别拒绝（`169.254.169.254 (metadata)`）。
- 写入应用目录：`.../public` 与 `.../src` 均返回 400 `Write target not authorized (denied-subtree)`；`C:\Windows\Temp` 返回 400 `outside-authorized-root`。
- 合法路径保持可用：同一项目目录内的普通 PNG 保存返回 200；项目内的原画依据与人工选定结果逐字节不变（SHA-256 一致）。
- `/api/session` 返回的认证视图为 `oauth.state = "unconfigured"`，响应体中不含任何 token、secret 或 bearer 形状字段。

全量验证：`npm run test:run` 通过 144 个测试文件、2974 项测试（基线为 134 个文件、2724 项）；安全准入套件 225 项全绿；`npm run build` 通过；`npx tsc --noEmit` 对生产代码无新增报错（仍报告仓库既有测试夹具类型问题，与本次改动无关，未出现在新增文件中）。本轮所有验证均使用合成输入，未调用真实账号或真实 Provider，未产生费用。

## 9. 阻塞项（blocked）

以下输入缺失，真实账号审查与真实 Provider 调用不能进行：

- 未选定的 OAuth Provider 目标、固定实现来源与版本；
- 授权服务器、客户端注册、redirect URI 与最小 scope 清单；
- 用户授权的测试账号，以及允许的账号限制条件；
- 真实调用的费用授权范围。

在这些条件具备之前，实验性传输保持关闭，Issue #8 的真实 Q01–Q04 调用不应进行。

## 10. 已知残留限制

- DNS 解析发生在连接之前，解析结果与随后连接之间的重绑定（TOCTOU）无法由基于 `fetch` 的客户端完全消除；当前缓解是拒绝任何解析结果包含受限地址的主机，并以逐跳校验和公开地址限制收窄窗口。该项作为残留风险记录，不宣称已消除。
- Comfy SDK 拥有自身传输层，其内部重定向与地址分类不受本边界控制。缓解方式是把 SDK 限定在唯一已登记的 HTTPS 接收方（Comfy Cloud）；其他目标一律走受策略控制的引擎路径。
- 凭据存储当前是仓库外、仅本用户可读的受保护文件，接口已为操作系统凭据设施（Windows Credential Manager／Keychain）预留替换点；尚未接入平台凭据设施。
- `src/lib/images` 的内存图像存储与 `/api/images/[id]` 是上游快照的迁移残留，现已被会话能力覆盖且只接受栅格类型；仓库内没有生产调用方。
- 自动测试使用合成解析器（文档地址）代替真实 DNS，依赖真实 DNS 行为的结论需要在真实网络下复验。

## 11. 复现方式

```powershell
npm run test:run                       # 全量测试
npx vitest run src/lib/security/__tests__/   # 安全准入套件
npm run build                          # 生产构建
npm run start                          # 生产启动（127.0.0.1:3210）
```

CLI／自动化认证：令牌取 `CRB_LOCAL_API_TOKEN`，否则读取 `<CRB_TEMP_ROOT>/runtime/local-api-token`，请求头 `Authorization: Bearer <token>`。已授权项目根记录在 `<CRB_TEMP_ROOT>/runtime/project-roots.json`；`CRB_PROJECT_ROOTS` 可显式追加，测试进程不读写该文件。

## 12. 成本与额度证据

合成回归不产生费用：全部 Provider 调用被拦截，未使用真实凭据，未提交付费请求。真实费用与额度数据在本轮**未知**，不记为 0。

## 13. 2026-10-05 云端产品接入验证

### 本轮交付

- 以 OMP `4819e4f6d59049f307329d42b226b218582bdf38` 的 Codex device 和 hosted-image 为协议复用来源，CC Switch `f678f7c539c90ed0e43872680b7f7162db5d0ef2` 为交互、身份及竞态参考。完整调用链、方案对比、许可及差异见 [复用决策](../research/oauth-community-reuse.md)，两份 MIT 原文已保留。
- Providers 设置新增连接、设备码、浏览器授权页、自动轮询、账号／workspace／实际范围摘要、取消、重新连接、退出、切换及本地断开。登录不触发生成。选为默认入口后可保存，供新图像节点和单部件任务使用；现有节点不自动改渠道。
- 新 `/api/oauth` 与 `/api/session` 继续受统一调用方边界保护。设备事务绑定发起会话，另一会话不能读取用户码或轮询完成；过期、取消、退出、切换使迟到启动、交换、刷新和旧调用授权失效。没有新增本机回调监听器，也没有放宽跨站守卫。
- 单一 `OAuthSessionAdapter` 管理设备与原有 PKCE 分支、并发刷新、串行凭据写入、重启恢复、一次性调用授权。服务端提供认证令牌，浏览器仅获得摘要、短期设备用户码及绑定会话／账号代次的单次调用能力。每次生成都确认资料外发与未知费用，不导入第三方认证资料。
- 生产凭据位置独立于仓库、项目和可清理临时根；POSIX 默认本用户应用目录，0700／0600 原子文件；Windows 默认 `%LOCALAPPDATA%/CharacterReferenceBuilder/auth`，CurrentUser DPAPI 加密。`CRB_CREDENTIAL_DIRECTORY` 不允许指向仓库或 `CRB_TEMP_ROOT`。恢复仅接受相同 client、Provider 和协议版本，重启后需要新的调用确认。
- 删除旧请求头 bearer 和 multipart 实验传输，改用固定 Codex Responses 的 `image_generation` 工具。两／三张参考及用途保持顺序，SSE 终态与 WebP 解码后归一化为已有图像结果契约。OAuth、API Key 的能力和费用独立：OAuth 不声明 Mask、不套用 API 价格，实际图像模型仅按响应报告记录。
- 调用授权五分钟过期、一次消费，退出／切换后失效，并在 DNS 校验后发送前再次检查账号代次。连接或同意确认不会自动付费。已提交后断流记录结果未知，不自动重发；取消保留输出、候选与人工选择。既有项目保存、恢复、导出与安全回归继续通过。

### 云端证据

环境：Linux，Node.js/Next.js；开发用 `npm run dev`（回环 3212），生产用 `npm run build` 后 `npm run start`（回环 3210）。真实 Chromium 只用于本机 HTTP 与合成交互；外部网络请求在浏览器脚本中拒绝或拦截。

| 验证 | 结果与证据范围 |
| --- | --- |
| 全量 `npm run test:run` | **148 个文件通过，3023 项通过，1 项跳过**；包含既有单部件选择、项目保存／重开／导出及请求状态回归。跳过为 Windows 路径大小写别名用例，Linux 不执行，不作为通过项。 |
| `codexOAuth.integration.test.ts` | **14 项通过**：执行真实路由、守卫、生产协议和图像映射，fetch／DNS 为合成边界；覆盖缺客户端许可、设备绑定／节流／过期、取消迟到交换／启动、重定向、身份替换、范围未知、恢复、并发刷新、一次性授权、两／三参考、SSE 断流未知和 Mask 拒绝。 |
| 新设置 UI 与执行器回归 | UI 4 项；执行器新增 2 项，验证逐次确认、全量参考、OAuth 请求不带 API Key、不计 API 估算费用、拒绝确认不提交且保留输出与选择。 |
| 持久存储 | 新增 2 项 Linux 回归，验证禁止项目／临时路径、0700／0600、原子文件、Unicode 合成值与重新打开；Windows DPAPI 未在 Linux 执行。 |
| 开发／生产浏览器 | **两种模式通过**：真实 `/api/oauth` 未配置状态、HttpOnly/Strict 会话、设置合成连接→轮询→摘要→保存 OAuth 默认入口→切换→取消、登录生成次数 0、无关来源无法改变认证。OAuth UI 响应被拦截为合成值，不能算真实授权或 Provider E2E。 |
| 生产构建 | `npm run build` **通过**。 |
| TypeScript | 生产构建类型检查通过；独立 `npx tsc --noEmit` 仍失败于基线测试夹具，本次新增文件无错误。未顺带修复其他工单代码。 |

浏览器复跑入口为 `scripts/validation/oauth-ui.cjs`，说明见 [脚本文档](../../scripts/validation/README.md#oauth-产品接入浏览器回归)。日志、结果 JSON、截图与上游快照统一在 `<CRB_TEMP_ROOT>/validation/issue-10-oauth/`，不提交临时产物。

云端只读用户主目录导致既有测试夹具曾遇到 `EROFS`；本轮给测试进程使用可写的隔离 profile，保持生产路径检查和守卫断言不变后完成全量回归。构建首次受沙箱端口权限影响，允许本机网络后通过；浏览器初次因欢迎层遮挡和 `networkidle` 等待失败，改为实际关闭欢迎层并等待设置控件。合成切换流程曾在点击取消前过快完成，夹具改为持续待授权后，开发／生产均复跑通过。这些准备失败不计为产品验收通过，也没有访问真实认证账号。

### 真实验收阻塞与下次步骤

已核实固定 issuer、设备页面、启动／轮询／交换／刷新端点、redirect URI 和 image tool 目标。两个社区实现使用 Codex 上游公共 client identity；所查源码与官方设备实现没有证明 CRB 可复用该身份，也没有本产品客户端注册成功的证据。因此没有内置上游 client ID；设置明确显示尚未开放连接，服务端返回 `client-registration-required`。实际 scopes 仅按 token 响应显示，未报告时保持未知；账号、组织策略与 hosted-image 可用性必须实测。

后续由实现方推进客户端许可核查，已在 [复用决策](../research/oauth-community-reuse.md#具体-provider-与权限事实)提供支持入口及可直接提交的应用、接口、权限和使用场景说明。只有 Provider 要求所有者／管理员动作时才需本人操作；不要求用户自行调查协议或逐项提供未知配置。云端没有账户凭据，且当前出站策略不放行真实授权／图像服务，未尝试绕过，也未发送支持消息。

下次在可运行 Windows 的本机、取得 Provider 许可后：

1. 用合成值验收 Windows 启停、DPAPI 保存／解密、不同用户不可解密、重启恢复、Unicode 与取消清理；确认临时根清理不删除持久凭据。
2. 用户亲自控制浏览器授权，分别验收已有登录状态、未登录／再次验证、拒绝／取消、设备码过期、重连、自动刷新、退出、切换及旧操作失效；远端撤销未接入，当前只提供本地断开并显示远端未知，不能记录为远端成功。
3. 明确同意素材外发与费用后，运行至少一个单部件生成／优化任务，核实两／三张参考的实际效果、返回模型、能力与费用状态，再保存重开和导出。失败、断流、取消时核对已有选定版本保持可用；未知结果不得自动重提。

完成这些真实证据前 #10 不关闭。#8 的质量、费用和 Provider 替换矩阵仍留待后续工单，未在本轮展开。

## 14. 2026-10-20 Windows 原生浏览器登录交付与实际尝试

功能比较基线：`fdc0ede5d511b41af658022be38a65a07e61862e`；本轮主体实现提交：`ab1c601abee7b18914fc84d37fa2ce0e1c7e8ff3`，最终代码及验证脚本基线：`eb4293ffc7a6e617503434704fd666ce1e5ae40e`。该提交保留单一 `OAuthSessionAdapter` 和应用独立受保护存储，内置固定社区实现使用的 Codex 公共原生客户端；默认连接不再被未配置环境变量阻止。浏览器 PKCE、本机 HTTP 监听器、可选设备码和产品设置入口已集成，登录不会授权模型调用。

### 自动化结果与适用范围

本轮执行环境为 Windows、Node `v24.16.0`、Next.js `16.1.6`，验证专用 Playwright 位于任务临时子目录，通过本机 Chrome 执行。没有使用真实账号、浏览器 Cookie、私人素材或模型额度。常规运行时 `CRB_TEMP_ROOT` 指向项目上一级 `../.tmp`，记录只使用相对路径及占位符。

| 检查 | 本轮结果及边界 |
| --- | --- |
| `npm run test:run -- --reporter=json --outputFile=<任务临时目录>/all-tests.json` | 149 个文件，3045 项通过、0 失败、1 项 POSIX 文件模式测试跳过。最终主体实现包含 bootstrap 隐藏待完成浏览器 URL、凭据部分保存失败清理的增量回归；OAuth／出站／设置五个文件合计 82 项通过。 |
| `npm run build` | 生产构建通过，含 Next.js 配置的类型检查。未以此声称独立 `tsc --noEmit` 的历史测试夹具问题已解决。 |
| `CRB_VALIDATION_MODE=development node scripts/validation/oauth-ui.cjs` | 通过。真实产品 UI、本机守卫路由、随机 state／PKCE 回调、Windows DPAPI、进程停止／重启、恢复及自动刷新；服务商页面／令牌响应合成，未拦截 `/api/oauth`。 |
| `CRB_VALIDATION_MODE=production node scripts/validation/oauth-ui.cjs` | 同范围通过。默认入口、设备码、保存默认 Provider、切换、取消、退出、本地断开、拒绝外来 Origin，均未触发 `/api/generate`。 |
| 本机代理 DNS | 原策略拒绝真实 DNS 返回的 `198.18.x.x`；修复后只对固定 Codex HTTPS 认证 POST、零重定向允许 `198.18/15`，私网／元数据／其他 URL 继续拒绝。无账号 TLS 握手校验证书成功（TLS 1.3）。单元回归验证固定接收方与拒绝边界，不能外推真实 token 交换通过。 |

最终全量测试包含 bootstrap 可见性、刷新副作用标记、部分凭据保存失败清理及账号显示收简；设备码安全设置说明另有聚焦 UI 检查。浏览器脚本在最终代码基线上复跑两种模式，并在进程停止后删除该测试服务实际使用的整个隔离 `CRB_TEMP_ROOT`，保留位于其外部的合成 DPAPI 存储，再重新启动确认账号恢复。该过程不清理项目上一级共享临时根目录。开发／生产结果、截图及服务日志位于 `<CRB_TEMP_ROOT>/validation/issue-10-browser-oauth/<模式>/`；全量 JSON／日志和构建日志位于 `<CRB_TEMP_ROOT>/scratch/crb-issue-10-browser-oauth/`。常规日志不提交仓库。脚本只使用新建合成凭据目录，并清理该目录；原有默认凭据目录及其他应用认证文件没有读取或修改。

### 用户本人尝试与真实限制

在未加载测试夹具的正常生产服务中，用户本人通过普通 Chrome／Edge 登录，并在点击同意／继续授权后遇到服务商页面：`Route Error (400 Invalid content type: text/html; charset=UTF-8)`。应用尚未显示已连接账号；这是真实浏览器登录未通过的证据。没有捕获密码、Cookie、完整授权 URL 或授权响应，不把截图中的错误推断为客户端注册被拒绝。

官方 Codex 仓库 [#42578](https://github.com/openai/codex/issues/42578#issuecomment-5847776265) 有相同错误文本的报告。该来源仅证明其他用户报告过类似现象；没有本次请求的响应头或跟踪证据，无法确认同样由 Cloudflare 或同一根因造成。当前客户端参数与固定社区／官方实现的差异、来源和权限范围见[接入决策](../research/oauth-community-reuse.md)。没有以改 User-Agent、导入凭据或读取浏览器会话规避授权。

用户转试设备码后，服务商明确要求本人在 [ChatGPT 安全性设置](https://chatgpt.com/#settings/Security) 启用“Codex、Excel、PowerPoint 和 Word”的装置代码登入。这与[官方设备登录说明](https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta)一致，是实际账号开关，不是 CRB 要求用户申请客户端。应用已经具备取得新码及自动轮询的完整路径；用户本人启用后在本应用重试，无需执行其他应用的 CLI 登录命令。用户随后亲自启用该账号设置、在服务商页面输入本应用显示的一次性用户码并确认；提供的脱敏截图显示本应用“账号已连接”、用户／工作区摘要和 `openid profile email offline_access` 实际范围。因此设备码登录的“设置入口 → 服务商确认 → 自动显示账号”已完成真实验收。没有把邮箱、工作区 ID、设备码或截图写入仓库。

### 当时未闭环与交付边界（最新浏览器复验见第 15 节）

- R-001：人工门槛已移除，浏览器／设备协议均已集成；设备码路线已由用户本人完成真实登录，浏览器确认页 400 失败仍未解决。
- R-002：设备码真实登录已验收；用户本人启用账号开关并完成确认。真实账号的刷新、拒绝、重新连接、退出／切换及旧会话失效仍待逐项验证；合成生命周期回归不替代这些证据。
- R-003：Windows 开发／生产进程启停及 DPAPI 同用户持久保存通过；合成跨进程恢复及临时根清理后恢复通过，真实同用户应用重启恢复由本人确认。不同 Windows 用户不能解密仍待另一个用户上下文验证。本轮没有创建系统账号，也未单独复跑双击启动器。
- R-004：订阅能力与图像调用仍待另行授权并实测。没有真实图像生成、额度／费用验证、资料外发、远端撤销或 #8 质量矩阵结论。

用户随后明确要求已连接区域只显示登录账号和授权有效期。最终界面移除了工作区、授权范围、能力／额度说明，保留必要操作；服务端仍隔离用户与 workspace 并记录授权元数据。更新后停止原应用进程并重新启动，用户本人刷新页面确认“仍已连接，且只显示这两项”，因此真实同用户跨进程恢复和最终显示已验收。没有让用户再次登录，也没有执行真实模型调用。此前截图的较完整摘要属于当时界面，不被错误地当作最终显示要求，也不收进仓库。

本轮代码通过功能分支及 PR 交付，尚无独立审核、主线集成或发布结论。#10 继续打开。

## 15. 2026-10-20 浏览器确认页 400 修复与本人复验

增量基线：`ca525c0e59d1bd7a3cbdb89c8eb174e88d36f8e2..10538aaece9ab242b66dd4e0bf5956a1810b1331`。本节记录本轮新执行的检查，前节的失败观察仍保留为修复前证据。

### 协议差异与修复

在全新隔离 `CODEX_HOME`、`cli_auth_credentials_store="ephemeral"` 的官方 `codex-cli 0.163.0` App Server 中，以 `character_reference_builder` 初始化，仅执行 `account/login/start` 取得 URL 随即按 loginId 取消；没有打开服务商浏览器、授权账号或读取既有认证文件。去掉随机 state／PKCE challenge 后，官方请求与 CRB 的唯一公开参数差异为 scope：原实现删除了 `api.connectors.read api.connectors.invoke`。

修复恢复上游完整 `openid profile email offline_access api.connectors.read api.connectors.invoke`，客户端 ID、IPv4 回调和 CRB originator 保持不变。固定 [官方浏览器源码](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/server.rs) 与 OMP 快照均使用这六项；实际 CLI 捕获的公开合约保存为 `src/lib/security/__tests__/fixtures/codex-authorization-0.163.0.json`，默认客户端与真实守卫路由回归分别比对全部非随机参数。没有通过更换 User-Agent、关闭 TLS 校验或读取 Cookie 处理错误。请求 connector scope 不会自动新增产品 connector 调用入口，实际授予范围仍只按服务商响应记录。

### 本轮验证

| 检查 | 结果及证据边界 |
| --- | --- |
| `npm run test:run`，JSON reporter | Windows 全量 149 文件、3046 项通过、0 失败、1 项 POSIX 文件模式测试跳过；包含新增官方合约回归。浏览器集成文件 18 项通过。 |
| `npm run build` | 通过，含 Next.js 配置的类型检查。随后增加的仅为兼容性测试和文档，运行代码与构建一致。 |
| `CRB_VALIDATION_MODE=production node scripts/validation/oauth-ui.cjs` | 通过；实际 UI、路由、短期回调、DPAPI、重启／临时根删除后恢复、自动刷新及退出／切换，外部 Provider 合成，生成请求数 0。 |
| `CRB_VALIDATION_MODE=development node scripts/validation/oauth-ui.cjs` | 同范围通过，生成请求数 0。 |
| 本人真实浏览器授权 | 独立本机生产入口 `127.0.0.1:3216` 使用新建私有凭据目录，与正常 3210 登录隔离。用户亲自点击连接并在服务商页面确认后，明确回复“授权成功，应用显示账号已连接”；只读状态检查也返回“账号已连接”。本次确认页 400 已不再出现。 |

真实复验没有读取或复制原账号凭据、发起生成或验证额度／费用。正常 3210 应用已运行修复后构建，原有持久登录未改变。复验结束通过独立应用的正常退出流程清除测试账号，再停止 3216 服务；没有远端撤销账号授权，也未改动正常账号。原始账号标识、令牌、完整授权 URL 和用户截图均不写入仓库。命令输出和官方参数捕获位于 `<CRB_TEMP_ROOT>/scratch/crb-issue-10-browser-oauth/browser-400/`；合成浏览器记录沿用前节的模式子目录。

### 当时验收状态（最新见第 16 节）

- R-001：**本次范围已复验关闭**。原先人工登录门槛已移除；完整上游 scope 请求修复后，本人真实浏览器授权成功，设备码路线此前也已成功。这是本机观察与修复后复验，不推断服务商内部为何返回 HTML，也不保证所有网络环境不存在相似错误。
- R-002：真实浏览器和设备码登录、账号显示及同用户应用重启恢复已有证据；真实过期刷新、拒绝、重连、切换及旧事务失效仍按原验收范围继续。独立测试账号的正常退出仅证明此次本地退出，不代替完整真实生命周期矩阵。
- R-003／R-004：跨 Windows 用户隔离、真实图像能力、业务结果及额度／费用仍待各自验收。没有执行真实模型调用。

PR #11 待独立审核，尚未合并或发布；#10 继续打开。当前唯一汇总更新前的完整原文另存于 `issue-10-comments-archive.json` 的 `summarySnapshots`，不删除原有历史来源。

## 16. 2026-10-20 剩余验收与独立审核

代码及脚本最终基线：`b52fdc76bcfe86e536a4664dcf8286f34bba9cc4`；比较基线仍为 `fdc0ede5d511b41af658022be38a65a07e61862e`。以下为本轮执行结果。

| 检查 | 本轮结果及边界 |
| --- | --- |
| 全量／构建 | Windows、Node 24.16.0、Next 16.1.6；149 文件、3060 项通过、0 失败、1 项 POSIX 文件模式测试跳过；生产构建通过。之后仅改变验证脚本及文档。 |
| 开发／生产浏览器 | 两种模式均通过，真实 UI、路由、回调、DPAPI、清理隔离临时根后的恢复；外部 Provider 合成，生成请求 0。修复重启前已刷新导致的证据缺口：独立审计断言重启前无刷新，重启后仅一次且来自第二代服务。开发旧页在停服等待时脱离连接的一次失败，改为停服前关页、重启后新开页面，两种模式复跑通过。 |
| Windows 跨用户 DPAPI | [整项成功 CI](https://github.com/Alexis-Li/Character_Reference_Builder/actions/runs/39394243074)，基线 `c284e8209ad9064e08c022162cf0d236a01468e9`。一次性 windows-2025 VM：第二 SID 可读同一密文、自身 DPAPI 阳性对照通过，但原生解密被拒绝、产品读取为空；密文未变化且原用户仍可解密。只用合成值；不在日常电脑创建用户，最终脚本也拒绝 self-hosted runner。 |
| Windows 启动器 | 真实 start-windows.cmd／stop-windows.cmd、隔离端口 3217 验证通过；重复启动同一 host PID，重复停止无害，端口／状态文件释放。修复 Mutex 初始所有权后复验。 |
| 真实刷新／旧操作失效 | 用户亲自授权独立测试登录；真实 HTTPS 刷新两次，六个并发调用共一次请求。第二次真实响应暂存后开始新登录代次，再释放旧结果和旧调用许可均被拒绝；本地退出后不可恢复、回调关闭。只缩短恢复读取的过期元数据，未改 token／时钟／日常存储；模型请求 0。 |
| 真实拒绝／取消 | 本人确认取消／拒绝；页面回到 ChatGPT，未回本机，交换／刷新均 0，隔离事务随后超时并清理。denial-only 检查因未收到拒绝回调而失败，不能写成 access_denied 回调通过；该回调分支仍只有合成证据。 |
| 不同真实账号切换 | 用户明确没有第二个可用账号，未验证。切换开始与旧事务／刷新／许可失效已有真实证据，不把合成账号切换当作第二真实账号验收。 |

### 真实图像路径

用户分别批准三次最多一次的真实提交，均用同一组自制合成蓝色肩甲图和已展示提示词，接受未知费用，无自动重试或换 Provider。缺 Gemini key 和旧本机会话读取失败均显示未提交，不计入真实提交次数。设置跨标签保存丢失 OAuth 默认入口已修复，真实节点工厂继承渠道的回归通过。

前两次 Responses 图像工具映射 HTTP 400，无图片。按当前官方 Codex 0.163.0 JSON ImagesClient 修复后，第三次真实返回一张 PNG，进入候选、选择、批准、保存和参考包导出；从完整保存副本通过项目列表重开，输入、候选及选择／批准状态保留。生成与导出原图 SHA-256 相同：`86611fe28404203b0482f6d6ec92e5999f1f062f07961fa3d40895e96bb9f6d7`。两组视图保留三条金色横条和两个灰色扣件，这是 Agent 对合成输入的检查与选择，不是模型师真实角色质量评审。请求模型固定 gpt-image-2，响应不报告实际模型时不伪造；额度／费用未知。三参考、连续优化及 #8 质量／费用矩阵未付费展开。

原图、生成、项目及导出保留在本机 `data/acceptance/`；验证副本、JSON、截图和日志位于 `<CRB_TEMP_ROOT>/scratch/crb-issue-10-acceptance/`，浏览器证据沿用 `<CRB_TEMP_ROOT>/validation/issue-10-browser-oauth/`。仓库不提交图片、账号标识、授权链接或凭据。

### 审核与交付界限

Codex Security 扫描 `5188ce8d-9d7c-436c-b032-aef08f9dfb1f` 已完成，完整不可变范围 `fdc0ede5d511b41af658022be38a65a07e61862e..b5c91b77a3c474a4963beb2e93eeb7c4b5a6a86f`：23 源文件及 8 文档／配置／公开夹具均已检查，无可确认新增安全漏洞。三名独立审查者与主 Agent 分工，不等于全仓库漏洞审计。原生图像协议 `afc8bd130c99416f99449b67556e67054aa5b010`、畸形回调修复 `1667c8940d7782da6627525916d4089aa66f5e2e`、刷新证据及 hosted-runner 限制 `c284e8209ad9064e08c022162cf0d236a01468e9` 另行独立复审通过；监督拒绝模式也独立阅读。最后页面重开五行改动由主 Agent 核对并在两种模式实跑，不冒充纳入原扫描。

仍未完成第二真实账号切换、真实拒绝回调、主线集成／发布；远端撤销未接入，只证明本地断开。PR #11 承载交付与审核，#10 保持打开，不以模拟或新建账号替代外部条件。

## 17. 2026-10-21 账号流程范围调整

用户明确决定不做多个账户的切换：更换账号先退出，再重新登录。产品设置移除浏览器／设备码的“切换账号”入口；已有账号（含需要重新认证的账号）只提供退出，本地退出成功后才出现登录入口。API 对未退出时的浏览器／设备码新登录和兼容旧 switch 请求返回 logout-required，不替换当前账号，也不发起服务商请求。底层旧事务／刷新／调用许可失效保护保留。

因此“第二真实账号完成切换”从 #10 待办移除，第16节及旧汇总保留为范围调整前的历史状态，不要求创建或准备第二账号。真实服务商拒绝回调仍只有合成证据；本人取消直接回到 ChatGPT、零交换及超时清理的实测保持有效，不能改写为收到 access_denied。本次调整需增量审核及集成，未纳入之前已封存的安全扫描；无新增真实登录或图像调用。

本次验证：聚焦 3 文件 52 项通过；全量 149 文件、3062 项通过、0 失败、1 项 POSIX 权限测试跳过；生产构建及开发／生产浏览器均通过。合成浏览器覆盖退出后登录另一合成身份、取消及恢复，生成请求 0；没有再次调用真实 Provider。本轮增量仍待独立审核。
