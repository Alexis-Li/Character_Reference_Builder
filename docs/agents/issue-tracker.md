# Issue、PR 与归档流程

本项目使用 [GitHub Issues](https://github.com/Alexis-Li/Character_Reference_Builder/issues) 管理任务。2026-10-19 通过本机 `origin` 和 `gh repo view` 核实仓库标识为 `Alexis-Li/Character_Reference_Builder`，默认分支为 `main`。在本项目 checkout 中使用已认证的 `gh`，命令显式指定 `--repo Alexis-Li/Character_Reference_Builder`；API 请求显式写入相同仓库标识。

**PRs as a request surface: no.** PR 不作为需求分诊入口，但承载实现交付与代码审核。Issue 和 PR 共用编号空间，处理裸编号前确认对象类型。Skill 所说的“发布到 issue tracker”指创建 GitHub Issue，“读取相关 ticket”指读取 Issue 正文及相关评论。

## 从需求到完成

1. **界定任务。** 阅读产品需求、Issue 正文、已有汇总和后续报告，列出可观察的验收条件、排除项和依赖。复杂任务使用稳定的 `AC-01` 等编号；旧任务可引用原文。区分实现建议与已同意要求，不自行扩大原型验收。简单本地修正无需为了流程新建 Issue。
2. **选择交付范围。** 功能、较大修复或与其他任务重叠的工作，从目标集成分支建立 `codex/<任务名>` 分支并通过 PR 交付。小型独立改动可用当前分支并明确提交范围。切换前检查未提交工作；并行写入使用隔离 checkout 和明确文件归属，不切换其他任务的工作分支。
3. **交付可审核结果。** 记录比较基线、交付 HEAD 的完整 SHA、目标分支、行为变化、实际检查和剩余缺口。PR 使用[仓库模板](../../.github/pull_request_template.md)，Issue 链接该交付；无 PR 时在 Issue 发布开发报告。未提交交付注明基线、完整 diff 与相关未跟踪文件，不能称为已审核提交。
4. **审核实际差异。** 对照验收阅读指定基线的完整 diff、调用方和测试，检查兼容性、失败恢复、资产保留、付费重试及无关变更。审核结论须有代码与证据支持。自测不自动等于审核通过；需要独立审核的任务未取得该结论时保留待审核状态。
5. **集成已审结果。** 集成前重查任务 HEAD、目标分支变化、冲突解决及受影响检查。记录最终集成 SHA；squash／rebase 后仍保留原审核范围。直接分支交付也检查相同条件，不能以代码已在分支上代替审核。
6. **完成任务。** 同意的验收已覆盖、阻塞已解决且代码位于约定集成分支后才可关闭。研究／原型按自身交付物验收。关闭记录链接最终审核和集成结果；主线里程碑、真实 Provider／人工验收和版本发布按各自范围判断，不能互相替代。

提交、推送、PR 创建、发布评论、合并、关闭和删除均服从当前任务授权；本文件不扩大授权。GitHub 不可用时准备本地草稿，说明未发布并保留证据，不切换任务系统，也不把本地完成写成远端已完成。

## 审核基线与验证

- 审核绑定完整比较基线、HEAD 和具体范围。后续改动需要增量审核与相关检查；目标分支漂移和冲突解决也可能使旧证据失效。复用历史结果须说明代码与前提仍适用。
- 合并命令使用 `gh pr merge <编号> --repo Alexis-Li/Character_Reference_Builder --match-head-commit <已审核完整SHA>`，另行检查目标分支与实际合并结果；该选项只保护 PR HEAD。[CLI 说明](https://cli.github.com/manual/gh_pr_merge)。
- 默认使用 `Refs #<编号>`。仅在合入默认分支即可满足整个 Issue 关闭条件时用 `Closes #<编号>`；开发分支交付或仍待真实验收时保留显式关闭步骤。[GitHub 关联规则](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)。
- 报告分别标明已实现、已审核、已集成、实机／真实 Provider 已验收、已发布。局部审核通过可以与整项待验证并存。审核使用作者账号发布时以评论记录基线和结论，不冒充独立 GitHub approval。
- 先运行受影响测试，实现稳定后按改动完成 `npm run build`、`npm run test:run` 及相关浏览器／Windows 检查。命令和条件见 [README](../../README.md)、[验证入口](../../scripts/validation/README.md)。后续改动可能使结果失效才重跑对应检查。
- 文档改动按[文档维护检查](documentation.md#维护检查)验证；不声称存在未配置的 CI 或自动报告门禁。真实资料、Provider、账号、费用和人工判断仍需各自证据。

## 报告与接手

Issue 正文维护任务范围与验收，产品需求变更同步[唯一正文](../product-requirements.md)。PR 承载详细差异、审核问题与检查；Issue 更新只需状态、交付／审核链接及剩余验收缺口。一次交付和一次明确审核不需要额外汇总。多轮返工、部分验收或相互矛盾的结论难以接手时，维护一条“当前结论”并在 Issue 正文链接。

正式交付、审核或汇总采用下列最小结构，进展、提问和链接更新可用普通评论。没有引入隔壁仓库的 `tools/issue_report.py`，不要求不可运行的生成／校验命令。

| 报告 | 状态 | 内容 |
| --- | --- | --- |
| 开发交付 | 待审核／部分完成／受阻 | 行为结果与 AC／问题对应、验证与证据边界、剩余事项、下一步 |
| 审核结论 | 通过／需修改／证据不足 | 审核范围和结论、问题及关闭条件、验证依据、是否支持整项关闭 |
| 当前结论 | 进行中／待审核／修复中／待验证／受阻／可关闭／已关闭 | 未闭环事项、已验收能力及限制、验收与来源映射、接手入口和记录索引 |

每份正式报告注明：状态；完整基线和本地／远端可用性；覆盖范围；需求与来源链接；阻塞项或“无”；本次验证为本轮执行／历史复核／混合／未执行；实际更新日期 `YYYY-MM-DD`。汇总区分最新实现、最新审核及集成状态；仅整理评论不算重新执行测试。

- 多轮报告可用首行标识 `<!-- crb-report kind=development key=dev-01 -->`、`kind=review key=review-01`、`kind=summary key=current` 定位。新交付、审核基线或实质结论使用新键，同范围笔误或补充证据就地修正；汇总固定 `current`。旧评论不强制回填标识。
- 先读取已有问题，再分配 Issue 内稳定的 `R-001` 等编号。说明触发、影响、证据、严重度、是否阻塞及完成条件；修复沿用编号，状态为未解决、已修复待复验、已复验关闭或不采纳（附证据／授权决定）。实施者声称修复不等于复验关闭。
- 区分已确认缺陷、待验证风险、验收缺口和后续候选；候选不经范围决策不得升级为本项阻塞。保留人工决定和未解决异议，不用汇总掩盖分歧。
- 记录实际命令、环境、跳过／失败项、夹具限制和证据适用性。原画事实与推测、模拟调用与真实调用、功能路径与质量／成本验收须明确分开。

## 安全发布与常用命令

```powershell
gh issue view <编号> --repo Alexis-Li/Character_Reference_Builder --json number,title,body,labels,comments,state
gh issue list --repo Alexis-Li/Character_Reference_Builder --state open --json number,title,labels,state
gh api --paginate repos/Alexis-Li/Character_Reference_Builder/issues/<编号>/comments
gh pr view <编号> --repo Alexis-Li/Character_Reference_Builder --json number,title,body,baseRefName,headRefOid,state
gh pr diff <编号> --repo Alexis-Li/Character_Reference_Builder
```

- 完成授权内的写操作时，Issue 创建／评论使用 `gh issue create`／`gh issue comment <编号>`，PR 创建使用 `gh pr create --base <目标分支>`，均加显式 `--repo` 和 `--body-file <草稿>`。标签通过 `gh issue edit` 的 `--add-label`／`--remove-label`，关闭通过 `gh issue close`；[标签映射](triage-labels.md)使用前核对。
- 多行 UTF-8 草稿放在 `<CRB_TEMP_ROOT>/scratch/crb-<任务>/`，通过 `--body-file` 传入，不拼接进 shell 命令。不提交凭据、个人素材、机器路径或原始日志；路径使用仓库相对路径或 `<CRB_TEMP_ROOT>` 等占位符。
- 发布正式报告前分页读全评论，按种类／键确认是否已有记录。共享账号不得用 `--edit-last`。修改前通过 `gh api repos/Alexis-Li/Character_Reference_Builder/issues/comments/<评论ID>` 核对 `issue_url`、作者、标识、正文及 `updated_at`；写入前再读一次并协调并发修改。
- 修改评论通过 UTF-8 JSON 文件和 `gh api --method PATCH ... --input <文件>` 传完整正文。发布后读回正文／标识并记录 URL；超时或结果不明先查询再重试，避免重复评论。同一 Issue 串行写入；已有多人协作时由协调者发布汇总，读后写本身不构成原子锁。
- 源报告被实质替换前按下节保存。草稿在发布核验和所需证据保全后才按任务归属清理；发布失败保留草稿并说明下一步。

## 归档与清理

普通关闭保留交付和审核来源，只更新必要的汇总与长期知识；不自动删评论、建归档包或清空临时目录。“归档／整理／收尾”按任务范围处理下列步骤，并区分验收完成与归档完成。未授权的远端修改或删除保留为待处理，不因本规则自动执行。

1. **盘点。** 分页读取 Issue、报告及引用证据，检查任务专属 scratch 和已知输出，确定归属及仍在使用的内容；不遍历清理其他项目的共享临时产物。
2. **保全。** 将唯一决定和必要证据并入[既有维护位置](documentation.md#信息归属)。将拟实质替换／删除的源评论完整保存，包含仓库及 Issue、原 ID、作者、创建／更新时间、URL、完整正文和归档日期／用途。保留人工讨论、决定及未解决异议；不得把摘要当作原始来源。
3. **核验可恢复性。** 归档按授权提交／发布后，比较远端可访问的不可变版本与源正文及身份字段；再发布并读回最终汇总。更新指向待移除评论的现役链接，改为能定位原 ID 的归档引用。只有本地备份或 GitHub 不可用时保留原评论，相关删除仍未完成。
4. **明确清理对象。** 列出拟删除的过时 Agent 报告 ID、本地冗余材料及任务专属临时文件，说明保留依据。删除授权不足时保留现场；需要确认时以具体清单请求，不把归档自动等同删除批准。删除前重读评论，检查是否被他人更新；本地路径规范化后验证位于已授权的任务目录。
5. **执行与复核。** 在授权内按精确 ID／路径清理；保留最终汇总、人工讨论和仍有效证据。分页核对剩余评论，检查归档链接和临时目录，包括本轮新产生的辅助脚本与草稿。报告实际保留／删除数量、发布状态、未完成项及留存临时材料的原因与下一步。

只有将要替换／删除来源时才需要评论源归档。按主题放在 `docs/validation/` 对应记录旁，现有不可变引用继续有效；先检查秘密和私人资料，不能为保留原文而发布凭据。若原文不适合公开，保留原评论并说明归档受阻，不能悄悄脱敏后声称是完整原文。分支／worktree 清理另核对唯一改动、远端可恢复性及授权，不能只看 Issue 已关闭。
