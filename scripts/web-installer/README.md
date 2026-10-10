# Core 构建与 Windows 在线安装器

默认正式构建仍 Full。显式 `node scripts/qualification/build.mjs --resource-mode core-only` 移除 EPL 回放、视频和样例头像，保留地图、武器、品牌、字体、HUD 与节目代码；Core-only 仍标记 developmentOnly，尚不能晋级。

## 构建接口

在既有 main Release Qualification 内，完成唯一一次 Core 和原 NSIS 构建后运行：

```powershell
./scripts/web-installer/build.ps1 -ProductDirectory <资格产物目录> -OutputDirectory <独立输出目录> -Qualification
```

构建入口复用 `assertQualificationIdentity`、`qualifiedUpdateManifest` 与 `verifyPayload`，要求 main 工作流、请求 SHA、checkout 与产物 SHA 一致，核对原 ZIP/NSIS 的实际字节、Core 全部清单及内置 `installed-entry.mjs`。不接受调用者提供的散列计划，也不重新构建 Core。输出 `Mizar-v<version>-Windows-x64-WebInstaller.exe`、`web-installer-plan.json` 和 `web-installer-build.json`；重复输出拒绝覆盖。build manifest 明确 `published=false`、`publicationRequired=true`、`productionCompletionEvidence=false`。

正式 EXE 仅包含生产入口、透明双星品牌 PNG 和窗口 ICO；标题为「Mizar 安装」。没有许可下载预览或演示命令。发布负责人须把此候选纳入原 Qualification 证明及 Promotion 原资产核验，不能据构建 manifest 推断已发布。当前 PR 不修改发布 workflow、Box 或公开附件。

执行安装前只读请求官方 GitHub 固定版本 API，拒绝草稿、预发布、未公开、错版本、缺失／重复资产、大小／摘要／规范 URL 不符。此检查只确认已由 Qualification 固定的 ZIP/NSIS 资产公开可用，不生成新信任授权；资源 publisher 认证仍由唯一 SDK 的 signer@main、源码 OID 和 Sigstore 完成。请求无凭据／cookie／重定向，响应限 2 MiB、45 秒，可取消。尚未发布的候选不能开始安装。

## 安装与资源接口

原 Downloader 在固定 HTTPS 来源内校验大小与 SHA-256，持久缓存复验后复用；网络临时故障仅在原锁和五分钟预算内重试一次。原 NSIS 继续负责系统安装、卸载、取消等待、回滚与用户数据保留，不能删除作为后端的 Setup 资产。

Native 先核对已有目录的精确身份或在全新目录安装，锁定 Core 中 Node、入口与静态依赖，再运行该 Core 内 `installed-entry.mjs`。入口复用 `verifyPayload` 并动态导入实际 App，同一 App 的唯一持久 Store、默认用户资源目录与 updates/trust 负责资源，不建第二 Store 或信任验证器。`authenticatePublishedBootstrap` 复用既有 StableSource 与 SDK 双证明，输出不可伪造授权句柄；`completeBootstrap` 只在 Core 与默认官方资源同时就绪后返回完成。离线复用原 receipt 的 SDK 双证明；原字节、固定八文件地址和内容身份持续绑定。旧 v1.1 没有入口，执行 Node 前即拒绝，不注入外部替代脚本。

同一 WinForms 窗口自动完成下载、安装和资源准备；下载显示真实字节，未知阶段使用不定进度。真正完成后默认勾选「启动 Mizar」，点击「完成」才启动；取消勾选或关闭 X 不启动，启动失败仅重试启动。错误提供重试、权限检查或原安装器修复操作，技术信息放详情。取消等待实际写入进程安全停止。

## 常规验证与证据边界

```powershell
./scripts/web-installer/verify.ps1 -OutputDirectory .agent-tmp/web-installer
```

常规单 CI 的 `installer_windows` 由同一风险路由选中，并由 `ci-gate` 要求成功。它构建实际 Companion 生产依赖，运行 SDK 目录、Windows Store FS、App 集成与真实 Node stdin 取消边界；编译生产 Native 源码，测试真实 WinForms 控件／有界下载和公开资产状态拒绝；只读下载已认证历史 NSIS，在 runner 临时目录真实安装、拒绝覆盖、取消并卸载。`legacy-stable-plan.json` 仅供该原安装器回归，不是新发行身份。

`test-native.ps1` 的注入 UI 操作与独立 `ui-state-demo.exe` 仅负责 UI 行为。`capture-ui.ps1` 截取实际原生演示控件，标题与正文明确「界面演示：未执行安装」，证据标记 `productionCompletionEvidence=false`；演示 EXE 不进入正式安装器或 CI 上传产物。`verification.json` 记录 source SHA 和真实 wall-time。独立 POC workflow、旧许可下载预览及开发安装器构建已移除。

尚缺新受信任 Core/NSIS 与官方八文件资源双证明的实际公开发行，不能声称冷缓存首次安装、持久 receipt 断网 EPL 或已安装桌面启动成功。当前新构建入口会拒绝 developmentOnly Core-only。发布负责人接入候选原资产证明后，仍须用实际新版本完成上述端到端验证，再协调切换默认 Core-only；不会重发 v1.1。Windows runner 的 UI/回归证据不代替 Windows 10/11、DPI 和真实产品启动验收，Quick ≤60 秒、Full ≤180 秒、Release 含 Box ≤600 秒均以实际 workflow wall-time判定，超标不能削弱门禁。
