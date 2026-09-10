# CRB-01 原型基线

本文件记录 Issue #2 导入的可复现底座和本机入口。它只描述工程基线，不把 P04–P07 的业务缺口写成已验收。

## 上游固定快照

- 来源：`https://github.com/shrimbly/node-banana`
- 固定提交：`5c0e0ae6150f29a6de819f8d6f1dedba15151f7c`
- 上游版本：`1.9.0`
- 锁文件 SHA-256：`899f6962b230f962218a4123ceff8663131a5407997ebc4d55e0d0321343bdd6`
- 上游许可证：MIT，保存在 `licenses/node-banana.MIT`

项目根目录的 AGPL 许可证仍属于 Character Reference Builder；导入上游代码不会替换项目许可证。

## 本地运行

在项目根目录执行：

```powershell
npm ci --no-audit --no-fund
npm run build
npm run test:run
```

Windows 用户可双击 `start-windows.cmd`。它会启动仅绑定 `127.0.0.1` 的本机页面并自动打开浏览器。再次双击时会复用已经运行的实例；如果默认端口 `3210` 被其他程序占用，会显示占用进程和可执行的换端口提示。

双击 `stop-windows.cmd` 可停止对应的后台进程树。命令行也支持 `start-windows.cmd 3211` 与 `stop-windows.cmd 3211` 使用其他端口。

直接开发运行使用 `npm run dev`，默认同样绑定 `127.0.0.1:3210`；生产构建后可使用 `npm start`，其绑定地址和端口也固定为回环地址与 `3210`。

运行时日志和启动状态写入 `CRB_TEMP_ROOT/runtime/`，不进入项目提交。每台机器通过进程环境或被 Git 忽略的 `.env.local` 配置实际位置；未配置时使用操作系统临时目录。

## 首批导航边界

原始快照中的通用媒体、ComfyUI、社区和多 Provider 实现仍保留，便于后续任务复用；首个导航只暴露原画输入、标注、Prompt、图像生成、图像比较、候选画廊和输出。视频、音频、外部 3D、社区模板和全量模型浏览不出现在首批导航。

## 已知边界

P04 多参考服务端传递、P05 未知结果后的自动回退、P06 失败清空已有结果、P07 重跑覆盖既有选择仍由后续 Issue 处理。本基线只保留验证报告中对这些缺口的如实记录，不宣称产品业务闭环已经通过。
