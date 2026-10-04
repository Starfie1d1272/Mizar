Mizar Windows x64 便携版

本产品包绑定 git SHA <SHORT_SHA>，并内置 Node <NODE_VERSION>。解压到可写目录后，双击 Mizar.exe 打开准备中心。
不需要安装 Node 或 pnpm。程序只使用 http://127.0.0.1:3000；重复打开会复用同版本服务。关闭工作区窗口后可从托盘重新打开；选择托盘“退出 Mizar”停止服务。若托盘不可用，主窗口标题会提示关闭主窗口将退出，关闭现场工作区则返回主窗口。

正常制作：

1. 双击 Mizar.exe，进入“总览 / 比赛 / 画面 / 设置”准备中心。在“比赛”创建或选择本地比赛；连接 RivalHub 时先在“设置”授权，再到“比赛”选择赛程。
2. 初次接入 CS2 前，在“设置”检测并安装 GSI；自动发现不唯一时明确选择安装目录。安装后重新启动 CS2。
3. 在“设置”连接 OBS，检查配置并修复制播场景。OBS Browser Source 按 Program Scene 清单配置；Gameplay 为 http://127.0.0.1:3000/program。
4. 完成准备后进入现场，左栏、底栏和本机覆盖才围绕 CS2 窗口展开。浏览器预览可打开 http://127.0.0.1:3000/workspace；现场窗口打开失败会保留准备中心，可修复后重试。
5. 如需恢复安装前的 GSI 配置，可在“设置”操作；结束使用时选择托盘“退出 Mizar”。
6. 反馈问题时，进入“设置 → 高级 → 运行诊断 / 导出诊断包”，点击“导出诊断包”，在原生另存为窗口保存 .json 文件。取消或保存失败可重试。包只含有界安全摘要，原始错误留在本机，不包含原始 GSI、选手资料或凭据。GSI/CS2 探测无响应时仍可导出，对应状态保持不可用。

HUD 与节目：

在“画面”打开 HUD 编辑器，选择 Mizar 默认、类 EWC、类 IEM 或类 Perfect World 预设并预览。内置只读，修改后“另存为”；自定义内容“保存”，再“启用当前预设”才改变正式节目。已启用配置重启后恢复，仅保存编辑不会刷新节目。若另存布局，须在预设中选择该布局、保存并启用。
预设页可“导出预设文件”或“导入预设文件”（.mizar-hud.json，最多 256 KiB）。先保存或放弃所有未保存修改；导出要求预览与预设引用一致。文件包含组件设置、布局和受控外观，不含图片、比赛、实时数据或启用状态。导入创建新副本，不覆盖旧配置、不自动上屏；选择副本预览后再启用。无效文件可修正后重试。
左右选手栏分别提供“C4 伤害预测”，内置预设默认开启，修改后保存/另存并启用。预测按当前位置与站立姿态估算，不改变真实 HP，不保证必死/必活。只在已下包/拆弹、未暂停/结束且有效爆炸倒计时大于零、不超过十秒时显示有效伤害覆盖层；伤害为零不绘制覆盖层。
cs2-c4-damage@0.1.0 随包提供 Ancient、Anubis、Cache、Dust II、Inferno、Mirage、Nuke、Overpass、Train、Vertigo 数值资源，无需提取游戏文件或额外下载。数据过期/输入不足、未支持地图、资源缺失/损坏或检测到不一致时隐藏；核对数据、开关和地图，资源问题重新解压完整包，持续异常导出诊断。十图资源校验不是全图实机精度或未来游戏版本兼容保证。
进入现场默认自动编排；“手动切换”选择场景后持续手动保持，明确“恢复自动”才交回控制。自动暂停时先处理提示原因。节目预览不会切 OBS；BP 工作台为 http://127.0.0.1:3000/preview?scene=bp，旧 /operator/bp 转到该入口。
“隐藏现场”保留制作，“恢复现场”恢复；“结束制作”成功切到安全等待并释放数据源后回准备中心，失败可修复重试。推流/录制启停仍由操作者在 OBS 确认。画面页的本机覆盖显隐只影响自己 CS2 上的覆盖，不改变正式节目。

详细操作与故障排查：https://github.com/Starfie1d1272/Mizar/blob/<SHORT_SHA>/docs/quick-start.md
反馈入口：https://github.com/Starfie1d1272/Mizar/issues
反馈请附版本/构建 SHA、发生时间、复现步骤、实际与期望结果，以及可导出的安全诊断包；不要直接公开原始日志或整个 state。

备用脚本（先停止服务，再安装或恢复 GSI）：
  停止服务：powershell -ExecutionPolicy Bypass -File .\resources\scripts\stop-product.ps1
  安装 GSI：powershell -ExecutionPolicy Bypass -File .\resources\scripts\install-gsi.ps1 -Product
  多个 CS2 安装目录时，在安装命令后加 -Cs2Root "CS2 安装目录"。
  恢复 GSI：powershell -ExecutionPolicy Bypass -File .\resources\scripts\restore-gsi.ps1 -Product

resources 是程序资源，不能保存运行数据。设置保存在 state\data，日志在 state\logs，验收记录在 state\evidence。
可使用 MIZAR_STATE_ROOT 指向其它绝对运行目录；首次启动与后续脚本必须使用同一设置。请保留 state 以保留 HUD 和系列进度。
端口被其它程序占用时先停止占用程序；不会静默换端口。文件缺损时重新解压完整 ZIP。
桌面启动失败会显示原生错误提示，可打开日志目录；即使准备页面未打开，也能保留失败阶段和原始错误。若提示 WebView2 不可用，请安装或修复 Microsoft Edge WebView2 Evergreen Runtime 后重试。不要仅凭此说明认定其它启动失败也由 WebView2 引起。
日志保存在 state\logs（设置 MIZAR_STATE_ROOT 后以该目录为准）：desktop.ndjson、supervisor.ndjson、companion.log 与 companion.stderr.log。每类保留当前文件和最多 3 个历史文件；桌面单文件最多 256 KiB，其余各 2 MiB。它们是本机诊断记录，不是自动脱敏的公开支持包；不要直接分享整个 state 目录。
若桌面页面未打开但本地服务仍正常，可在浏览器访问 http://127.0.0.1:3000/debug 导出同一安全诊断包，并在浏览器下载列表确认文件。服务未启动时先按原生错误提示恢复；保留本机日志，勿直接公开上传。诊断包最多 256 KiB，记录缺失、不可读与截断情况，不会修改历史日志。

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
