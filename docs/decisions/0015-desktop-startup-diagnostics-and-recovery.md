# ADR-0015：桌面启动诊断与恢复

状态：Accepted

## 背景

Companion 已监听且 HTTP health 正常，不代表 Tauri Main 已创建或可见。若 Desktop setup 丢弃原始错误，GUI subsystem 又没有可见 console，用户只会看到程序退出，并可能留下本次启动的 Node/Companion。同步创建尚未使用的现场窗口与托盘还会扩大冷启动失败范围。

因此冷启动需要独立的阶段证据、无需 WebView 的失败界面，以及只作用于本次新建进程的回滚边界。诊断用于定位真实失败阶段，不预设 WebView2 是历史故障的根因。

## 决策

### 1. 有界启动诊断

Desktop 在进入 Tauri 初始化前建立启动会话并安装 panic hook。日志记录 UTC 时间、`startupSessionId`、git SHA、artifact SHA、OS/arch、进程、阶段和结果；错误保留可用的原始 Display/Debug 信息，panic 保留位置、payload 与可用 backtrace。阶段覆盖 Runtime 启动、WebView2 preflight、Main、现场窗口、内容保护、托盘、setup、页面导航、退出及回滚。

日志位于既有可写 state 的 `logs/`，遵守 `MIZAR_STATE_ROOT` 和 resources/state 分离。日志有硬上限，不建立无界输出队列：

| 日志 | 单文件上限 | 保留文件 |
| --- | --- | --- |
| `desktop.ndjson` | 256 KiB | 当前文件 + 3 个历史文件 |
| `supervisor.ndjson` | 2 MiB | 当前文件 + 3 个历史文件 |
| `companion.log` | 2 MiB | 当前文件 + 3 个历史文件 |
| `companion.stderr.log` | 2 MiB | 当前文件 + 3 个历史文件 |

Desktop 与 supervisor 按限额轮转；Desktop 新启动也轮转。Companion stdout/stderr 按启动轮转，当次达到限额后写截断标记并停止追加；超长行丢弃并标记。新建链路沿用同一 `startupSessionId`，通过 supervisor 的 artifact 记录关联 Companion 输出。复用已有 Runtime 时保留原服务的会话身份，不重写其日志为新会话。

日志避免主动写入凭据，Node 输出进行已知 secret 和 credential 字段脱敏。这些本地诊断不等于可公开分享的支持包：不得直接压缩整个 `state/`；一键导出仍需单独的 allowlist、脱敏与验证契约。

### 2. Main 与现场窗口的失败边界

冷启动先确保同 artifact Runtime，再检查当前 WebView2 可用性并创建 Main 准备中心。WebView2 preflight 记录当前版本或原始失败信息；缺失或损坏时提示安装/修复 Evergreen Runtime，不通过改换浏览器掩盖错误，也不把 preflight 当作历史根因证据。

`workspace-left`、`workspace-dock`、`program-overlay` 在首次进入现场时事务式创建。任一步失败，撤销本次创建的现场窗口，向调用方返回可重试错误；Main、既有 Runtime 及比赛事实保持各自 owner。窗口创建不回写或复制 Companion 的 `preparation | live | hidden` 生命周期。

托盘独立诊断且失败不撤销 Main。托盘不可用时 Main 标题明确说明关闭主窗口会退出；关闭现场窗口则恢复 Main，避免产品隐藏后无恢复入口。托盘正常时沿用关闭隐藏、显式退出停止 Runtime 的行为。

### 3. 进程归属与退出

Packaged Node 使用 `CREATE_NO_WINDOW`，正常制作不暴露 console。Desktop 为本次新建 supervisor 建立 Windows Job，启动期间启用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。Supervisor 必须先等待有界 stdin 握手；Desktop 将其加入 Job 后才允许继续创建 Companion，从而使新建后代继承同一进程归属。

Tauri 成功进入 Ready 后解除 Job 的自动终止标志，稳定运行后的 Host 意外退出继续保留 Companion，符合 ADR-0010 的运行连续性原则。显式退出或启动失败时先请求经既有 artifact/token 校验的 graceful stop 并有界等待，再以本次 owned Job 的 `TerminateJobObject` 清理残留；不按进程名终止任意 Node。

启动失败回滚只停止本次实际创建且归属匹配的 Runtime。同 artifact 已有服务属于借用实例，新的 Host 启动失败不得停止它。失败清理完成后显示原生错误框，提供日志目录及打开目录/退出选项；日志无法建立时仍报告目录可写性等可执行恢复提示。

### 4. IPC 与验证边界

生产 Desktop commands 的 build manifest、Rust handler、Web 调用与 capability allowlist 必须一致；没有当前 Web consumer 的既有原生命令使用明确例外。权限保持精确产品窗口和 `http://127.0.0.1:3000/*`，不增加通用 shell、文件系统或远程 origin 授权。

Headless product smoke 继续验证 bundled Runtime/HTTP 路径。独立 GUI smoke 从 exact artifact 启动普通 EXE，检查同 artifact health、可见且非零 client area 的 Main、可信页面导航、Host 持续存活、无可见 Node console，以及显式退出后的后代清理和 shutdown 记录。另用无效的 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 验证原始失败证据、回滚与原生错误框。

页面导航完成不证明 React 或整场制作流程可用。上述自动化、日志限额测试与进程生命周期测试均不能代替真实 Windows 首次启动、CS2/OBS、多显示器/DPI 和完整比赛验收。具体命令与证据边界见 [开发与验证](../development-validation.md)。

## 与既有 ADR 的关系

本 ADR 细化 ADR-0008/0010 的 supervisor 与恢复边界，区分未完成的冷启动和已成功运行的 Host；补充托盘不可用时的关闭行为。ADR-0014 的默认准备中心、现场生命周期和 Companion authority 保持有效，窗口延迟创建只属于 Desktop Host。
