# 文档索引

产品需求统一维护在一个文件中，前端交互属于其中的一部分。按要回答的问题阅读：

| 文档 | 职责 | 当前状态 |
| --- | --- | --- |
| [产品需求](product-requirements.md) | 用户场景、功能、交互、MVP 范围及验收 | 需求评审稿；图像参考范围已明确，能力实现与质量待验证 |
| [开发任务](first-development-tasks.md) | 实施顺序、依赖与交付要求 | 总规格 #1 保持开启；#2–#6 已验收关闭，#7 已实现待审查，#8–#9 待执行 |
| [技术决策](adr/0001-minimum-loop-foundation.md) | 原型底座及业务、Provider、资产边界的取舍 | 采用 Node Banana 固定快照作为起点；生产准入未通过 |
| [最小闭环验证](validation/minimum-loop-2026-09-10.md) | 验证方法、实际通过项、失败及待验收项 | 工程验证已执行；真实生成质量与成本待验收 |
| [单部件界面验证](validation/part-reference-issue-6.md) | CRB-05 操作路径与浏览器回归 | 功能路径已验收，Issue #6 已关闭；真实 Provider 效果转由 CRB-07 验证 |
| [可迁移项目验证](validation/portable-project-issue-7.md) | CRB-06 真实目录保存、迁移、恢复与参考包导出 | 实现与本地验收通过，Issue #7 待审查 |
| [可复用项目](research/reusable-projects.md) | 社区项目清单、来源与复用边界 | 保留已有研究，区分采用、候选、设计参考和排除方案 |
| [Provider 证据](research/provider-feasibility-2026-09-10.md) | 官方接口与适配器源码核查 | 2026-09-10 核查记录；无真实云端调用 |
| [验证脚本](../scripts/validation/README.md) | 复跑探针和真实文件检查 | 可运行；候选快照存在 4 项已复现需求缺口 |
| [领域词汇表](../CONTEXT.md) | 角色项目、部件、参考资料等术语 | 统一沟通用语，不包含实现方案 |
| [预设说明](../presets/README.md) | 工作流、提示词与参考模板职责 | 默认单部件预设已提供，加载不生成 |
| [Issue tracker](agents/issue-tracker.md) | GitHub Issues 操作约定 | 已配置 |
| [Triage labels](agents/triage-labels.md) | 分诊角色与标签映射 | 远端状态以使用前检查为准 |
| [Domain docs](agents/domain.md) | 领域文档消费规则 | 单上下文布局 |

## 维护方式

- 需求与交互变化直接修改产品需求对应章节，不新增版本副本、补充约束或独立前端需求。
- 开发任务记录实施范围与验收落点，通过引用需求定位产品行为；技术决策记录取舍，验证报告记录证据。
- 文件名保持稳定，需求历史交给 Git；只有独立决策或实测记录需要按编号或日期留存。
- 需求描述不代表功能已实现。导入前探针中的 P04–P07 是历史基线缺口；当前工程路径、真实生成质量、账号条件和 SAM 专项的现役状态以根目录 README、对应验证记录与 Issue 为准。
