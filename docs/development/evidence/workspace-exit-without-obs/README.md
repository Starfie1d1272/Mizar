# 工作台无 OBS 退出修复证据

修复源提交：`5ddb7936602de424af5a2277d6c477e9c999bc74`，Ready PR #348。附件分支不改变修复 PR 代码头。

原版 `0d5874c` 的真实 `obsConfigPath` / `buildApp` / OBS adapter / 路由反证见 `original-failure.log`：enter 成功，finish 返回 OBS 恢复错误；同一新增磁盘配置生命周期回归修后通过。网络拒绝为测试环境边界，OBS 未运行由进程检测替身提供，不代替 Windows 实机。

`owner-chain.log` 由实际 Rust `finish_workspace_production` 的 TCP HTTP 请求进入本地 Companion 生产路由，使用真实 OBS 适配器、场景控制和制作事务；OBS WebSocket 没有运行，实际连接遭拒。Linux 上仅模拟 Windows 进程检测边界：临时固定 powershell.exe 替身按受控文件返回 1 / 0，读取仍经过生产 isObsProcessRunning。1 时 Rust 拒绝并保持实际 CS2 接管文件字节；0 后同次退出重试完成真实 SessionStore 恢复，逐字节等于原始文件，并清除恢复记录。未运行受管 CS2 进程或 Windows Tauri WebView，因此不是 Windows 进程关闭实测。

`native/` 是临时 Cargo 验证入口，通过 path 直接编译本仓生产 Rust 模块，没有拷贝／重写恢复实现。56 项测试通过，包括生产安全门禁先于恢复、物理恢复失败保留 journal、新实例重试恢复原视频与帧率字节；原异常退出恢复矩阵也通过。可在固定 `/workspace/Mizar` 源码路径设置 CARGO_HOME/RUSTUP_HOME 后运行 `cargo test --manifest-path native/Cargo.toml --offline --lib`。实际 HTTP 串联用 `owner-chain.ts` 和 `native/src/bin/owner_exit.rs`，固定 `/tmp/mizar-exit-native` 编译产物；只用临时夹具目录。命令与临时路径直接保留以便父任务复核，不是新的生产工具。

`companion-regression.log`：真实生产组合与现有负责层回归；活跃推流／录像输出先由真实 OutputController 读取再验证安全切等待，失败保留现场，明确关闭后可重试。没有 StopStream/StopRecord/进程终止命令。相同场景的人工 Take 继续要求 OBS，不采用退出的无进程证明。

`obs-exit-retry.png` 为修复源提交上的 Chromium 实际渲染，IPC/OBS 为模拟边界。既有 workspace-controls 退出用例在临时边界夹具中仅将 CS2 错误文本替换为本 PR 的固定 OBS 安全提示，保留关闭原 dock、准备中心可见错误、诊断、禁用／重试、成功消失断言。测试源执行后恢复，未修改产品页面或 #344 文件。截图可见完整提示、重试与运行诊断，无横向溢出；仍显示既有「关闭游戏与恢复设置」阶段标题，本 PR 未扩展阶段呈现。原 CS2 边界夹具同样通过。截图不是独立验收或 Windows 证明。

Companion/Web typecheck、目标 ESLint/Prettier、构建、architecture:check、design:check、diff check 通过。初始依赖产物过期时的失败已通过冻结安装及按图构建前置包解决；新测试初始夹具／类型错误修正后重跑，不增加 skip/retry 或弱化门禁。

父任务待独立审查；Windows 完整 native CI 正在运行，Windows/CS2/OBS 实机待验收。无发布、生产写入、用户 Windows 操作或凭据收集。
