# 最小部件参考闭环：云端 Provider 证据核查

核查日期：2026-09-10。范围：多参考输入、生成、连续修改、局部编辑、认证与费用证据。本文提供选型依据，不代表云端质量验收通过。

## 执行范围与证据等级

- **已执行**：读取官方 OpenAI / Google 文档；通过 GitHub API 固定两个第三方项目的源码版本；下载并追踪请求构造、路由、上游调用及响应处理。
- **未执行**：登录、读取本机私有凭据、发送云端生成请求、付费调用、真实角色质量评审。
- 官方文档证明公开接口声明；源码证明适配器如何构造请求。两者均不能替代本账户的可用性、实际出图与成本验证。
- `git clone` 因网络连接失败，改用 GitHub API 和固定 SHA 的 raw 源码，成功取得研究材料。临时材料现位于 `CRB_TEMP_ROOT/validation/provider-research/`，不作为项目运行依赖。

## 能力对照

| 路径 | 多参考与连续优化 | 局部编辑 | 当前直接支持产品的程度 |
| --- | --- | --- | --- |
| OpenAI 官方 Image / Responses API | 文档支持图像输入、编辑；Responses 支持多轮上下文 | 支持 mask，但只作生成指导，无法保证像素级边界 | 接口能力覆盖最小闭环；账户、质量与实际费用未验证 |
| `EvanZhouDev/openai-oauth` | 源码支持 1–5 张参考，经 `/images/edits` 转为 JSON | 明确拒绝 mask；文字描述的编辑可表达，但效果未验证 | 可作为有条件实验适配器，不能作为已通过验收的默认生产路径 |
| `l0z4n0-a1/chatgpt-bridge` | 生成接口扩展 `reference_images`，最多 8 张；每次组装新请求 | 无专用编辑路由与 mask 转换；默认提示偏风格迁移 | 原样不满足设计保真的连续局部修改要求；需调整提示和调用契约后验证 |
| Gemini 官方 API | 文档支持多图和多轮编辑 | 文本指导编辑；本次材料未确立与 OpenAI mask 等价的契约 | 是能力兼容候选；需要独立适配，不是仅替换 base URL |

以上接口能力来自下节逐项证据；“直接支持程度”是本次研究推论。

## OpenAI 官方 API

官方图像指南说明 Image API 的生成/编辑端点、Responses 的多轮编辑与图像输入；多个输入图像配合 mask 时，mask 作用于第一张。mask 是提示指导，精确形状可能不被完整遵循；跨次角色一致性和精确布局也仍有限制。产品因此应保留原图、候选版本及人工审核，不能把“调用成功”当作“设计正确”。[官方图像指南](https://developers.openai.com/api/docs/guides/image-generation)

本次读取时指南已展示 `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare`；既有候选 `gpt-image-2` 仍有官方模型页，支持图像输入输出和编辑，提供 `gpt-image-2-2026-04-21` 快照，Free tier 不支持。不要把旧候选名称直接替换为新版而省略基线比较。[GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)

Sunburst 模型页列出文本输入 $5 / 百万 token、图像输入 $8 / 百万 token、图像输出 $30 / 百万 token。这不是固定每张价格；参考图、质量和实际输出会影响费用。本次未取得账户账单，也没有本项目每个合格部件的成本实测。[Sunburst 模型与价格](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)

官方应用请求使用 API key，或官方支持的 workload identity 短期令牌；key 应留在服务端。该公开认证页没有证明第三方读取 Codex OAuth 凭据即可获得生产级图像 API 服务承诺。[API 认证](https://developers.openai.com/api/reference/overview#authentication)

**接入含义**：首轮可用显式参考数组调用 Image edits；后续把原始设计依据与已选候选重新传入，产品自行保存版本。若采用 Responses 上下文，需要另保存响应标识及可恢复的输入快照。超时后的上游完成和计费状态应记为未知，不能自动视作未扣费而无限重试。这是产品执行层建议，并非本次已实现能力。

## openai-oauth：多参考编辑存在，mask 不存在

固定版本：`ec7dab2fcd8dab9da970a7a2b5dc34046c94905e`。

- 核心 `normalizeEdit` 读取 `image` / `image[]`，要求 1–5 张、单图不超过 50 MB，再转换成 `images: [{image_url: data URL}]`；默认模型为 `gpt-image-2`。显式拒绝 mask、stream，以及 `input_fidelity`、`moderation`、输出格式/压缩等选项。[请求标准化源码](https://github.com/EvanZhouDev/openai-oauth/blob/ec7dab2fcd8dab9da970a7a2b5dc34046c94905e/packages/core/src/images.ts#L107)
- 服务层确有 `/images/edits` 请求处理，保留调用方 abort signal。[编辑处理源码](https://github.com/EvanZhouDev/openai-oauth/blob/ec7dab2fcd8dab9da970a7a2b5dc34046c94905e/packages/openai-oauth/src/images.ts#L18)
- 默认上游是 `chatgpt.com/backend-api/codex`，核心 transport 调用请求标准化后实际执行 fetch；这不是调用 `api.openai.com` 的官方 API key 路径。[transport 源码](https://github.com/EvanZhouDev/openai-oauth/blob/ec7dab2fcd8dab9da970a7a2b5dc34046c94905e/packages/core/src/runtime.ts#L984)
- 项目 README 描述本机 Codex OAuth、可选登录流程及浏览器扩展登录；Apache-2.0 是软件代码许可，不是对上游账号可用性或服务条件的证明。[项目说明](https://github.com/EvanZhouDev/openai-oauth/tree/ec7dab2fcd8dab9da970a7a2b5dc34046c94905e)

**待确认**：本账户能否调用图像上游、额度所属、限流与恢复、有效模型列表、真实多参考忠实度、失败/取消后的额度消耗。本文不确认“免费”或“订阅一定覆盖”。可以验证无 mask 的文字局部修改，但不能向 UI 宣称具有精确遮罩能力。

## chatgpt-bridge：生成封装不能直接等同编辑适配器

固定版本：`381b0e71cf0226675354b95704d3a90e0aae9f07`。

- `ImageRequest` 限制 `n=1`，扩展参考最多 8 张。`buildBody` 转成 Responses 的 `input_image` + 文本和 `image_generation` tool；有参考时 `tool_choice=auto`，`store=false`。实际外层模型由 `cfg.imageModel` 决定，而不是原样透传用户提交的 `req.model`。[图像源码](https://github.com/l0z4n0-a1/chatgpt-bridge/blob/381b0e71cf0226675354b95704d3a90e0aae9f07/src/images.ts#L19)
- 默认参考图开发者提示要求产生新图，并避免直接复制参考。**推论**：这与保留既有部件几何、非对称结构的目标存在语义冲突，需要先修改才能公平验证保真能力。[参考提示与请求构造](https://github.com/l0z4n0-a1/chatgpt-bridge/blob/381b0e71cf0226675354b95704d3a90e0aae9f07/src/images.ts#L47)
- 服务有 `/v1/images/generations`，未发现专用 `/v1/images/edits` handler。通用转发不证明 multipart edits 可用。图像返回中的 usage 缺失会被补成全 0，产品不能把这些 0 解释成零成本。[服务路由与响应](https://github.com/l0z4n0-a1/chatgpt-bridge/blob/381b0e71cf0226675354b95704d3a90e0aae9f07/src/server.ts#L369)
- transport 是读取 OAuth headers 后发往配置上游的 fetch；图像代码设超时并在 finally 清理计时器。中断本地等待不证明上游取消或返还额度。[上游调用](https://github.com/l0z4n0-a1/chatgpt-bridge/blob/381b0e71cf0226675354b95704d3a90e0aae9f07/src/upstream.ts#L40)

README 声称订阅覆盖、无单图费用，并说明使用已有 Codex OAuth。这里只记录作者声明；未从官方材料或本账户实测确认额度与费用。MIT 许可仅覆盖项目代码。[项目说明](https://github.com/l0z4n0-a1/chatgpt-bridge/tree/381b0e71cf0226675354b95704d3a90e0aae9f07)

## Google Gemini：独立替换候选

官方指南当前给出 `gemini-3.1-flash-image` 和 `gemini-3-pro-image`，支持多轮编辑、最多 14 张参考；不同模型对人物/物体参考有分项限制，不能把 14 理解成 14 个稳定角色。指南明确 Flash Lite Image 不针对多参考和连续编辑优化，故本闭环不应仅按最低价选择 Lite。REST 示例使用 `x-goog-api-key` 和 `previous_interaction_id`。本次未发现该指南提供与 OpenAI mask 等价的精确契约。[Google 图像生成指南](https://ai.google.dev/gemini-api/docs/image-generation)

Flash Image 标准价格页显示免费 API 层不可用；1K 图像输出约 $0.067、2K 约 $0.101、4K 约 $0.151，另有输入及文本/思考费用。此处是公示单次输出构成，不是本项目合格产出成本；本账户权限、真实 token、返工与延迟仍待测。[Gemini 价格](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-image)

## 后续验收必须补齐的证据

1. 对每个候选用同一份设计依据执行“首次生成 → 指定一处修改 → 导出”，保存请求的非敏感字段、模型、输入哈希、输出及人工判定。
2. 分开评价“仅正面推测背面”与“已有背面依据”；检查非对称结构、材质、配色和未要求变更的细节。
3. 把实际成功/拒绝/限流/超时和 usage 原样记录；未知费用保持未知。计算每个**合格**部件的总成本与返工次数。
4. 对没有 mask 的路径，让产品明确提供文字局部修改或框选裁切参考；不得静默丢弃 mask 后按原能力报告成功。
5. 将 Provider 能力声明与工程适配器分离；参考图数量、mask、连续上下文、输出格式必须按真实路径判断。

**当前结论**：官方 API 有足够的公开接口证据支持最小闭环实施；两个 OAuth 项目有可追溯的实际请求构造代码，但不能从源码推断当前账户可调用或生产质量达标。云端效果与经济性仍需真实调用验证，本研究没有将其标记为通过。
