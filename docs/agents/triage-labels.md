# Triage Labels

`triage` 是否可用以当前会话技能列表为准。以下映射基于 2026-09-10 对 `Alexis-Li/Character-Reference-Builder` 远端标签的检查。

| Skill 中的角色 | 本仓库标签名称 | 含义 | 远端状态 |
| --- | --- | --- | --- |
| `needs-triage` | `needs-triage` | 等待维护者评估 | 尚未创建，采用默认名称 |
| `needs-info` | `question` | 等待报告者补充信息 | 已存在，说明为 Further information is requested |
| `ready-for-agent` | `ready-for-agent` | 规格明确，可交给 Agent 实施 | 已创建并用于首批开发任务 |
| `ready-for-human` | `ready-for-human` | 需要人工实施 | 尚未创建，采用默认名称 |
| `wontfix` | `wontfix` | 不予处理 | 已存在 |

Skill 使用角色名时，转换为此表中的仓库标签。例如 `needs-info` 对应现有 `question`，不另建同义标签。

首次应用尚未创建的标签前，重新检查远端是否已有等价标签；只有现有任务授权包含标签管理时才创建，否则准备变更并请求所需授权。不要把未创建的标签当作已可使用。

`bug`、`enhancement`、`documentation` 等现有分类标签继续保留，与以上分诊角色分别使用。
