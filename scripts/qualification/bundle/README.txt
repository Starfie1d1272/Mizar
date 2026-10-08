Mizar Windows x64 便携版

本产品包绑定 git SHA <SHORT_SHA>，并内置 Node <NODE_VERSION>。解压到可写目录后，双击 Mizar.exe 打开准备中心。
同版本 -Setup.exe 为中文安装向导，默认安装到当前用户目录，可创建快捷方式并在完成后启动。升级前正常退出 Mizar；卸载保留 LOCALAPPDATA\Mizar 用户数据。便携 ZIP 仍完整解压到可写目录运行，数据保留在同目录 state。
不需要安装 Node 或 pnpm。程序只使用 http://127.0.0.1:3000；重复打开会复用同版本服务。关闭工作区窗口后可从托盘重新打开；选择托盘“退出 Mizar”先安全收尾、关闭本次游戏并恢复配置，再停止服务。若托盘不可用，主窗口标题会提示关闭主窗口将退出，关闭现场工作区则返回主窗口。

正常制作：

1. 双击 Mizar.exe，进入“总览 / 比赛资料 / 播出画面 / 设置”准备中心。在“比赛”创建或选择本地比赛；连接 RivalHub 时先在“设置”授权，再到“比赛”选择赛程。
2. 首次准备：在“设置 → 游戏数据”检测并安装 GSI；已打开 CS2 时先退出游戏，自动发现不唯一时明确选择安装目录。启动前必须已安装且无冲突，不要求此时已有新鲜游戏数据。
3. 配置 OBS 控制连接（WebSocket）：在 OBS“工具 → WebSocket 服务器设置”启用服务器，保留身份验证；在 Mizar“设置 → OBS 连接”填写相同端口与密码，保存并测试，然后检查 / 修复 Mizar 场景。这是控制连接，不是直播平台推流服务器。Gameplay 地址为 http://127.0.0.1:3000/program。
4. 点击“启动游戏并打开工作台”。Mizar 备份本账号视频与帧率配置，以无边框窗口、适配工作台的分辨率、默认最高画质和 60 帧／秒启动。游戏数据设置可选最高／高／中／保留原画质，以及 60／30／不限帧；中画质包含 FSR 缩放，不限帧可能导致雷达或播出卡顿。启动脚本的直接 fps_max 赋值临时采用本次上限，退出后恢复；动态脚本或 Steam 帧率冲突会提示处理。本次 Steam 启动追加 -console -allow_third_party_software -worldwide 与帧率上限，不改写已保存的 Steam 启动项或键位；第三方兼容选项可能影响信任系数。受管理期间请勿编辑启动配置。游戏已启动时入口为“打开直播工作台”；窗口失败保留游戏和准备中心，可重试。
5. 在 CS2 控制台输入赛事方提供的 connect <GOTV 地址>，进入观战；核对游戏数据、名单与地图。工作台“复制隐藏命令”后，在 CS2 控制台粘贴并回车，再核对 OBS 实际游戏画面、HUD 与声音，最后在 OBS 开始推流。退出工作台按钮会先安全切场、释放数据源，再关闭本次游戏并恢复配置；托盘“退出 Mizar”按同样顺序收尾并停止服务。收尾失败保留程序与游戏，可修复后重试。隐藏工作区保留制作与游戏。
6. 反馈问题时，进入“设置 → 高级 → 运行诊断 / 导出诊断包”，点击“导出诊断包”，在原生另存为窗口保存 .json 文件。取消或保存失败可重试。包只含有界安全摘要，原始错误留在本机，不包含原始 GSI、选手资料或凭据。GSI/CS2 探测无响应时仍可导出，对应状态保持不可用。

HUD 与节目：

在“播出画面”打开 HUD 编辑器，选择 Mizar 默认、类 EWC、类 IEM 或类 Perfect World 预设并预览。内置只读，修改后“另存为”；自定义内容“保存”，再“启用当前预设”才改变正式节目。已启用配置重启后恢复，仅保存编辑不会刷新节目。若另存布局，须在预设中选择该布局、保存并启用。
预设页可“导出预设文件”或“导入预设文件”（.mizar-hud.json，最多 256 KiB）。先保存或放弃所有未保存修改；导出要求预览与预设引用一致。文件包含组件设置、布局和受控外观，不含图片、比赛、实时数据或启用状态。导入创建新副本，不覆盖旧配置、不自动上屏；选择副本预览后再启用。无效文件可修正后重试。
左右选手栏分别提供“C4 伤害预测”，内置预设默认开启，修改后保存/另存并启用。预测按当前位置与站立姿态估算，不改变真实 HP，不保证必死/必活。只在已下包/拆弹、未暂停/结束且有效爆炸倒计时大于零、不超过十秒时显示有效伤害覆盖层；伤害为零不绘制覆盖层。
cs2-c4-damage@0.1.1 随包提供 Ancient、Anubis、Cache、Dust II、Inferno、Mirage、Nuke、Overpass、Train、Vertigo 数值资源，无需提取游戏文件或额外下载。数据过期/输入不足、未支持地图、资源缺失/损坏或检测到不一致时隐藏；核对数据、开关和地图，资源问题重新解压完整包，持续异常导出诊断。十图资源校验不是全图实机精度或未来游戏版本兼容保证。
打开直播工作台默认自动编排；“手动切换”选择场景后持续手动保持，明确“恢复自动”才交回控制。自动暂停时先处理提示原因。节目预览不会切 OBS；BP 工作台为 http://127.0.0.1:3000/preview?scene=bp，旧 /operator/bp 转到该入口。
“隐藏工作区”保留制作与游戏；“恢复布局”重排本机窗口；“退出工作台”完成安全切场与数据源释放后回准备中心，再关闭本次游戏并恢复配置。推流/录制启停仍由操作者在 OBS 确认。画面页的本机覆盖显隐只影响自己 CS2 上的覆盖，不改变正式节目。

详细操作与故障排查：https://github.com/Starfie1d1272/Mizar/blob/<SHORT_SHA>/docs/quick-start.md
反馈入口：https://github.com/Starfie1d1272/Mizar/issues
反馈请附版本/构建 SHA、发生时间、复现步骤、实际与期望结果，以及可导出的安全诊断包；不要直接公开原始日志或整个 state。

备用脚本（先停止服务，再安装或恢复 GSI）：
  停止服务：powershell -ExecutionPolicy Bypass -File .\resources\scripts\stop-product.ps1
  安装 GSI：powershell -ExecutionPolicy Bypass -File .\resources\scripts\install-gsi.ps1 -Product
  多个 CS2 安装目录时，在安装命令后加 -Cs2Root "CS2 安装目录"。
  恢复 GSI：powershell -ExecutionPolicy Bypass -File .\resources\scripts\restore-gsi.ps1 -Product

resources 是程序资源，不能保存运行数据。设置保存在 state\data，日志在 state\logs，验收记录在 state\evidence。
游戏配置备份保存在 state\data\cs2-session。正常运行时“已备份”是普通状态；启动不确定或恢复失败时显示警告。异常退出后在“设置 → 游戏数据”使用“恢复配置备份”或“打开备份目录”；GSI 自身备份另由 GSI 设置管理。Steam 启动超时不代表请求已取消，不会自动删除备份：先取消 Steam 启动请求并确认 CS2 已关闭，再勾选确认恢复。保留未完成备份，勿手工覆盖正在运行的游戏配置。
可使用 MIZAR_STATE_ROOT 指向其它绝对运行目录；首次启动与后续脚本必须使用同一设置。请保留 state 以保留 HUD 和系列进度。
端口被其它程序占用时先停止占用程序；不会静默换端口。文件缺损时重新解压完整 ZIP。
桌面启动失败会显示原生错误提示，可打开日志目录；即使准备页面未打开，也能保留失败阶段和原始错误。若提示 WebView2 不可用，请安装或修复 Microsoft Edge WebView2 Evergreen Runtime 后重试。不要仅凭此说明认定其它启动失败也由 WebView2 引起。
安装版日志保存在 %LOCALAPPDATA%\Mizar\logs，便携版在 state\logs（设置 MIZAR_STATE_ROOT 后以该目录为准）：desktop.ndjson、supervisor.ndjson、companion.log 与 companion.stderr.log。每类保留当前文件和最多 3 个历史文件；每段最多 25 MiB，运行中滚动，每类约 100 MiB、合计约 400 MiB。它们是本机诊断记录，不是自动脱敏的公开支持包；不要直接分享整个 state 目录。
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
