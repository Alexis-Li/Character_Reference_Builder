# Character Reference Builder

面向 3D 角色与服装建模的节点式 AI 参考图工具：将角色原画整理为 A-pose、多视图、部件参考和一致性检查结果，帮助模型师补全设计信息。

产品优先级：**保持原设计 > 补充不可见信息 > 美化画面**。

当前本地 `main` 已完成 CRB-01–CRB-06 的实现与本地验收：可在 Windows 本机启动，具备角色资产版本、能力化 Provider、保守请求恢复、单部件生成／连续优化，以及可迁移保存、恢复和参考包导出。CRB-06 已按二次审查结论完成中文文本边界的路径清理整改，远端 Issue 待复验；真实模型质量与调用成本仍待 CRB-07 验收。

产品范围聚焦图像参考的理解、生成、编辑、比较与交付。音频和视频的导入、生成、编辑、工作流节点、Provider 能力与输出均不属于产品范围；源码中仍可能存在随上游快照导入的相关实现，它们是待清理的迁移残留，不代表候选能力或后续路线。LLM 用于图像理解、推理和业务任务，ComfyUI 仅作为可选执行后端单独评估。

## 项目入口

- [产品需求](docs/product-requirements.md)：功能、前端交互、范围与验收的唯一入口。
- [最小闭环验证](docs/validation/minimum-loop-2026-09-10.md)：实测结果与未通过项。
- [技术选型](docs/adr/0001-minimum-loop-foundation.md) / [首批开发任务](docs/first-development-tasks.md)：原型决定和执行顺序。
- [文档索引](docs/README.md)：文档职责与状态。
- [领域词汇表](CONTEXT.md)：角色项目、部件、参考图等统一术语。
- [协作约定](AGENTS.md)：项目规则和工程 Skill 配置入口。
- [GitHub 仓库](https://github.com/Alexis-Li/Character_Reference_Builder) / [Issues](https://github.com/Alexis-Li/Character_Reference_Builder/issues)。

## 目录结构

```text
.
├── AGENTS.md
├── CONTEXT.md                    # 领域词汇表，不放实现方案
├── README.md
├── LICENSE                       # 沿用远端仓库许可证
├── .gitignore
├── docs/
│   ├── README.md                 # 文档索引
│   ├── product-requirements.md   # 统一产品需求（含交互）
│   ├── first-development-tasks.md # 开发顺序与交付要求
│   ├── agents/                   # 文档、Issue／PR、归档、标签与领域规则
│   ├── research/                 # 可复用项目与 Provider 证据
│   ├── validation/               # 验证协议与执行结果
│   └── adr/                      # 已作出的架构取舍
├── presets/
│   ├── README.md                 # 预设职责与候选内容
│   ├── workflows/                # 可复用工作流
│   ├── prompts/                  # 通用提示词预设
│   └── references/               # 部件参考图模板
├── assets/                       # 应用自带静态素材
├── scripts/validation/           # 候选快照探针、浏览器回归与本地存储验证
└── src/                          # 前端、API、领域与工作流执行源码及测试
```

`docs/adr/` 已记录原型底座决定。根目录 `data/` 只存放本机角色项目、用户输入和生成结果等需要保留的运行数据，默认被 Git 忽略。可清理的验证快照、测试输出和运行日志使用外置临时根目录。

工作流、提示词和参考模板是产品的可复用内容，因此独立归档在 `presets/`。Node Banana 固定快照源码已导入 `src/`，后续按业务边界逐步收窄和扩展。

## 开发约定

- 开始工作前阅读 [AGENTS.md](AGENTS.md)。
- 任务交付、审核、集成与归档遵循 [Issue／PR 流程](docs/agents/issue-tracker.md)；文档按[维护与留存规则](docs/agents/documentation.md)就地更新。
- 按 ADR 的固定底座建立原型基线时，补齐依赖清单、锁文件及安装、启动、构建、测试命令。
- 按实际需求细分目录；当前空目录使用 `.gitkeep` 跟踪，加入实际文件时移除占位文件。
- `assets/` 仅存放可提交的项目素材。用户上传、生成图像及其他运行时数据使用根目录 `data/`，该目录默认被 Git 忽略。
- 本机环境配置使用 `.env` 或 `.env.*`；需要配置时提供无真实凭据的 `.env.example`。

## CRB-01 本机运行

Node Banana 固定快照、来源和锁文件记录在 [CRB-01 原型基线](docs/crb-01-baseline.md)。首次安装和验证：

```powershell
npm ci --no-audit --no-fund
npm run build
npm run test:run
```

Windows 用户双击 `start-windows.cmd` 启动本机页面，双击 `stop-windows.cmd` 停止服务。默认服务只绑定 `127.0.0.1:3210`；重复启动会复用已有实例，端口被其他程序占用时会给出进程号和换端口命令。也可运行 `npm run start:windows` 与 `npm run stop:windows`。

## 本机临时目录

`CRB_TEMP_ROOT` 是项目的外置临时根目录。其中 `validation/` 保存可重建的上游验证快照和测试证据，`runtime/` 保存启动状态与日志，`scratch/` 供一次性 Agent 文件使用；这些内容不属于项目资产，可以在不需要复跑或诊断时清理。

每台机器可在被 Git 忽略的 `.env.local` 或进程环境中设置自己的绝对路径。Windows 启动脚本会读取该配置；未配置时回退到操作系统临时目录。`node_modules/` 和 `.next/` 仍留在项目根目录，因为 npm 与 Next.js 工具链直接使用这些标准目录，它们同样可通过重新安装或构建恢复。

## 本机 API 安全边界

本机服务只绑定回环地址，但回环绑定不等于授权：所有会产生云端费用、发送原画资料、读写本机文件、访问可配置后端、写入日志或改变认证状态的 API 都经过同一调用方认证入口。页面请求携带由应用自身签发、绑定来源且不可预测的本机会话能力（HttpOnly、SameSite=Strict，状态变动请求另带一次性 nonce）；非浏览器调用使用独立的 CLI 凭据，不复用会话能力。

- CLI／自动化：令牌优先取 `CRB_LOCAL_API_TOKEN`，否则由应用在 `<CRB_TEMP_ROOT>/runtime/local-api-token` 生成（仅本用户可读，位于仓库之外）。请求头使用 `Authorization: Bearer <token>`。脚本 `scripts/comfy-smoke.mjs` 已按此方式认证。
- 额外主机名：默认只接受回环（`127.0.0.1`、`[::1]`、`localhost`）；确需其他主机名时用 `CRB_ALLOWED_HOSTS` 显式声明。
- 写入范围：媒体与项目写入只能落在已授权的角色项目根目录（`data/`、`CRB_TEMP_ROOT`、用户通过选择器或项目读取确认过的目录，以及 `CRB_DATA_ROOT` / `CRB_PROJECT_ROOTS` 显式配置项）；仓库自身的 `src/`、`public/`、`.next/` 等源码、静态与构建目录永不作为写入目标。
- 媒体下载：只接受已登记 Provider 输出或用户提供的目标，逐跳校验协议、解析地址（回环、私有、链路本地、云元数据一律拒绝）、媒体类型与大小；非媒体响应不会被改名为图片保存。活动 SVG 默认拒绝，导出的 SVG 只能作为下载产物，不在应用来源内联渲染。
- Provider 凭据：请求指定的接收方不会继承服务器环境凭据；引擎凭据与 partner 节点凭据分别绑定各自目标；携密请求不跟随未经策略允许的重定向。刷新令牌等可复用凭据保存在仓库外的受保护存储中，不进入项目、模板、导出、日志或浏览器。

相关约定与状态见 `docs/validation/security-gate-issue-10.md`。

## ChatGPT/Codex 账号接入

启动应用，关闭欢迎弹层，打开设置 → Providers → ChatGPT/Codex → **连接账号 / 重新连接**。应用打开服务商浏览器页面；由你亲自登录、选择账号并确认，完成后本机回调自动连接。已连接区域只显示登录账号和授权有效期，保留退出等操作，更换账号先退出再重新登录；工作区、授权范围及能力／额度详情不在此展示。浏览器阻止新窗口时点击设置中的授权页面链接。无需申请客户端、填写协议参数或粘贴 token。

本机回调仅在登录期间监听 `127.0.0.1:1455`。端口被其他登录占用时，完成／取消那次登录后重试，或选择 **使用设备码登录**；后者由你在服务商页面输入界面显示的用户码，应用自动等待完成。服务商要求启用装置代码登入时，由你本人在 [ChatGPT 安全性设置](https://chatgpt.com/#settings/Security) 开启“Codex、Excel、PowerPoint 和 Word”的装置代码登入，再回本应用重新获取设备码；不需要运行其他应用的登录命令。取消、退出和重新发起登录会使旧回调、刷新及调用许可失效。应用不提供多账号切换入口，已有账号时须先退出。退出属于本地断开，远端授权状态未知；需要时到服务商账号安全设置检查。项目、候选与人工选择保留。

登录资料会在应用重启后恢复，读取账号或调用前按需自动续期；失效时提示退出后重新登录。凭据位于仓库及 `CRB_TEMP_ROOT` 之外的本用户应用目录：Windows 使用 `%LOCALAPPDATA%/CharacterReferenceBuilder/auth` 和 CurrentUser DPAPI；POSIX 使用 `~/.local/share/character-reference-builder/auth`、0700／0600 文件。不导入或修改 Codex、OMP、CC Switch 的现有认证文件。固定社区来源、官方接口比较与使用条件见 [社区复用决策](docs/research/oauth-community-reuse.md)。

连接不生成图片；订阅调用和图像能力分别验收。连接后可选为新图像节点及单部件任务的默认入口并保存，每次生成另行确认资料外发与未知费用。OAuth 图像通道最多三张参考，不支持精确 Mask，不沿用 API Key 价格或能力。真实 Plus 登录及实际图像调用仍需本人参与验收，不能用合成测试代替。

## 单部件参考工作区

关闭首次引导和欢迎弹层后，点击顶部“单部件参考工作区”。导入原画，填写部件归属及有效要求并确认；选择视图生成候选，再并排比较、人工选择、批准、继续优化或导出旧版本。默认预设无需 SAM 或 Mask，载入不自动生成；其他视图的人工选定结果自动作为一致性参考。图像模型沿用现有项目默认设置，也可在画布生成节点中配置。

操作与验证证据见 [CRB-05 验证记录](docs/validation/part-reference-issue-6.md)。功能路径已通过 #6 验收；真实素材、模型效果、成本和 Provider 替换由 CRB-07（#8）继续验证。

项目保存会写入带 SHA-256 的版本化资产清单，图片使用独立文件和相对引用。整个项目目录可直接迁移；打开时单项缺失会提示但不清空其余资产或人工选择。单部件工作区可导出已批准选定结果的参考包，也可显式带状态导出已选但未批准的候选；未运行 SAM 不影响默认参考包。验证证据见 [CRB-06 验证记录](docs/validation/portable-project-issue-7.md)。

## 当前验证状态

ChatGPT/Codex 默认浏览器登录、可选设备码、持久恢复和账号生命周期已接通；本轮 Windows 验证与剩余真实账号验收分别记录在[安全准入验证](docs/validation/security-gate-issue-10.md)。#10 保持打开，原有安全与真实能力验收要求继续有效；没有“普通用户必须先申请独立 client ID”的前置条件。

CRB-05 Edge 浏览器交互、CRB-06 真实临时目录保存／迁移／导出，以及本机特权请求、接收方、媒体与写入边界另有历史验证记录，本轮全量回归继续通过。CRB-06 路径清理覆盖中文标点附近的 UNC、Windows 扩展路径、盘符、`file:` URL、POSIX 绝对路径，保持 HTTPS 来源及相对资产引用。CRB-01 干净安装与 Windows 启停的基线证据不替代本次新增 DPAPI 验收。导入前 P04–P07 是历史缺口，工程路径由 CRB-02–CRB-06 闭合；真实质量和费用仍待 CRB-07，本轮未执行 #8。

复跑入口见 [验证脚本说明](scripts/validation/README.md)。候选探针针对外置快照，新增 OAuth 浏览器脚本针对当前产品且使用合成授权响应；均不调用真实云端生成。安装与启动命令见上文。

## 工程 Skills

已配置 GitHub Issues、分诊标签映射和单上下文领域文档布局；项目入口见 `AGENTS.md`，具体操作约定维护在 `docs/agents/`。首批原型总规格与 8 项开发任务已发布到 GitHub Issues、分配给 `Alexis-Li`，并使用 `ready-for-agent` 标签；当前实现状态仍以各 Issue 和验证结果为准。
