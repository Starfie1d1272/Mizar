# Windows 轻量安装器

推荐 EXE 安装真正不含可选 EPL 媒体的 Core，然后通过同一 Resource Store 完成首次资源缓存。Qualification 从同次已完整核验的 Full 候选分离 Core，生成独立 Core ZIP/NSIS、清单和摘要，并在签名前验证实际安装与桌面启动。原 Full ZIP 保留既有离线行为；旧客户端仍使用原 Full NSIS 更新。开发 core-only 保持不可发布，readiness 仍须真实首次安装证据。

## 构建与晋级

在 main Release Qualification 内消费原 ZIP、NSIS 和已核验的解压 Core：

```powershell
./scripts/web-installer/build.ps1 -ProductDirectory <产品目录> -CoreDirectory <解压Core目录> -OutputDirectory <产物目录> -Qualification
```

入口复用既有 Qualification 身份检查、更新清单和完整载荷验证，拒绝其它工作流、源码不一致、缺少安装桥和改变的原资产。它只编译原生引导器，不重建 Core。Qualification 同时证明原 EXE 和构建身份；Promotion 验证这些原字节后发布，拒绝同名不同内容。构建报告保持未发布、未取得生产安装证据的状态，不能把已有自动化当成新版本实机验收。

## 下载与验证

Native 先读取 Box 的只读 Mizar 资料库、原 v2 更新信封及精确 Setup 文件，核对 Qualification 内嵌的版本、源码、大小和摘要；Box 不可用或不匹配时回退 GitHub 固定版本。此步骤核对公开状态，不能替代来源签名。下载的原 NSIS 全部字节必须符合固定资格身份，执行前再验证。只读 Token 只发往指定 Box API，不随临时文件链接或 GitHub 请求发送。

安装后使用已核验 Core 自带的 Node 和原 SDK。StableSource 验证原更新清单与正式发布确认的双签名；机器元数据从 Box Runtime/v<应用版本>/machine-metadata.json 或 GitHub 同名附件解出原字节；资源 ZIP 从 Resources/v<应用版本>/ 读取，失败回退 GitHub。运输载体有名称白名单、大小、重复条目和规范编码边界；原目录/出版/归档签名仍交同一 SDK 验证，不建立第二根。Core 身份与保留的 Full 更新身份分别绑定。仅 Core 与同一 Store 的官方资源通过验证才显示完成，缓存复用仍核验原 receipt。

Box 生产端先验证原来源证明，镜像推荐 EXE、NSIS 后端、完整 ZIP 和八份资源文件，回读全部原字节并完成历史归档，最后更新 `Updates/latest.json`。资源版本目录只补缺，不覆盖异内容。公开分享使用既有根地址，实际同步状态以版本号和回读结果为准。

## 界面与取消

安装前没有进度条或内部 Core/EPL 术语。下载显示真实字节进度；安装和资源准备的未知阶段显示不定进度。完成后默认勾选启动，只在点击完成时启动，取消勾选或关闭 X 不启动。取消等待实际写入进程安全停止；错误按安装、权限、恢复或资源阶段准确报告。

## 验证边界

常规 CI 的 `installer / Windows` 进入 ci-gate 和发行源码门禁，复用真实 Native 控件、下载、SDK、Store、App 与受控历史 NSIS 回归。`verify.ps1` 在 runner 独立目录执行；测试与截图保存在 CI artifacts，不进入 Release 附件。

`test-native.ps1` 的 UI 注入和 `capture-ui.ps1` 的演示截图只证明控件行为；真实 v1.1 双签名回归只证明既有来源链。新可信 Core/官方资源正式发布后的冷缓存首次安装、持久缓存断网启动与已安装桌面启动仍必须另行实测，不能用 fixture、旧版证明或构建报告代替。旧 v1.1 缺少新安装桥，不能作为新安装完成证据，也不重新发布旧资产。
