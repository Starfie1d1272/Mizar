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

`installOfficialPack` 是安装桥，运行位置为产品 `resources/app/dist/web-installer/install-official-pack.mjs`，从 Companion 的真实依赖解析 `@mizar/resource-pack-contract/runtime`。先认证并冻结全部原输入，再只把验证器返回的文件字节交给传入的唯一 Store；直接保存 shared verifier 返回的 `verified.receipt`，由共享模块唯一拥有 schema 与离线信任材料。无 activation provider、未 active、不可读取默认三份 EPL 清单或视频时均不能返回完成。版本号本身不证明当前 sourceSha／promotionSha／manifest 身份；安装桥通过 #250 的 `store.reuseActive(packId,createActivePolicyVerifier(policy),{signal})` 在互斥内复验当前 receipt、完整目标策略和所有实际文件。缓存命中无需归档或网络，默认 EPL 可读后再次确认同一活动身份。新安装也使用该接口确认实际激活的 manifest 等于本次验证结果，不把 prepared 或同版本旧内容当完成。`readOfficialWebResource(store,path,range)` 为既有 `/fixtures/...` 与 `/fixture-media/epl-s24/...` 提供映射，所有字节及 Range 仍由唯一 Store 负责，不新增监听器或第二缓存。

本 PR 明确 stack 于 #250 `b10747a`（其 base 为 #248），没有复制或 cherry-pick 对方提交。Companion 已注册真实依赖与 Store App/static-host 接线，shared verifier 已提供离线 receipt/TUF snapshot 复验。`completeBootstrap({app,coreRoot,corePlan,policy,inputs,...})` 在认证的部署 Core 中复用既有 `verifyPayload` 校验全部实际文件，核对固定 Core 版本、源码、内容身份与 installed 标记，再调用 `app.ready()` 和 `app.getDecorator('getResourceStore')()` 获取 App 唯一实例。Core 与该 Store 的官方默认资源都通过才返回完成，不接收调用方自报的 CoreInstalled/ResourcesReady 布尔值，不启动新 listener 或另开 Store。

可将 owned 模块部署到 `resources/app/dist/web-installer/` 后运行定向脚本：`test-pack-cache-boundary.mjs <deployed-install-official-pack.mjs>` 使用真实 SDK 拒绝同版本、错误源码的 receipt；`test-bootstrap-boundary.mjs <deployed-complete-bootstrap.mjs> <isolated-published-core> <StableSource-authenticated-plan.json>` 使用公开正式 Core 的真实字节、真实 App 和 Store，验证资源缺失／Core 身份错误不能报完成。资格脚本只在隔离副本写 installed 标记，不执行 Windows 安装；此步骤不替代之前实际 NSIS runner 证据。

尚缺有效新资源签名和正式 Core-only Setup，无法宣称首次成功入库、真实 receipt 断网命中或最终原生窗口完整安装已通过。默认构建仍 Full；Core-only 仍 developmentOnly。

定向 Windows run 37991657925 已实际下载原 83,607,477-byte NSIS、在带空格的全新目录安装、拒绝覆盖既有安装，并证明安装过程中取消等待退出后由原卸载器清理。临时合并 #248/#250 的真实代码、注册真实依赖后，真实 producer 生成了 34,367,014-byte/43-file EPL 归档；真实 Sigstore 入口拒绝已有正式发行但 subject 错误的证明，实际 Store 保持 missing，未伪报 resourcesReady。这仍不替代有效新资源签名、首次成功入库、断网 EPL 和最终 Core-only 产品启动证据。
