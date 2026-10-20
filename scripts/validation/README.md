# 最小闭环评估脚本

候选评估脚本测试**外部候选快照**；下方 OAuth 浏览器脚本测试当前产品。两类都不发送真实云端生成请求，不读取真实 Provider 凭据。候选结果见 [2026-09-10 验证报告](../../docs/validation/minimum-loop-2026-09-10.md)。

## 环境与固定输入

实测 Windows、Node 24.16.0、npm 11.13.0、Python 3.13。候选为 Node Banana `5c0e0ae6150f29a6de819f8d6f1dedba15151f7c`；可从[固定源码归档](https://github.com/shrimbly/node-banana/archive/5c0e0ae6150f29a6de819f8d6f1dedba15151f7c.zip)取得。解压到外置的 `CRB_TEMP_ROOT/validation/`，不要覆盖产品源码。Git 获取受限时使用归档即可，不要求修改网络设置。

从项目根目录运行 PowerShell：

```powershell
. ./scripts/resolve-temp-root.ps1
$tempRoot = Get-CrbTempRoot -RepoRoot (Get-Location).Path
$validationRoot = Join-Path $tempRoot 'validation'
$candidate = Join-Path $validationRoot 'node-banana-5c0e0ae6150f29a6de819f8d6f1dedba15151f7c'
Push-Location -LiteralPath $candidate
npm ci --no-audit --no-fund
npm run build
Pop-Location
python scripts/validation/run_node_banana_probes.py $candidate --report (Join-Path $validationRoot 'node-banana-requirement-probes.json')
```

`run_node_banana_probes.py` 会临时复制探针到候选测试目录，用其 Vitest 和真实 store／执行器运行，最后删除这一个临时文件。不会修改上游生产代码；目标已有同名文件时拒绝覆盖。所有 `fetch` 都被模拟，未预设的请求失败关闭。

退出码：0 全部通过；1 存在需求缺口或测试失败；2 准备错误。当前固定快照预期实测为 3 通过、4 失败，不能将返回 1 当作“脚本无法使用”。后续修改底座应使对应需求通过，而不是改掉断言。

本轮上游聚焦检查命令（在候选目录中）：

```powershell
npm run test:run -- src/store/__tests__/workflowStore.integration.test.ts src/store/execution/__tests__/nanoBananaExecutor.test.ts src/store/execution/__tests__/runWithFallback.test.ts src/store/utils/__tests__/connectedInputs.test.ts src/components/__tests__/AnnotationNode.test.tsx src/components/__tests__/AnnotationModal.test.tsx src/app/api/workflow/__tests__/route.test.ts src/app/api/workflow-images/__tests__/route.test.ts --reporter=json --outputFile=../node-banana-focused-tests.json
```

## 真实本地文件接口

在候选目录启动服务，默认保持仅回环访问：

```powershell
node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3210
```

另一个终端回到本项目根目录：

```powershell
python scripts/validation/probe_local_storage.py --base-url http://127.0.0.1:3210 --output $validationRoot
```

脚本只接受回环 HTTP 地址，在外置验证目录创建新的 `storage-<随机标识>/` 子目录。使用纯色 PNG，调用候选的本地图片／工作流保存与加载路由；检查二进制内容和 JSON 往返。每次保留独立结果，不删除旧实验；结果文件列出每项通过状态，并单独记录正斜杠路径是否接受。

退出码：0 原生路径存储检查通过；1 检查失败；2 本地准备错误。正斜杠路径是单独的特征记录，不计入原生路径通过数。控制台和 `result.json` 返回本次结果位置。服务用 Ctrl+C 停止，不会作为计划任务或开机服务安装。

真实角色图像生成、人工选择和参考包语义需要产品原型及模型师验证；不要把本脚本保存的诊断色块作为出图成果。

## OAuth 产品接入浏览器回归

`oauth-ui.cjs` 自行启动并停止隔离的开发／生产服务，使用真实设置 UI、特权路由、本机 PKCE 回调和受保护存储；只用 `oauth-provider-fixture.cjs` 的显式 Node preload 替换外部 Provider 的页面及令牌响应。不拦截 `/api/oauth`，覆盖浏览器授权、设备码、账号摘要、保存默认入口、取消、退出、切换、清理测试临时叶目录后的跨进程重启恢复及自动刷新。断言未请求生成，拒绝外部网络；不用真实账号，不等同真实 Provider 验收。

需要可用的 Playwright 与 Chromium。可把验证专用依赖装在 `<CRB_TEMP_ROOT>/validation/`，通过 `CRB_PLAYWRIGHT_MODULE` 指向其 Playwright 模块；`CRB_CHROMIUM_PATH` 可指定本机浏览器。无需修改产品依赖或锁文件。`CRB_TEMP_ROOT` 必须先按本机约定设置。

项目根目录运行（无需另开服务）：

```powershell
. ./scripts/resolve-temp-root.ps1
$env:CRB_TEMP_ROOT = [IO.Path]::GetFullPath((Join-Path (Get-Location) '../.tmp'))
$env:CRB_VALIDATION_MODE = 'development'
node scripts/validation/oauth-ui.cjs
```

生产模式先构建：

```powershell
npm run build
$env:CRB_VALIDATION_MODE = 'production'
node scripts/validation/oauth-ui.cjs
```

默认开发端口 3214、生产端口 3215，可用 `CRB_PORT` 覆盖；已占用时拒绝启动，不接管其他服务。回调端口 1455 也须空闲。脚本覆盖任何客户端 ID 环境设置为内置公共客户端，并使用新建的应用私有 `crb-oauth-synthetic-*` 凭据目录，结束时仅删除其自身目录，不读取默认真实凭据。该隔离凭据目录是测试持久存储合约所必需，位于系统应用数据目录；其余证据、日志和临时材料都在 `CRB_TEMP_ROOT`。

退出码 0 通过，1 为准备／验证失败；`--help` 显示参数。证据写入 `<CRB_TEMP_ROOT>/validation/issue-10-browser-oauth/<模式>/`，包含截图、服务日志和明确区分合成边界的结果 JSON。预加载夹具不被产品代码导入，不改变正常启动。不得将它用于真实登录。历史云端结果及本轮本机验收见 [#10 验证记录](../../docs/validation/security-gate-issue-10.md)。

重启续期检查使用 60 秒合成有效期：停止首个服务后进入 30 秒续期窗口，再启动新进程。独立合成审计只记录服务代次与刷新事件，断言重启前没有刷新、重启后仅一次且来自第二代服务；不会把重启前已续期的令牌当作重启后刷新成功。

## Windows 跨用户凭据隔离

`.github/workflows/windows-dpapi.yml` 在一次性 `windows-2025` GitHub-hosted runner 运行真实产品 DPAPI 存储。通过 GitHub Actions 手动触发或匹配路径的 PR 触发；不在日常电脑执行用户创建。`windows-dpapi.ps1` 必须同时具备 `-CreateTestUser`、GitHub Actions、Windows 和 `RUNNER_ENVIRONMENT=github-hosted` 标志，自托管 runner 也被拒绝。

测试只用新建合成值，验证第二个 SID 可读取同一密文、该身份自身 DPAPI 可用、无法解密原用户密文、产品读取为空且原用户仍能解密。临时普通用户及任务叶目录按 SID／路径检查后清理，结果 JSON 保留七天，不上传凭据。首次产物上传曾因包含 `..` 的路径失败，工作流已改用规范化绝对结果路径；只有整项成功的运行可作为验收证据。

## 本人监督的真实 OAuth 生命周期

```powershell
$env:CRB_TEMP_ROOT = [IO.Path]::GetFullPath((Join-Path (Get-Location) '../.tmp'))
node scripts/validation/oauth-live-lifecycle.cjs --live
```

需要 Windows／Node 24；不带 `--live` 时拒绝执行，`--help` 说明参数，`--check-runtime` 只加载生产模块。脚本使用全新应用私有凭据目录及独立回调，授权链接留在任务私有文件，由本人打开并完成登录；不读取日常账号或其他应用认证文件，不发起模型请求。缩短的仅是第一次恢复读取的过期元数据，真实 token、HTTPS 交换、轮换和并发单飞保持生产实现；报告明确标注受控过期触发，不声称自然等待到期。

脚本还在真实刷新返回后暂存结果，开始新登录代次再释放，验证旧结果／许可失效，最后本地退出并确认不可恢复；不等同切到第二个真实账号。添加 `--denial-only` 时只等待本人在服务商页面拒绝，要求真实拒绝回调、零交换／刷新、无账号和回调释放。服务商取消按钮若直接回到 ChatGPT 而不回调，该检查会因本地等待到期失败；本人取消的观察和未收到拒绝回调应分别记录，不能把超时改写为 `access_denied` 验收通过。

结果位于 `<CRB_TEMP_ROOT>/scratch/crb-issue-10-acceptance/live-lifecycle-*/`。私有授权链接成功后删除，凭据经该隔离适配器正常退出清除；不远端撤销，不改变日常登录。退出码 0 表示所记录范围通过，1 为准备／验证失败；不同账号、拒绝回调和图像能力各自验收。
