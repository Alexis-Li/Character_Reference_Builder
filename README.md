# Character Reference Builder

面向 3D 角色与服装建模的节点式 AI 参考图工具：将角色原画整理为 A-pose、多视图、部件参考和一致性检查结果，帮助模型师补全设计信息。

产品优先级：**保持原设计 > 补充不可见信息 > 美化画面**。

当前处于前期需求定义阶段，尚无可运行应用。PRD V0.2 已整理产品流程、MVP 范围和验收要求，处于正式立项前评审；实际模型能力、使用条件和技术选型尚待验证。

## 项目入口

- [产品需求 V0.2](<docs/AI Character Reference Builder 产品需求设计方案（PRD）V0.2.md>)：当前产品需求与验收要求。
- [产品需求 V0.1](<docs/AI Character Reference Builder 产品需求设计方案（PRD）.md>)：初始草案，保留原文。
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
│   ├── …（PRD）.md               # 现有产品草案，保留原位置
│   └── agents/                   # Issue、标签、领域文档消费规则
├── presets/
│   ├── README.md                 # 预设职责与候选内容
│   ├── workflows/                # 可复用工作流
│   ├── prompts/                  # 通用提示词预设
│   └── references/               # 部件参考图模板
├── assets/                       # 应用自带静态素材
├── scripts/                      # 工程辅助脚本
├── src/                          # 源码，暂不按技术栈细分
└── tests/                        # 自动化测试及夹具
```

`docs/adr/` 在产生实际架构决策时创建。根目录 `data/` 留给本机角色项目、输入原画、遮罩、生成结果及导出文件，按需创建且默认被 Git 忽略。

工作流、提示词和参考模板是产品的可复用内容，因此独立归档在 `presets/`。源码目录在评估复用底座后再划分，避免提前确定前后端或多包结构。

## 开发约定

- 开始工作前阅读 [AGENTS.md](AGENTS.md)。
- 依产品范围确定技术栈后，补充依赖清单、锁文件及安装、启动、构建、测试命令。
- 按实际需求细分目录；当前空目录使用 `.gitkeep` 跟踪，加入实际文件时移除占位文件。
- `assets/` 仅存放可提交的项目素材。用户上传、生成图像及其他运行时数据使用根目录 `data/`，该目录默认被 Git 忽略。
- 本机环境配置使用 `.env` 或 `.env.*`；需要配置时提供无真实凭据的 `.env.example`。

## 当前验证状态

尚无应用代码、依赖、构建流程或自动化测试。当前仅完成工程目录及协作约定初始化；文档结构检查不代表产品功能验证。

## 工程 Skills

已按 `setup-matt-pocock-skills` 配置 GitHub Issues、分诊标签映射和单上下文领域文档布局。`to-tickets`、`to-spec`、`triage` 等技能可通过 `AGENTS.md` 找到配置；实际调用取决于当前环境是否安装相应技能。

配置可直接在 `docs/agents/` 修改。当前只设置本地约定，没有创建远端 Issue 或标签。
