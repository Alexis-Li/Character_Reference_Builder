# Issue tracker: GitHub

本项目的需求任务、规格和问题使用 [GitHub Issues](https://github.com/Alexis-Li/Character-Reference-Builder/issues)。仓库标识为 `Alexis-Li/Character-Reference-Builder`，远端为 `origin`；已于 2026-09-09 验证 Issues 已启用。

## 操作约定

使用已认证的 `gh` CLI。命令显式指定 `--repo Alexis-Li/Character-Reference-Builder`，避免误操作其他仓库。

- 读取：`gh issue view <number> --repo Alexis-Li/Character-Reference-Builder --json number,title,body,labels,comments,state`
- 列表：`gh issue list --repo Alexis-Li/Character-Reference-Builder --state open --json number,title,body,labels`；按任务增加标签或状态过滤。
- 创建：`gh issue create --repo Alexis-Li/Character-Reference-Builder --title "..." --body-file <file>`。
- 评论：`gh issue comment <number> --repo Alexis-Li/Character-Reference-Builder --body-file <file>`。
- 标签：`gh issue edit <number> --repo Alexis-Li/Character-Reference-Builder --add-label "..."` 或 `--remove-label "..."`。
- 关闭：`gh issue close <number> --repo Alexis-Li/Character-Reference-Builder`。

多行正文先在 `CRB_TEMP_ROOT/scratch/` 写入临时 UTF-8 文件，再通过 `--body-file` 传入，使用后清理。不要将正文拼接进 shell 命令，也不要在仓库根目录建立临时正文。

Skill 所说的“发布到 issue tracker”指创建 GitHub Issue；“读取相关 ticket”指读取对应 Issue 及评论。写操作必须在当前任务授权范围内，本配置不授予创建 Issue、评论或变更标签的额外权限。若当前环境无法访问 GitHub，可先准备本地草稿并说明未发布，不自动切换任务系统。

## Pull requests as a triage surface

**PRs as a request surface: no.**

PR 不作为需求分诊入口。GitHub 的 Issue 和 PR 共用编号空间，读取裸编号前应确认对象类型。
