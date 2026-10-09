# Core 构建与 Windows 引导器

正式构建仍默认全量；显式运行 `node scripts/qualification/build.mjs --resource-mode core-only` 可生成不含 EPL 回放、视频、样例头像的 Core 实验包。基础地图、武器、品牌、字体、HUD 与节目代码仍在 Core；开发服务器仍提供所有原夹具。`MIZAR_WEB_RESOURCE_MODE=core-only pnpm --filter @mizar/web build` 仅构建 Web。检查器要求模式一致，拒绝可选夹具，并逐文件核对必要静态资源。Core 实验在 artifact/release manifest 中记录模式、Web 字节数和原有版本、源码身份；无论平台如何均标记 developmentOnly，不能直接晋级为正式发行。

## 下载引导器

采用 Windows 自带 .NET Framework 4.x、WinForms、HttpClient。原生控件保留系统键盘和焦点，中文正文使用 Microsoft YaHei UI，页眉使用现有 NSIS 双星 BMP、深蓝品牌背景；不引入浏览器或 UI 框架。欢迎、下载、取消、失败重试和验证完成均说明当前实际状态。旧 NSIS 继续拥有系统安装、卸载与用户资料保留。当前窗口明确标识验证预览，不能声称安装已完成。

在 Windows PowerShell 执行：

```powershell
./scripts/web-installer/test-poc.ps1 -OutputDirectory .agent-tmp/web-installer
./scripts/web-installer/capture-poc.ps1 -OutputDirectory .agent-tmp/web-installer
```

独立工作流只读 contents，无发布、签发、Box 写入或凭据权限。生成的 EXE 是 POC，禁止正式发布；固定引导计划编译进程序，下载源不能更改预期摘要。样例只下载 v1.1.0 的 NSIS 许可文件，该窗口不接收可执行安装计划。缓存使用 `%LOCALAPPDATA%/Mizar/bootstrap-cache`，按已固定摘要和名称存放；它只保存下载字节，不承担 Resource Store 状态或资产激活。

下载限制 HTTPS、地址白名单、五跳以内重定向、每源五分钟、最多四源和 512 MiB。禁止来源携带用户名、密码或非默认端口，不发送授权头或 Cookie；系统验证 TLS 证书。完整大小与 SHA-256 通过后原子落盘，复用缓存前再次验证，不联网即可命中。文件锁避免同身份并发写入，拒绝目录链接；失败和取消删除半成品。当前不支持 Range 断点续传：中断后重新下载，避免未经证明的片段拼接；这仍是 #244 后续验收项。不能把缓存摘要检查当发布者来源证明。

## 必须接通的接口

#237 必须提供 `official:epl-default` 的原始归档、manifest、逐文件解析及验证结果；#243 必须认证固定 signer@main、声明源码、版本、归档大小与摘要，不能将镜像提供的哈希编译成新的信任根。只有认证结果才能生成正式 Core 与 Pack 的固定下载计划。#238 的唯一 Store 安装 API 接收已认证归档，完成有界逐文件核对和原子持久入库，缓存位置不受 NSIS 卸载影响。此处不猜测或复制尚未落地的模块方法签名。

最终 #228 需要从该真实认证结果下载两项资产，复用既有 NSIS 安装 Core，再经唯一 Store 入库默认 Pack；两者均 ready 后才展示安装完成并启动产品。失败不得将缺 EPL 的 Core 报为完整安装成功。还需实际验证静态 Web 路径到 Store 的读取、启动时离线缓存命中、旧包迁移、制作期间不热切换。默认模式切换由父协调集成，不能只靠下载器的测试文件证明该链路。

## 证据边界

`capture-poc.ps1` 从实际原生 EXE 窗口截屏，保存 ready/result 和 Windows 信息，不生成 HTML 原型。测试处理器证明网络失败边界和缓存契约；实际 HTTPS 下载由独立窗口步骤证明。GitHub runner Windows Server 的结果不代替 Windows 10/11 与 125%/150% DPI 实机验收，窗口截图本身也不证明真实 NSIS 安装、资源入库或断网 EPL 播放。体积以 `build.json` 为准；Web 的 ZIP 测量不代替完整 Setup 体积或 Quick/Full/Release wall-time。

本次 Linux 工作区同源码 Web 实测（既有依赖缓存，先 Full 后 Core；不是冷／热对照）：Full 98,144,273 bytes，ZIP 44,534,530 bytes，构建 1.378s、压缩 2.162s；Core 12,527,012 bytes，ZIP 10,117,650 bytes，构建 1.081s、压缩 0.382s。ZIP 减少约 77.3%。没有重编译 Rust、生成 Setup 或发行，因此不能由此宣称 Full<=180s 或 Release<=600s。

公开入口只读验证：GitHub 的固定许可样例实际下载并核对成功；Box 分享根目录返回 HTTP 200、Content-Type text/html，不能据此宣称已有可用的文件直链或将其作为第一下载源。

## 真实 NSIS 与官方 Pack 接线进度

`pin-stable-core.mjs` 复用已构建 Companion 的 `StableSource`，认证真实 Stable 后生成固定 NSIS 下载／执行输入；不接受镜像自报摘要或另一个信任根。`legacy-stable-plan.json` 与实际认证的 v1.1.0 输出完全一致，只用于原安装器资格验证，不是新 Core-only 发行。

`Nsis.Install` 在同一个只读锁定 fd 上复核大小／摘要，再直接调用既有 NSIS；固定 `/S /MIZARUPDATE /D=` 参数，不经过 shell，也不接收网页命令。只允许全新当前用户程序目录或隔离资格目录；既有目录、登记、快捷方式或 Mizar 进程均拒绝。写入开始后的取消先等 NSIS 退出，再调用它生成的原卸载器清理；不强杀写入进程，不递归删除用户目录。超时仍在运行时明确返回需要恢复的目录并保留现场；持久 `fresh-install.pending` 标记在 NSIS 启动前写入，只有写入与所需清理均结束才删除，崩溃／超时后拒绝再次安装。未完成标记需要随原安装器恢复一并处理，当前预览不提供自动恢复入口。完成只表示 Core 安装及身份核对，不表示默认资源就绪。默认 POC 窗口仍固定许可下载，不启用实际用户安装。

`installOfficialPack` 是安装桥，运行位置为产品 `resources/app/dist/web-installer/install-official-pack.mjs`，从 Companion 的真实依赖解析 `@mizar/resource-pack-contract/runtime`。策略只来自共享 SDK 双证据验签产生的进程内授权句柄，裸 policy 或自报 trusted 均拒绝。先认证并冻结全部原输入，再只把验证器返回的文件字节交给传入的唯一 Store；直接保存 shared verifier 返回的 `verified.receipt`，由共享模块唯一拥有 schema 与离线信任材料。无 activation provider、未 active、不可读取默认三份 EPL 清单或视频时均不能返回完成。版本号本身不证明当前 sourceSha／promotionSha／manifest 身份；安装桥通过 #250 的 `store.reuseActive(packId,createActivePolicyVerifier(policy),{signal})` 在互斥内复验当前 receipt、完整目标策略和所有实际文件。缓存命中无需归档或网络，默认 EPL 可读后再次确认同一活动身份。新安装也使用该接口确认实际激活的 manifest 等于本次验证结果，不把 prepared 或同版本旧内容当完成。`readOfficialWebResource(store,path,range)` 为既有 `/fixtures/...` 与 `/fixture-media/epl-s24/...` 提供映射，所有字节及 Range 仍由唯一 Store 负责，不新增监听器或第二缓存。

本 PR 已同步最新 main `cc49b9c`，其中 #248/#250/#254 已由父会话合并；堆叠提交已清除，diff 仅保留 #247 自己的改动。共享 `catalog.mjs` 唯一拥有八文件目录的规范结构，CI producer 与客户端共同使用；目录验签沿用真实 SDK signer@main / 精确源码 OID / Sigstore seed，不接受外部 verifier。

`authenticatePublishedBootstrap({version,tufCachePath,signal})` 先复用既有 StableSource 认证 Core，按固定同版本地址获取原 Qualification descriptor、证明和 Promotion catalog、证明。两证明成功后才导出不可伪造的 `authorization` 句柄；绑定原 descriptor SHA、Core ZIP 身份、Pack archive/manifest、公示声明 SHA、八个固定下载地址与公开资产大小／摘要。返回 `{corePlan,authorization,inputs}`，不依赖用户 gh。新资源 receipt 由 SDK 保留 `catalog` 双证据与信任材料；不新增缓存或状态。

`completeBootstrap({app,coreRoot,corePlan,authorization,inputs,...})` 复用既有 `verifyPayload` 核对实际 Core，再获取 `app.getDecorator('getResourceStore')()` 同一实例。在线安装与 reuseActive 共用授权句柄导出的策略；无在线句柄时，只能从该 Store 的原 receipt 用 SDK 离线复验双证明恢复。App 在已认证 Core 的 productRuntime 版本／源码上下文中支持此离线 receipt，不从镜像或裸缓存字段推导信任。Core 与默认资源均通过才返回完成，不另开 Store/listener。旧无 catalog receipt 仍只能由既有受信任 Core 策略授权，默认 Full 继续回退到随包 URL。

可部署到 `resources/app/dist/web-installer/` 运行定向 `test-pack-cache-boundary.mjs` 与 `test-bootstrap-boundary.mjs`。独立 Windows workflow 现在实际部署生产依赖、运行 Store FS 与 SDK 目录拒绝测试，并在真实 NSIS 安装完成、原卸载之前调用 Node bootstrap 门禁；许可预览原生截图独立捕获，不把该窗口截图当完整安装证据。Linux 临时副本资格脚本只在 installed 标记原不存在时写入并移除，不改已存在标记。

尚缺有效新资源签名和正式 Core-only Setup，无法宣称首次成功入库、真实 receipt 断网命中或最终原生窗口完整安装已通过。默认构建仍 Full；Core-only 仍 developmentOnly。

定向 Windows run 37991657925 已实际下载原 83,607,477-byte NSIS、在带空格的全新目录安装、拒绝覆盖既有安装，并证明安装过程中取消等待退出后由原卸载器清理。临时合并 #248/#250 的真实代码、注册真实依赖后，真实 producer 生成了 34,367,014-byte/43-file EPL 归档；真实 Sigstore 入口拒绝已有正式发行但 subject 错误的证明，实际 Store 保持 missing，未伪报 resourcesReady。这仍不替代有效新资源签名、首次成功入库、断网 EPL 和最终 Core-only 产品启动证据。

## 实际原生入口与产品打包

`build-poc.ps1 -CoreBootstrap` 通过既有 StableSource 实际认证当前 Stable Core 计划，嵌入 developmentOnly 的 `Mizar-WebInstaller-Core-Development.exe`；不接受 caller 裸摘要作为签发身份。默认 EXE 仍只验证许可。Core 入口窗口调用真实 Downloader / NSIS，随后运行安装后 Core 自带的 Node 与 `installed-entry.mjs`；不是资格 harness 的外部脚本。执行前将 Core 清单摘要绑定固定计划，并在同一只读锁内核对 Node、入口和其静态依赖摘要。SDK 双签名与资源路径规则仍由共享模块唯一负责。

`installed-entry.mjs` 由正式构建脚本与另外三个桥模块一同打包进 Core 校验清单。入口先验证全部实际 payload 和 Native 固定 Core 身份，再从此 Core 动态导入真实 App，不创建第二 Store/listener；使用产品默认持久素材目录与现有 updates/trust 目录。先尝试同一 Store 离线双证明复验，失败时才通过认证目录在线准备。完成后关闭该 App 释放写锁，Native 核对完成 Core 身份后启动已验证的 Mizar.exe。取消通过 stdin 传给实际 AbortController，等待子进程安全结束；素材失败保留 Core，同一窗口重试只继续素材，重新打开也仅在已安装 Core 精确匹配计划时继续。

代码具备原生入口 → 固定 Core/NSIS → Core 内入口 → 实际 App 唯一 Store → 完成启动的调用链。当前公开 v1.1 Core 没有新增入口，实际 Native 桥会在执行任何 Node 前拒绝；不能通过注入外部脚本替代。仍缺带该入口的新受信任 Core/Setup 与有效目录/资源双证明的真实正向发行证据，首次成功缓存、断网 EPL、完整安装后启动未实证。开发入口准备截图只证明实际窗口存在，不证明安装完成。

取消控制使用有界按行解析，接受 Windows CRLF / LF 及跨块到达；回归通过实际 Node 子进程 stdin pipe，逐次确认分块读入并检查真实 AbortController。解析模块随 Core 打包，并在 Native 执行锁内核对摘要。安装主路径一次点击后自动下载、校验、安装与准备素材，完成后自动启动；开发标识置于标题。传输暂时失败只在原固定身份、原下载锁及原五分钟预算内自动重试一次；摘要、路径或重定向验证失败不自动重试，恢复边界保留。
