# 最小闭环评估脚本

这些脚本测试**外部候选快照**，不代表本项目已实现应用。不会发送云端生成请求，也不会读取 API Key。结果见 [2026-09-10 验证报告](../../docs/validation/minimum-loop-2026-09-10.md)。

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
