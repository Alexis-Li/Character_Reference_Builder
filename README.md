# Character Reference Builder

面向 3D 角色与服装建模的节点式 AI 参考图工具：将角色原画整理为 A-pose、多视图、部件参考和一致性检查结果，帮助模型师补全设计信息。

产品优先级：**保持原设计 > 补充不可见信息 > 美化画面**。

当前已有可运行的 Node Banana 固定快照原型基线，可在 Windows 本机启动。产品需求已明确混合执行与 Provider 边界；真实模型质量、调用成本与完整生产闭环仍待验收。

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
├── .editorconfig
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
├── scripts/validation/           # 候选快照探针与本地存储验证
├── src/                          # 源码，暂不按技术栈细分
└── tests/                        # 自动化测试及夹具
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

## 当前验证状态

固定 Node Banana 基线的干净安装、生产构建、122 个测试文件共 2585 项测试和 Windows 本机启停已经通过。导入前的需求探针仍记录 P04–P07 四项业务缺口；真实模型质量、费用和完整生产闭环尚未通过。详见验证报告和 CRB-01 基线说明。

复跑入口见 [验证脚本说明](scripts/validation/README.md)。其中的探针针对外置的隔离候选快照运行，不调用云端生成服务；当前产品基线的安装与启动命令见上文。

## 工程 Skills

已配置 GitHub Issues、分诊标签映射和单上下文领域文档布局。`to-tickets`、`to-spec`、`triage` 等技能可通过 `AGENTS.md` 找到配置；实际调用取决于当前环境是否安装相应技能。

配置可直接在 `docs/agents/` 修改。首批原型总规格与 8 项开发任务已发布到 GitHub Issues、分配给 `Alexis-Li`，并使用 `ready-for-agent` 标签；当前实现状态仍以各 Issue 和验证结果为准。
