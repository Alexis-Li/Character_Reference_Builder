# 可复用项目

本文汇总已研究的社区项目、可复用部分及采用边界。公开功能和许可证信息沿用 2026-09-09 的核查记录；2026-09-10 的工程决定与实测结果优先。本次恢复资料未重新联网核查，不代表这些项目的最新状态。

产品行为由[产品需求](../product-requirements.md)定义，底座决定见 [ADR 0001](../adr/0001-minimum-loop-foundation.md)，真实工程证据见[最小闭环验证](../validation/minimum-loop-2026-09-10.md)。Provider 的固定源码版本、接口限制与费用证据见[专项核查](provider-feasibility-2026-09-10.md)，这里不重复维护其细节。

## 项目清单与复用判断

| 项目与来源 | 已研究的能力 | 当前复用判断与边界 |
| --- | --- | --- |
| [Node Banana — shrimbly/node-banana](https://github.com/shrimbly/node-banana) / [发布记录](https://github.com/shrimbly/node-banana/releases) | 节点工作流、Prompt、标注、图片比较、Gallery、保存加载及图像生成／编辑；仓库声明 MIT。历史核查发现 README 的 Provider 表与发布功能存在漂移 | 已选作有边界的二次开发起点，固定版本见 ADR。复用画布、图片编辑、标注、比较等通用能力；必须修正多参考丢失、通用自动回退、失败清空及重跑覆盖，不能原样套模板视为产品完成 |
| [openai-oauth — EvanZhouDev/openai-oauth](https://github.com/EvanZhouDev/openai-oauth) / [许可证](https://raw.githubusercontent.com/EvanZhouDev/openai-oauth/main/LICENSE) | ChatGPT 登录、图像生成与多参考编辑；Apache-2.0；部分网页登录方案涉及浏览器扩展；不支持编辑遮罩 | 独立实验适配器候选，优先于原样 chatgpt-bridge 验证。源码能力不证明本账户权限、订阅额度、稳定性或生产质量；不声明严格遮罩编辑支持 |
| [chatgpt-bridge — l0z4n0-a1/chatgpt-bridge](https://github.com/l0z4n0-a1/chatgpt-bridge) | OAuth 兼容代理及图像生成，MIT；存在多个同名项目，必须按仓库及固定版本识别 | 保留备选研究。默认参考提示偏风格迁移，与设计保真冲突；原样不作为首个生产适配器。与其他 OAuth 桥接共享上游，不能视为独立可用性保障 |
| [Meta SAM3](https://github.com/facebookresearch/sam3) | 模型运行、微调代码与权重获取说明 | 本地可选分割候选。按真实设备测试显存、速度、边界质量及获取条件；不因版本较新而优先，不承诺已可稳定运行 |
| [ComfyUI-SAM3 — PozzettiAndrea/ComfyUI-SAM3](https://github.com/PozzettiAndrea/ComfyUI-SAM3) | 分割封装、点／框交互、遮罩、裁切与预览相关能力；存在近似名称项目 | 评估本地分割封装与交互复用。是否引入其运行环境取决于安装负担、资源和效果；完整 ComfyUI 不是首版必装底座 |
| [ComfyUI-H3-ContactSheet — matlowai](https://github.com/matlowai/ComfyUI-H3-ContactSheet) | 依赖特定模型及条件的五视图流程 | 参考视角组织与总览设计，不迁移特定模型的效果保证，也不据此把本产品默认视图改回五视图 |
| [ComfyUI-MiniMax-H3-Edit — ethanfel](https://github.com/ethanfel/ComfyUI-MiniMax-H3-Edit) | Character Sheet、服装视图和连续相机视角逻辑 | 参考业务表达与视角控制交互，不作为其他 Provider 达到相同一致性的证据；复杂连续视角仍后置 |
| [opencode-openai-codex-auth](https://github.com/numman-ali/opencode-openai-codex-auth/blob/main/docs/getting-started.md) | OAuth、令牌刷新与错误处理；使用说明面向个人编程辅助 | 只参考认证体验与生命周期处理，不作为本产品图像运行依赖 |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/integrations/providers/) / [内置能力](https://hermes-agent.nousresearch.com/docs/user-guide/features/built-in-plugins) | Codex OAuth、凭据导入、失效处理和 OAuth 图像生成的项目说明 | 参考能力组织与认证体验；不为单一图像能力引入完整 Agent 产品，不据此推定账号可用 |
| [fal.ai SAM 3](https://fal.ai/models/fal-ai/sam-3/image/api) | 历史核查列出文本、正负点、框、多遮罩及边界框；当时图像入口未列初始遮罩 | 已排除为当前分割接入方案：属于收费云工具，与本地工具费用边界不符。保留调查记录，不作为待实现依赖 |

## 按产品能力定位复用来源

| 产品能力 | 优先复用来源 | 本项目需要负责的部分 |
| --- | --- | --- |
| 节点画布、Prompt、分支、预览与工作流保存 | Node Banana | 业务节点输入输出、上下文传递、兼容检查与局部执行语义 |
| 区域框选、图片标注与查看 | Node Banana 的图像标注编辑能力 | 图片版本与部件绑定、区域和遮罩的区别、完整原画上下文保留 |
| 并排比较、候选浏览 | Node Banana 的 Image Compare / Output Gallery | 人工选择与审核分离、稳定版本引用、失败与重跑不覆盖 |
| 项目保存与导出 | 底座已有文件能力 | 角色资产关系、可迁移引用、来源／推测、优化历史和资产清单 |
| 云端生成、编辑与账号认证 | 已有适配器及官方 API，详见 Provider 核查 | 按真实能力适配、多参考完整传递、未知请求与预算保护 |
| SAM 精细提取 | Meta 模型与社区封装候选 | 本机验证、安装运行成本、修整交互、失败恢复及可选接入 |
| 多视图呈现 | H3 ContactSheet / MiniMax H3 的流程与交互设计 | 使用本项目实际 Provider 验证设计保真，保留原图及逐视图返工 |
| 原画分析、拆件、设计锁定、一致性审核 | 借助云端模型与通用界面组件 | 3D 建模领域规则、结构关系、部件独立上下文、人工更正和验收；已有通用组件不等于这些业务能力已完成 |

## 验证状态

Node Banana 已在隔离快照完成安装、构建、启动及聚焦探针，并以固定提交正式导入产品原型基线。公开说明、源码阅读、模拟请求和文件测试分别提供不同证据，不能替代真实角色生成。

OAuth、真实多参考生成质量与成本仍需账户实测；SAM 按开发任务 CRB-08 独立验证。具体结果只在对应验证报告更新，重要选型变化进入 ADR，本清单同步采用结论。
