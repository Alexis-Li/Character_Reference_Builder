# Character Reference Builder

面向 3D 角色与服装建模的节点式 AI 参考图工具：将角色原画整理为 A-pose、多视图、部件参考和一致性检查结果，帮助模型师补全设计信息。

产品优先级：**保持原设计 > 补充不可见信息 > 美化画面**。

当前本地 `main` 已完成 CRB-01–CRB-06 的实现与本地验收：可在 Windows 本机启动，具备角色资产版本、能力化 Provider、保守请求恢复、单部件生成／连续优化，以及可迁移保存、恢复和参考包导出。CRB-06 的远端 Issue 待审查；真实模型质量与调用成本仍待 CRB-07 验收。

产品范围聚焦图像参考的理解、生成、编辑、比较与交付。音频和视频的导入、生成、编辑、工作流节点、Provider 能力与输出均不属于产品范围；源码中仍可能存在随上游快照导入的相关实现，它们是待清理的迁移残留，不代表候选能力或后续路线。LLM 用于图像理解、推理和业务任务，ComfyUI 仅作为可选执行后端单独评估。

## 项目入口

- [产品需求](docs/product-requirements.md)：功能、前端交互、范围与验收的唯一入口。
- [最小闭环验证](docs/validation/minimum-loop-2026-09-10.md)：实测结果与未通过项。
- [技术选型](docs/adr/0001-minimum-loop-foundation.md) / [首批开发任务](docs/first-development-tasks.md)：原型决定和执行顺序。
- [文档索引](docs/README.md)：文档职责与状态。
- [领域词汇表](CONTEXT.md)：角色项目、部件、参考图等统一术语。
- [协作约定](AGENTS.md)：项目规则和工程 Skill 配置入口。
- [GitHub 仓库](https://github.com/Alexis-Li/Character-Reference-Builder) / [Issues](https://github.com/Alexis-Li/Character-Reference-Builder/issues)。

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
│   ├── agents/                   # Issue、标签、领域文档消费规则
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

## 单部件参考工作区

关闭首次引导和欢迎弹层后，点击顶部“单部件参考工作区”。导入原画，填写部件归属及有效要求并确认；选择视图生成候选，再并排比较、人工选择、批准、继续优化或导出旧版本。默认预设无需 SAM 或 Mask，载入不自动生成；其他视图的人工选定结果自动作为一致性参考。图像模型沿用现有项目默认设置，也可在画布生成节点中配置。

操作与验证证据见 [CRB-05 验证记录](docs/validation/part-reference-issue-6.md)。功能路径已通过 #6 验收；真实素材、模型效果、成本和 Provider 替换由 CRB-07（#8）继续验证。

项目保存会写入带 SHA-256 的版本化资产清单，图片使用独立文件和相对引用。整个项目目录可直接迁移；打开时单项缺失会提示但不清空其余资产或人工选择。单部件工作区可导出已批准选定结果的参考包，也可显式带状态导出已选但未批准的候选；未运行 SAM 不影响默认参考包。验证证据见 [CRB-06 验证记录](docs/validation/portable-project-issue-7.md)。

## 当前验证状态

截至 2026-09-15，当前本地 `main` 的生产构建、134 个测试文件共 2723 项测试、CRB-05 Edge 浏览器完整交互回归及 CRB-06 真实临时目录集成回归均已通过；CRB-01 的干净安装与 Windows 本机启停另有基线证据。导入前探针记录的 P04–P07 是历史基线缺口，相关工程路径现已由 CRB-02–CRB-06 闭合；真实模型质量与费用仍待 CRB-07。详见对应验证记录、Issue 和 CRB-01 基线说明。

复跑入口见 [验证脚本说明](scripts/validation/README.md)。其中的探针针对外置的隔离候选快照运行，不调用云端生成服务；当前产品基线的安装与启动命令见上文。

## 工程 Skills

已配置 GitHub Issues、分诊标签映射和单上下文领域文档布局；项目入口见 `AGENTS.md`，具体操作约定维护在 `docs/agents/`。首批原型总规格与 8 项开发任务已发布到 GitHub Issues、分配给 `Alexis-Li`，并使用 `ready-for-agent` 标签；当前实现状态仍以各 Issue 和验证结果为准。
