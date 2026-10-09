# Core 构建与 Windows 引导器

正式构建仍默认全量；显式运行 `node scripts/qualification/build.mjs --resource-mode core-only` 可生成不含 EPL 回放、视频、样例头像的 Core 实验包。基础地图、武器、品牌、字体、HUD 与节目代码仍在 Core；开发服务器仍提供所有原夹具。`MIZAR_WEB_RESOURCE_MODE=core-only pnpm --filter @mizar/web build` 仅构建 Web。检查器要求模式一致，拒绝可选夹具，并逐文件核对必要静态资源。Core 实验在 artifact/release manifest 中记录模式、Web 字节数和原有版本、源码身份；无论平台如何均标记 developmentOnly，不能直接晋级为正式发行。

## 下载引导器

采用 Windows 自带 .NET Framework 4.x、WinForms、HttpClient。原生控件保留系统键盘和焦点，中文正文使用 Microsoft YaHei UI，页眉使用现有 NSIS 双星 BMP、深蓝品牌背景；不引入浏览器或 UI 框架。欢迎、下载、取消、失败重试和验证完成均说明当前实际状态。旧 NSIS 继续拥有系统安装、卸载与用户资料保留。当前窗口明确标识验证预览，不能声称安装已完成。

在 Windows PowerShell 执行：

```powershell
./scripts/web-installer/test-poc.ps1 -OutputDirectory .agent-tmp/web-installer
./scripts/web-installer/capture-poc.ps1 -OutputDirectory .agent-tmp/web-installer
```

独立工作流只读 contents，无发布、签发、Box 写入或凭据权限。生成的 EXE 是 POC，禁止正式发布；固定引导计划编译进程序，下载源不能更改预期摘要。样例只下载 v1.1.0 的 NSIS 许可文件，所有可执行计划均拒绝。缓存使用 `%LOCALAPPDATA%/Mizar/bootstrap-cache`，按已固定摘要和名称存放；它只保存下载字节，不承担 Resource Store 状态或资产激活。

下载限制 HTTPS、地址白名单、五跳以内重定向、每源五分钟、最多四源和 512 MiB。禁止来源携带用户名、密码或非默认端口，不发送授权头或 Cookie；系统验证 TLS 证书。完整大小与 SHA-256 通过后原子落盘，复用缓存前再次验证，不联网即可命中。文件锁避免同身份并发写入，拒绝目录链接；失败和取消删除半成品。当前不支持 Range 断点续传：中断后重新下载，避免未经证明的片段拼接；这仍是 #244 后续验收项。不能把缓存摘要检查当发布者来源证明。

## 必须接通的接口

#237 必须提供 `official:epl-default` 的原始归档、manifest、逐文件解析及验证结果；#243 必须认证固定 signer@main、声明源码、版本、归档大小与摘要，不能将镜像提供的哈希编译成新的信任根。只有认证结果才能生成正式 Core 与 Pack 的固定下载计划。#238 的唯一 Store 安装 API 接收已认证归档，完成有界逐文件核对和原子持久入库，缓存位置不受 NSIS 卸载影响。此处不猜测或复制尚未落地的模块方法签名。

最终 #228 需要从该真实认证结果下载两项资产，复用既有 NSIS 安装 Core，再经唯一 Store 入库默认 Pack；两者均 ready 后才展示安装完成并启动产品。失败不得将缺 EPL 的 Core 报为完整安装成功。还需实际验证静态 Web 路径到 Store 的读取、启动时离线缓存命中、旧包迁移、制作期间不热切换。默认模式切换由父协调集成，不能只靠下载器的测试文件证明该链路。

## 证据边界

`capture-poc.ps1` 从实际原生 EXE 窗口截屏，保存 ready/result 和 Windows 信息，不生成 HTML 原型。测试处理器证明网络失败边界和缓存契约；实际 HTTPS 下载由独立窗口步骤证明。GitHub runner Windows Server 的结果不代替 Windows 10/11 与 125%/150% DPI 实机验收，也不证明真实 NSIS 安装、资源入库或断网 EPL 播放。体积以 `build.json` 为准；Web 的 ZIP 测量不代替完整 Setup 体积或 Quick/Full/Release wall-time。

本次 Linux 工作区同源码 Web 实测（既有依赖缓存，先 Full 后 Core；不是冷／热对照）：Full 98,144,273 bytes，ZIP 44,534,530 bytes，构建 1.378s、压缩 2.162s；Core 12,527,012 bytes，ZIP 10,117,650 bytes，构建 1.081s、压缩 0.382s。ZIP 减少约 77.3%。没有重编译 Rust、生成 Setup 或发行，因此不能由此宣称 Full<=180s 或 Release<=600s。

公开入口只读验证：GitHub 的固定许可样例实际下载并核对成功；Box 分享根目录返回 HTTP 200、Content-Type text/html，不能据此宣称已有可用的文件直链或将其作为第一下载源。
