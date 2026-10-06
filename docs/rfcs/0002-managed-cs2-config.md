# RFC-0002：受管理的 CS2 转播配置

状态：已形成实现，见 [ADR-0026](../decisions/0026-managed-cs2-launch-and-restoration.md)。RC8 不包含此功能；真实 Windows / CS2 验收仍待执行。下文保留研究来源与方案演变，当前规则以 ADR 和操作手册为准。

## 目标与当前边界

已确认目标：默认现场流程由 Mizar 启动 CS2，采用窗口模式、16:9、1920×1080、游戏最高画质预设；设置提供「保留原画质」。结束制作时退出本次受管理游戏并恢复原配置，异常退出也可恢复。用户已打开的游戏不主动关闭或改写；若要使用默认受管理流程，需要用户先退出。

当前 `windows_host.rs::align_cs2` 只移动、调整游戏客户区，并验证实际窗口几何；没有受管理的游戏启动和玩家图形配置事务。GSI 安装脚本已有 Steam 注册表与 libraryfolders.vdf 的目录发现，可复用其规则，不能另建一套相互冲突的安装位置来源。

窗口比例、游戏内部渲染分辨率、OBS 输出分辨率是三个独立概念。用户已确认不需要承诺现场始终原生 1080p，保持现有 75% 区域排布。当前 Host 缩小客户区对实际渲染的影响仍需验证；仅凭窗口 API 或启动参数不能判定。此前提出改变窗口承载方案没有足够证据，不作为当前建议或实现决定。

## 已核对参考源码

仓库：[DrEAmSs59/CS2-insight-agent](https://github.com/DrEAmSs59/CS2-insight-agent)。

- 默认 main：`f05c698c755dc7806855bb13a5c823dbf6a21de6`，2.7.5。
- 更新的 develop：`55b1f29035aa6f07c753e39276d74ee0947f8df2`，2026-10-05 13:18（北京时间）。研究以此精确提交为准。
- [启动与分辨率修改](https://github.com/DrEAmSs59/CS2-insight-agent/blob/55b1f29035aa6f07c753e39276d74ee0947f8df2/backend/app/obs_director.py)：`_launch_cs2`、`_patch_video_configs_for_resolution`、`_kill_cs2`。
- [备份、账号路径与恢复](https://github.com/DrEAmSs59/CS2-insight-agent/blob/55b1f29035aa6f07c753e39276d74ee0947f8df2/backend/app/cs2_config_backup.py)。
- [恢复验证测试](https://github.com/DrEAmSs59/CS2-insight-agent/blob/55b1f29035aa6f07c753e39276d74ee0947f8df2/backend/tests/test_cs2_config_backup_verification.py)。本次阅读了测试，未安装或执行上游应用。

上游先检查 CS2 是否运行，备份 config、video、VCFG、键位及 Steam local/remote 副本，修改 video.txt / cs2_video.txt 的宽、高与比例，并添加启动参数。其注释记录了单靠 `-w/-h` 可能被视频配置覆盖。结束后等待游戏退出、处理文件锁，再原子恢复并逐字节验证；恢复验证失败时保留未恢复状态与备份。

这些机制有可核对的代码与回归测试，但不能替代 Mizar 在 Windows 上的实测。它服务于 demo 录制，含强制结束进程、`-insecure`、控制台绑定、静音文件处理及所有账号目录扫描，不能整体搬入实时转播流程。

上游使用 PolyForm Noncommercial 1.0.0，Mizar 使用 AGPL-3.0。本研究只引用机制与来源；候选实现独立编写，不纳入上游源码或依赖。

## 公开游戏文件与窗口行为核查（2026-10-06）

核查 SteamDatabase/GameTracking-CS2 的精确提交 `41efe395c393f088a613450678a7e016db00d83a`，提交时间为北京时间 2026-10-06 07:44。该仓库跟踪游戏发布文件和符号、字符串提取结果，不是完整 CS2 引擎 C++ 源码。

- [游戏设置界面](https://github.com/SteamDatabase/GameTracking-CS2/blob/41efe395c393f088a613450678a7e016db00d83a/game/csgo/pak01_dir/panorama/layout/settings/settings_video.xml)明确区分窗口、全屏、全屏窗口；16:9 对应比例值 1；最高预设 Very High 对应预设值 3；FSR 关闭对应值 0。
- [最高画质配置](https://github.com/SteamDatabase/GameTracking-CS2/blob/41efe395c393f088a613450678a7e016db00d83a/game/csgo/pak01_dir/cfg/video_defaults_3.txt)提供真实字段与值：MSAA 8、阴影 3、动态阴影 1、纹理 2、粒子 3、环境光遮蔽 3、HDR -1、FSR 0。应以游戏预设的整组字段为依据，不能对所有数字一律取最大。
- [输入系统字符串](https://github.com/SteamDatabase/GameTracking-CS2/blob/41efe395c393f088a613450678a7e016db00d83a/game/bin/win64/inputsystem_strings.txt)含 `IE_WindowSizeChanged`、`SDL_EVENT_WINDOW_RESIZED`、`SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED` 及尺寸变化日志，证明游戏具有窗口尺寸变化处理入口，不能单凭这些字符串推导具体执行结果。
- [DX11 渲染系统字符串](https://github.com/SteamDatabase/GameTracking-CS2/blob/41efe395c393f088a613450678a7e016db00d83a/game/bin/win64/rendersystemdx11_strings.txt)含 `m_pSwapChain->ResizeBuffers( 0, 0, 0, DXGI_FORMAT_UNKNOWN, m_nActualCreateFlags )`。[微软 API 文档](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiswapchain-resizebuffers)说明宽、高传 0 时采用窗口客户区尺寸。这支持存在跟随窗口调整输出缓冲的路径，但没有调用链证据，不能认定 Mizar 的调整必然触发该路径，也不能把输出缓冲尺寸直接当作所有内部渲染目标尺寸。
- [CS Demo Manager 视频配置实现](https://github.com/akiver/cs-demo-manager/blob/b45a5f29283590c3fd0fc6526564b49567c0b931/src/node/counter-strike/launcher/video-config-file.ts)也在启动前基于完整 `cs2_video.txt` 修改显示模式与宽、高，记录了启动参数与全屏窗口模式相互影响的行为；它不证明缩小窗口后仍保持原生 1080p。
- [Valve 仓库中的 Windows 用户报告 #4152](https://github.com/ValveSoftware/csgo-osx-linux/issues/4152)涉及 2025-08 更新后 SDL/DWM 缩放变化，评论含用 SetWindowPos 按配置尺寸恢复窗口的操作。它是特定版本的用户报告，不是 Valve 确认，也不能替代当前版本实验。旧 CS:GO 和 Linux 窗口问题不作为 Windows CS2 验证证据。

核查结论：修改游戏配置以指定 1080p、显示模式与最高画质有具体文件依据；「进入现有现场布局后始终原生 1080p」尚未验证。当前云主机为 Linux，无 `/dev/dri`、Steam、CS2 或 Wine，不能执行 Windows/CS2 GPU 实测。搜索未取得完整官方引擎窗口处理源码；不以 Source 1 或第三方工具源码代替。

验证应对比同一 CS2 构建的三个阶段：启动后、仅移动窗口后、按当前 Host 缩小客户区后。分别记录客户区、实际呈现缓冲和主要场景渲染目标尺寸、游戏设置、OBS 游戏捕获源原始尺寸（关闭 OBS 源缩放后观察）、鼠标与观战操作；OBS 最终输出或设置文件中的 1920×1080 单独不能证明原生渲染。记录 Alt-Tab、最大化、DPI 与现场退出恢复后的结果。只有实验确认尺寸改变且不能通过游戏支持的配置固定时，才讨论其他承载方案。

## 建议第一阶段

默认现场入口先由 Mizar 启动 CS2：窗口模式、16:9、1080p、游戏最高画质预设；设置中的「保留原画质」保留画质字段，显示模式和分辨率仍使用转播设置。保留原画质包含原有 FSR 设置；默认最高预设关闭 FSR。最高预设按已核对的游戏配置定义，具体版本兼容性与连同 OBS 的帧率仍待实测。

启动流程：解析唯一安装位置和活动 Steam 账号 → 确认 CS2 未运行 → 持久化备份与校验 → 修改白名单字段 → 通过 Steam 正常启动 → 验证实际游戏进程与画面尺寸 → 进入现有现场流程。保留正常在线连接，不沿用 demo 的 `-insecure` 等参数，不持久改写 Steam 启动选项。

CS2 已运行时说明需要先退出并由 Mizar 启动，才能应用默认受管理流程，不自行退出外部游戏。是否另保留「使用当前设置」兼容入口尚未决定。多账号或安装位置不明确时要求选择，不把所有账号都改成转播预设。

已确认默认在结束制作时正常退出**本次由 Mizar 启动并确认身份的 CS2**，确认退出和写盘完成后恢复。用户原本启动的游戏不自动关闭。关闭超时或身份无法确认时保留「等待 CS2 退出后恢复」，不默认强杀或边运行边覆盖配置。

## 配置事务与恢复

物理文件、进程和账号发现由 Desktop Host 负责；Companion 继续拥有制作生命周期，网页只发意图并展示状态，不获得任意路径写入能力。

- 会话备份置于既有可写状态目录，记录会话 ID、安装与账号身份、文件原始存在性、原始字节摘要、允许修改的字段和原子状态日志。
- 备份必须先落盘并校验成功，才允许修改；备份失败不得继续临时修改。未恢复的会话不能被下一次启动覆盖。
- 使用可保留未知键、编码和原始结构的解析/修改方式；缺少关键字段、未知格式或版本不支持时停止应用，不能只打印警告后声称成功。
- 区分本机与 Steam Cloud 副本，按活动账号与实际受影响文件处理。恢复时保留会话期间与本功能无关的用户修改；受管理字段恢复启动前值，包含游戏因窗口变化保存的尺寸。不修改或覆盖 localconfig.vdf。格式、记录损坏时保留备份并提示。
- 原文件不存在时记录此事实；只撤销本会话创建且身份匹配的文件，不删除用户后来创建的文件。
- 等待真实进程退出，处理文件锁和写盘延迟，再恢复并读回验证。成功写入不等于恢复成功。
- 进程身份以可执行文件、进程句柄/创建时间及会话证据关联，防止 PID 重用、Steam launcher 退出或误认外部游戏。优先正常关闭；超时保留待恢复状态，不默认按进程名强杀。
- Mizar 重启检查未完成会话；若游戏仍运行则等待，退出后继续恢复。恢复失败保留记录和备份，提供重试与定位备份入口。
- 并发会话、账号切换、Steam Cloud 重写和文件外部修改需要冲突处理，不能把单次写回验证当成云端永远不会再覆盖的保证。

候选状态：准备备份 → 已应用 → 运行中 → 等待退出 → 恢复中 → 已恢复；另有冲突、失败。只保留 Host 的一个物理事务权威，不在前后端各维护一份恢复决定。

## 验证与未决问题

本地可验证：路径与账号解析、白名单字段修改、未知键/编码保留、备份失败不写入、原文件缺失、部分应用失败回滚、原子日志、摘要校验、修改冲突、恢复重试、重复恢复和重启未完成会话。

Windows 实测：Steam 正常启动与在线观战；活动账号和分库安装；CS2 已运行；窗口客户区与引擎渲染尺寸；1080p/1440p、DPI 和多显示器；OBS 捕获尺寸；正常结束、Mizar/CS2 异常退出；Steam Cloud、文件锁和原设置恢复。使用指定构建记录证据。

待讨论：

1. 已确认不要求全程原生 1080p，沿用现有现场窗口排布；实际渲染和捕获尺寸作为实机诊断证据，不是实施前置条件。
2. 已确认：结束制作默认关闭本次由 Mizar 启动的 CS2，再恢复配置。需要实测正常关闭、退出写盘与关闭失败的恢复行为。
3. 已确认默认最高画质，可选保留原画质；最高预设已核对游戏文件，字段应用、FSR 与保留原画质的边界及 OBS 并行性能仍需验证。

当前实施边界见 ADR-0026；实机验收与发布门槛保持现有规则。
