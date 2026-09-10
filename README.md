# Character Reference Builder

面向 3D 角色与服装建模的节点式 AI 参考图工具：将角色原画整理为 A-pose、多视图、部件参考和一致性检查结果，帮助模型师补全设计信息。

产品优先级：**保持原设计 > 补充不可见信息 > 美化画面**。

当前处于可行性验证与原型准备阶段，尚无本项目的可运行产品应用。产品需求已明确混合执行与 Provider 边界；2026-09-10 已试跑 Node Banana 并确定有边界的二次开发起点。真实模型质量、调用成本与完整生产闭环仍待验收。

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

`docs/adr/` 已记录原型底座决定。根目录 `data/` 存放本机角色项目与输入输出，以及隔离验证的上游快照、依赖和日志，默认被 Git 忽略。

工作流、提示词和参考模板是产品的可复用内容，因此独立归档在 `presets/`。源码目录将在首批基线任务中按已记录的底座决定划分；候选应用尚未导入产品目录。

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

## 当前验证状态

候选 Node Banana 安装、生产构建和本机启动通过；聚焦上游测试 258 项中 244 通过、14 项路径相关失败；新增需求探针 7 项中 3 通过、4 项不满足 PRD；真实本地文件检查 7 项通过。详见验证报告，不能将其解释为生产闭环已通过。

复跑入口见 [验证脚本说明](scripts/validation/README.md)。产品应用尚未导入，当前根目录没有应用安装／启动命令；脚本针对隔离的候选快照运行，不调用云端生成服务。

## 工程 Skills

已配置 GitHub Issues、分诊标签映射和单上下文领域文档布局。`to-tickets`、`to-spec`、`triage` 等技能可通过 `AGENTS.md` 找到配置；实际调用取决于当前环境是否安装相应技能。

配置可直接在 `docs/agents/` 修改。当前只设置本地约定，没有创建远端 Issue 或标签。
