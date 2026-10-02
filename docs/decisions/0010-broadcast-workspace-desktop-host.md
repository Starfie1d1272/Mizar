# ADR-0010：Mizar Workspace Desktop Host

状态：Accepted（Issue #84）

## 决策

- Tauri 2 是 Windows 正式桌面 Host，根目录 `Mizar.exe` 由它提供。Tauri 只拥有三个本机窗口、CS2 PID/HWND/client area、显示器 work area、DPI、焦点、置顶、鼠标穿透与 tray；不解析 GSI/CSTV，不建立 Match、Runtime、Program 或 OBS 事实。
- Companion 继续独占 `RuntimeState`、Program/Operator/Assist projection、Local Protocol、BP presentation session 和 OBS adapter。Web Workspace、OBS Browser Source 与本机 Program Overlay 使用同一个 `packages/protocol` Program Scene registry；场景 id、URL 与 composition 不在三处重复定义。
- `workspace-left` 上部承载已有 Radar Renderer，下部承载从现有 Operator/BP/Series 投影派生的 Context Panel；`workspace-dock` 承载 Scene、Match、Local、OBS、Status。`/workspace` 仅是浏览器审查预览；正式 Host 打开 `/workspace/left` 和 `/workspace/dock`。真实 CS2 是独立顶级窗口，不被嵌入或重绘。
- 每次 Workspace 会话按 CS2 client area 与显示器 work area 的最大交集选显示器；没有 CS2 时选主显示器。布局锁定该显示器，直到制作人员执行“恢复布局”。目标游戏区域为 work area 的 75%×75% 盒内最大 16:9 区域，右上角锚定；左栏占其左侧，底栏占其下方全宽。Windows Host 只用 `GetClientRect`、`ClientToScreen`、style/ex-style 与 DPI 计算外框，`SetWindowPos` 后有界校正，不改游戏 style、进程或父子关系。
- Local Program Overlay 加载现有 `/program`，透明、不可获焦、鼠标穿透、置顶并严格对齐 CS2 client area。CS2 无效、最小化、无法管理或前台不属于 CS2/本产品时隐藏。它与 OBS Browser Source 分开开关；窗口几何不进入 `RuntimeState`。
- 本地 Scene 切换先由 Companion 检查数据充分性与身份一致性；OBS 已连接时，由 Companion 先切换同一 registry 对应的 OBS 场景，成功后提交当前 Scene。OBS 离线时保留本地制作能力并明确显示 OBS 断开。BP 使用既有 `BpSession`，Gameplay 使用既有 Program Renderer。
- OBS 仅管理 `Mizar` Scene Collection 与其中 `Mizar ·` 来源；Browser Source 使用 registry 的 URL，Game Capture 仅属于 gameplay overlay composition。检查读取实际状态；修复幂等。推流或录制时不切换 Collection，也不自动修改全局视频、推流、音频、Profile 或录制设置。
- Desktop 继续启动同包 Node 24 与 `product-runtime.mjs`，按 ADR-0008 验证 payload、同 artifact 复用、端口身份、可写 state 与 graceful stop。关闭窗口隐藏至 tray；显式退出才停止 Companion。异常退出不强杀 Companion。Clarification：[ADR-0015](0015-desktop-startup-diagnostics-and-recovery.md) 将此处异常退出限定为成功进入稳定运行后的 Host 意外退出；冷启动失败清理本次新建进程，并规定托盘不可用时 Main 的退出语义。
- Tauri remote IPC 只授权 `http://127.0.0.1:3000` 的三个产品窗口访问限定原生命令；不授予任意 shell 或文件系统命令。OBS 程序选择器只接受 `obs64.exe`。

## 对 ADR-0008 的关系

ADR-0008 的资源/状态隔离、bundled Node、Companion supervisor、artifact identity 和 Web-first fallback 继续有效。其使用 `.NET` 薄 launcher 作为正式 EXE 的决定由本 ADR 的 Tauri Host 替代；原生命周期 smoke 迁移到同名 Tauri EXE 后移除旧 launcher。

## 验证边界

Web、Companion、mock OBS、Rust 几何/生命周期、Windows 编译与 exact artifact smoke 属于自动化验收。真实 CS2/多屏/DPI/Alt-Tab、真实 OBS Game Capture/Browser Source 和完整比赛 soak 归 #35 的实机验收，不以自动测试替代。
