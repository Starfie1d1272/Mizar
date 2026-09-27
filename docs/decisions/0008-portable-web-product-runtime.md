# ADR-0008：Web-first 便携产品与运行目录

状态：Accepted（Issue #35 冻结 contract 的实现）

## 决策

- 沿用 `scripts/qualification/build.mjs` 构建同一产品包，正常制作与现场验收共享 bundled Node 24、Companion 和 Web。
- 根目录 `Mizar.exe` 是薄 Windows x64 launcher，使用 Windows 自带 .NET Framework 编译的 WindowsApplication。它只校验启动文件、协调 single-instance、运行 bundled Node supervisor 和显示中文启动错误，不拥有业务数据。
- `resources/` 是不可变 payload；`state/data`、`state/logs`、`state/evidence` 是可写状态。`MIZAR_STATE_ROOT` 可显式指向其它绝对目录，但不能落入 resources。
- 正常服务固定为 `127.0.0.1:3000`，浏览器打开 `/operator`。同 artifact 的实例可以复用；未知端口占用和不同 artifact 均失败，不换端口。
- Companion 管理运行状态和 graceful shutdown。Launcher/supervisor 不解释 Program、Radar 或赛事事实。浏览器关闭不停止 Runtime。
- Windows launcher 使用同一 named mutex 协调首次启动；脚本 fallback 也调用 EXE。已启动实例由 artifact digest 与 Companion instance identity 校验，停止命令另需 bundle-local 随机 control token。
- 现场验收保留已有 controller、supervisor、GSI install/restore、证据 verifier；只改变可写路径，正常模式不会自动启动现场验收。
- 后续 host diagnostics 仍限定在 local-web 边界，不进入 RuntimeState 或 ProgramProjection；本阶段不引入该能力。

## 验证

payload 完整性、缺损失败、冷启动、重复启动、端口冲突、停止/重启、状态目录分离由自动化覆盖。Windows 便携 smoke 使用 exact artifact。真实 Windows + CS2 + OBS 的生产结论由独立 evidence 决定，自动 smoke 不构成真实生产 PASS。

Installer、updater、签名、OBS 自动配置与 Workspace 继续留在后续工作。

2026-09-27 后续决定：ADR-0010 将正式 EXE 的 `.NET` launcher 替换为 Tauri 2 Desktop Host；本 ADR 的 bundled Node、Companion supervisor、artifact identity、可写 state 和 Web-first fallback 约束继续有效。
