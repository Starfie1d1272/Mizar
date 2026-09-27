RivalHub Broadcast Windows x64 便携版

本产品包绑定 git SHA <SHORT_SHA>，并内置 Node <NODE_VERSION>。解压到可写目录后，双击 RivalHub Broadcast.exe 打开制播工作区。
不需要安装 Node 或 pnpm。程序只使用 http://127.0.0.1:3000；重复打开会复用同版本服务。关闭工作区窗口后可从托盘重新打开；选择托盘“退出”才停止服务。

正常制作：

1. 初次接入 CS2 前，在此目录运行：powershell -ExecutionPolicy Bypass -File .\resources\scripts\install-gsi.ps1 -Product
   自动查找 Steam 库；存在多个 CS2 时，加 -Cs2Root "CS2 安装目录" 明确选择。安装前先停止服务。
2. 双击 RivalHub Broadcast.exe；左栏、底栏围绕 CS2 窗口展开。浏览器预览可打开 http://127.0.0.1:3000/workspace。
3. 在工作区连接 OBS，使用“检查配置”和“一键修复”创建制播场景。OBS Browser Source 由工作区按 Program Scene 清单配置；Gameplay 为 http://127.0.0.1:3000/program。
4. 停止服务：powershell -ExecutionPolicy Bypass -File .\resources\scripts\stop-product.ps1
5. 恢复安装前的 GSI 配置：停止服务后运行 powershell -ExecutionPolicy Bypass -File .\resources\scripts\restore-gsi.ps1 -Product

resources 是程序资源，不能保存运行数据。设置保存在 state\data，日志在 state\logs，验收记录在 state\evidence。
可使用 BROADCAST_STATE_ROOT 指向其它绝对运行目录；首次启动与后续脚本必须使用同一设置。请保留 state 以保留 HUD 和系列进度。
端口被其它程序占用时先停止占用程序；不会静默换端口。文件缺损时重新解压完整 ZIP。日志可用于诊断启动失败。

现场验收模式（先停止正常制作服务）：

操作步骤：

1. 在此目录打开 PowerShell。
2. 执行：`powershell -ExecutionPolicy Bypass -File .\resources\scripts\install-gsi.ps1`
   安装器会读取 Steam 库信息并寻找 CS2。若无法唯一定位，请使用 `-Cs2Root <path>` 指定 CS2 安装根目录或 `game\csgo\cfg`。
3. 执行：`powershell -ExecutionPolicy Bypass -File .\resources\scripts\start.ps1`；这会启动常规现场验收。若要进行目标时钟专项验收，执行：`powershell -ExecutionPolicy Bypass -File .\resources\scripts\start.ps1 -ObjectiveTiming`。
4. 打开 http://127.0.0.1:3000/qualification。
5. 按页面依次完成：播放 Demo A → 在 CS2 中执行 `quit` → 等待页面显示比赛数据已过期（即一段时间未收到新的有效数据）→ 确认已退出 CS2 → 开始下一场 → 重开 CS2 → 播放 Demo B → 导出结果。
6. 页面会自动整理并验证验收证据、恢复原 GSI 配置，然后显示“通过”“失败”或“证据不足”以及报告路径。
7. 最终证据写入 `state\evidence\<runId>\`；`REPORT.md` 是便于人工阅读的报告，`qualification.json` 是机器可读结果。

目标时钟专项验收的八类场景需要使用 `resources\scripts\mark.ps1` 记录开始与结束。重连或接收端重启场景的操作顺序是：先在已下包或拆弹状态记录 `-Phase before`，实际重连或重启接收端后执行 `resources\scripts\rotate.ps1`，等待新的已下包观测，再记录 `-Phase after`。`rotate.ps1` 会在同一轮现场验收中开始新的采集记录并推进 Program 数据来源代际，不会新建验收轮次；没有新代际的正常观测时，结束标记会被拒绝。

备用自动化命令：

  `powershell -ExecutionPolicy Bypass -File .\resources\scripts\mark.ps1 demo-a-live`
  `powershell -ExecutionPolicy Bypass -File .\resources\scripts\check.ps1 -WaitForStale`
  `powershell -ExecutionPolicy Bypass -File .\resources\scripts\mark.ps1 cs2-closed`
  `powershell -ExecutionPolicy Bypass -File .\resources\scripts\mark.ps1 cs2-reopened`
  `powershell -ExecutionPolicy Bypass -File .\resources\scripts\stop.ps1`

验收服务只监听本机回环地址的 3000 端口。现场不需要、也不应修改代码或查看原始 JSON。
访问令牌与验收控制令牌不会写入最终报告。正常流程由验收管理进程负责结束服务、验证证据、恢复配置和清理临时状态；只有该流程不可用时，`stop.ps1` 才作为备用入口。
