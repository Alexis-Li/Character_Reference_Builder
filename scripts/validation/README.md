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

`oauth-ui.cjs` 验证当前产品的真实回环 HTTP 会话／来源边界及合成 OAuth 设置路径。启动前不要配置真实客户端身份；脚本先检查原生入口未就绪，再拦截授权状态及外部页面为合成值。覆盖连接、轮询、账号摘要、保存默认入口、切换和取消，断言登录不生成；不登录真实账号，不等同真实 Provider 验收。

需要可用的 Playwright 与 Chromium。可把验证专用依赖装在 `<CRB_TEMP_ROOT>/validation/`，通过 `CRB_PLAYWRIGHT_MODULE` 指向其 Playwright 模块；`CRB_CHROMIUM_PATH` 可指定本机浏览器。无需修改产品依赖或锁文件。`CRB_TEMP_ROOT` 必须先按本机约定设置。

开发终端：

```powershell
$env:CRB_PORT = '3212'
npm run dev
```

验证终端（项目根目录）：

```powershell
$env:CRB_BASE_URL = 'http://127.0.0.1:3212'
$env:CRB_VALIDATION_MODE = 'development'
node scripts/validation/oauth-ui.cjs
```

停止开发服务，再运行 `npm run build`、`npm run start`；将 `CRB_BASE_URL` 改为 `http://127.0.0.1:3210`、`CRB_VALIDATION_MODE` 改为 `production` 后复跑。退出码 0 表示通过；证据写入 `<CRB_TEMP_ROOT>/validation/issue-10-oauth/<模式>/`。设备用户码及账号摘要全部为合成值，结果 JSON 明确标记拦截范围。云端结果与待本机项目见 [#10 验证第 13 节](../../docs/validation/security-gate-issue-10.md#13-2026-10-05-云端产品接入验证)。
