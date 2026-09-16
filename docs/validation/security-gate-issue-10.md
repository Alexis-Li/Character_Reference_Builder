# CRB-09 本机 API 与真实 OAuth 登录安全边界验证

验证日期：2026-09-16。范围为 Issue #10 指定的安全准入：本机特权请求边界、Provider 接收方与凭据绑定、媒体与活动内容隔离、写入范围、OAuth 会话生命周期、凭据保密与合成回归。未调用任何真实云端账号，未使用个人凭据，未产生费用。

## 1. 结论

| 准入项 | 结果 | 依据 |
| --- | --- | --- |
| 本机特权请求边界（调用方认证、Host／Origin／媒体类型／nonce） | **pass** | 第 2、7 节 |
| Provider 接收方与凭据绑定（含 Comfy 引擎与 partner 节点分流） | **pass** | 第 3、7 节 |
| 媒体下载、活动内容与写入范围隔离 | **pass** | 第 4、7 节 |
| OAuth 会话适配器协议行为（授权码 + PKCE S256、一次性 state、刷新、退出、撤销、切换） | **pass**（合成提供方） | 第 5、7 节 |
| 凭据保密（项目、模板、导出、日志、错误、控制台） | **pass** | 第 6、7 节 |
| 真实 OAuth 账号授权与真实 Provider 调用 | **blocked** | 第 9 节 |

**总判定：blocked。** 本机边界、凭据绑定、媒体隔离、OAuth 协议实现与合成回归均已完成并通过；缺少 OAuth Provider 目标、固定实现版本、客户端注册、redirect URI、最小 scope 与用户授权测试账号，无法进行真实账号审查，因此按 Issue 要求标记 blocked，而不是用模拟结果代替真实账号结论。Issue #8 的真实调用应在该阻塞项解除后执行。

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
