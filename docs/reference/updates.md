# 应用内更新

更新属于分发能力，由 Companion 验证版本与下载，桌面宿主负责在安全退出后启动新包自带的原生安装执行器（`mizar-applier.exe`）。既有比赛、节目、OBS 和用户资料（`%LOCALAPPDATA%\Mizar`）继续由原模块持有并独立保留。

## 可信元数据

Stable 使用 `update-manifest.json`（结构标识 `mizar.update.v1`），包含仓库、正式版本、源码 SHA、中文更新说明、兼容的旧版范围（`minimumVersion` / `maximumVersionExclusive`）及 Windows x64 NSIS 安装包的名称、字节数、SHA-256 和内容摘要。中文更新说明从 CHANGELOG 提取为纯文本；客户端只显示文本，不执行 HTML、脚本或清单链接。

检查匿名读取 GitHub 的 `releases/latest/download/machine-metadata.json`，提取 `mizar.update-index.v2` 信封，并验证其原更新清单与正式发布确认的 Sigstore / TUF 证明：

- 信任根由 Sigstore 内置 TUF 根负责更新、轮换与吊销，优先使用 `tufForceCache`，缺失、损坏或过期时刷新，不接受下载源指定的公钥或信任根；
- GitHub 运输失败时才回退固定 GH-Proxy 加速源（只传输公开字节，不参与来源认证）；
- 客户端保留已验证版本和摘要，拒绝回退及同版本换包；
- 现代客户端从原机器元数据验证同次 Qualification 对 Full 与 Core 的证明后优先选择轻量 Core；
- 旧架构（`<= 1.11.27`）不在新架构 `minimumVersion` 兼容范围内，旧版客户端自动进入 `manual` 提示用户前往正式发布页下载新版安装包完成一次性覆盖迁移；
- MulNX 独立跟随上游公开发行，读取国内 Box 签名索引与只读 Token，不参与 Mizar 主应用更新认证。

## 检查与下载

更新偏好（`updates/settings.json`）解析或校验失败时，改名归档为 `settings.json.corrupt-<时间戳>` 并回退默认值，不锁死更新系统。下载缓存（`updates/download-*`）损坏即删除并重新下载；清理失败仅记诊断，不禁用更新功能。

安装版升级时，旧设置里未标记为明确关闭的「自动准备更新」会恢复为开启。旧格式仅保存开启或关闭，无法区分早期默认关闭和当时手动关闭。升级后可以再次关闭，之后启动和更新均保留该选择。

应用更新拆分为**后台静默准备**与**用户主动切换**两个独立阶段：

- **后台检查与自动下载**：开启「自动准备更新」（默认开启）时，桌面启动后延迟 30 秒执行首次自动检查（含 Mizar 与 MulNX），持续运行期间每 2 小时复查一次；检查发现兼容新版本且当前处于准备中心（非制播工作台、OBS 未推流/录制或切换输出）时，自动在后台下载并校验安装包，同时将原始 `machine-metadata.json` 一并写入该版本的 `download-*` 目录；已有 `staged` 缓存时先完成新版下载与校验再原子替换 `ready.json`，避免中途失败破坏已有可安装版本。
- **制播让路与取消语义**：进入制播工作台或 OBS 开始推流/录制时，非阻塞取消正在进行的自动下载并清理临时文件（用户主动发起的手动下载不受影响），退出工作台回到准备中心时自动补发下载；用户主动取消下载仅在当前会话抑制该版本的自动下载；后台静默检查或自动下载失败仅记录诊断，不覆盖已有 `staged`。
- **非侵入式入口**：桌面端在左侧边栏底部常驻展示就绪/可用更新入口（MulNX 更新在「资源管理」导航项以轻量徽标提示），不再弹出侵入式更新对话框；重启安装始终由用户主动触发，且用户触发安装时优先取消并等待后台检查/下载收尾。

EPL 官方资源通过 `distribution/resources.ts` 与 Companion 内置的 `ResourceStore` 在软件启动后独立完成目录获取、SDK 认证、下载校验与重试修复；素材下载或校验失败绝不阻断 Mizar 软件的安装或更新。

## 安装与恢复

安装版采用 Side-by-side 版本目录布局，便携版（不含 `installed.flag`）仅显示更新说明与正式下载入口，不启动安装器：

- 安装根目录（默认 `%LOCALAPPDATA%\Programs\Mizar`）包含稳定启动器 `Mizar.exe`（`mizar-launcher`）、原子版本指针 `current.json`（`schemaVersion: 2`）、`Uninstall.exe`，以及 `versions\<version>-<gitSha8>\` 与 `staging\`；
- 根目录 `Mizar.exe` 严格只读：更新期间检测到 `Global\MizarUpdateActive` 时尝试聚焦 `Mizar 应用更新` 窗口并退出；正常启动时按 `current.json` 透传启动 `versions\<current>\Mizar.exe`（`current.json` 损坏时按语义化版本号从高到低只读兜底）；
- Tauri 主程序在窗口创建后设置 `System.AppUserModel.ID` 与 `System.AppUserModel.RelaunchCommand` 指向根目录稳定 `Mizar.exe`，保护任务栏固定图标。

唯一安装执行器 `mizar-applier.exe` 随每个版本的载荷打包分发，严格遵循“新包安装新版”原则，消除跨语言反调与多阶段握手协议：

- **内核同步**：全局写入锁 `Global\MizarUpdateWriter`、桌面互斥 `Global\MizarDesktop`（内置更新时由 Host 通过 `STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 白名单继承给 Applier）、更新活动事件 `Global\MizarUpdateActive`；
- **内置重启更新**：Host 仅请求 Companion 单一 `install-plan` 接口检查 OBS 推流/录制、读取待安装目录下的 `machine-metadata.json` 复用统一离线认证与安装包完整性校验，随后调用新包 `Setup.exe /S /MIZAREXTRACT=<temp_dir>` 静默解包，完成正常退出收尾后白名单继承 `Global\MizarDesktop` 拉起新包 `mizar-applier.exe apply-update` 并重定向 `stdout/stderr` 到 `logs\applier-launch.log`；若拉起失败，Host 释放互斥并直接重启旧版（绝不进入 CS2 配置恢复）；
- **安全与护栏**：由 `mizar-applier.exe` 在安装/更新期唯一执行全量载荷 `artifact.json` + `SHA256SUMS` + `contentDigest` 校验（运行时监督器启停仅校验 `artifact.json` 元数据身份，不再重复全量哈希）；保留递归删除前的重解析点 / junction 检查、进程 `PID + StartTime` 校验，以及 OBS 推流/录制门禁；不要求旧安装目录完整即可覆盖修复，历史 `v1.11.x` 目录在首次新安装时整体改名归档为 `*-legacy-<时间戳>` 并顺手清理旧 `RunOnce\!MizarUpdateRecovery`；
- **提交与回退**：`current.json` 原子写入为唯一提交点；提交前失败或用户取消时清理暂存并保持/拉起旧版；提交后启动新版等待 `Local\MizarUpdateStarted-<32hex>` 就绪事件（最多 60 秒），若新版在就绪前提前退出则自动将 `current.json` 翻回 `previous` 并拉起旧版；新版就绪确认后立即关闭更新窗口，随后静默清理更早旧版本与 `staging/` 目录，清理失败仅记 `cleanupWarning`，不否定已提交的安装。
