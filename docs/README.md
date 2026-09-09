# 文档索引

| 文档 | 职责 | 当前状态 |
| --- | --- | --- |
| [产品需求 V0.2](<AI Character Reference Builder 产品需求设计方案（PRD）V0.2.md>) | 当前产品目标、场景、节点职责、MVP 及验收要求 | 正式立项前需求评审稿；第三方已做公开资料核查，实际能力与使用条件待验证 |
| [产品需求 V0.1](<AI Character Reference Builder 产品需求设计方案（PRD）.md>) | 初始产品设想 | 历史草案，保留原文；当前需求以 V0.2 为准 |
| [领域词汇表](../CONTEXT.md) | 统一角色项目、部件、参考资料等术语 | 根据草案整理，不含实现方案 |
| [Issue tracker](agents/issue-tracker.md) | GitHub Issues 的定位与操作约定 | 已配置 |
| [Triage labels](agents/triage-labels.md) | 分诊角色到真实标签名称的映射 | 已检查远端，部分标签尚未创建 |
| [Domain docs](agents/domain.md) | 领域词汇和 ADR 的阅读规则 | 单上下文布局 |
| [预设说明](../presets/README.md) | 工作流、提示词和参考图模板的归档职责 | 目录就绪，格式与内容待设计 |

`docs/adr/` 按需记录真实且重要的架构取舍；本次仅整理工程，不创建技术选型 ADR。后续研究、规格和操作文档在有实际内容时新增，并更新此索引。

Node Banana、OAuth 复用库及云端模型服务的公开资料核查见 PRD V0.2 附录。它们仍是候选，尚未完成账号登录、真实模型调用或完整用户路径验证，也未引入运行依赖。
