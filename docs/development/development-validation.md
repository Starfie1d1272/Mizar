# 开发与验证

本文维护本地开发、自动化和证据方法。RC 构建、Windows 实机测试与正式发布的顺序由[发布流程](release-readiness.md)维护。

## 本地运行

Node 与 pnpm 版本以根 [package.json](../../package.json)为准。云环境先 `source /workspace/.onboarding/activate.sh`（如存在）。依赖变化遵循[依赖维护](dependency-maintenance.md)。

```sh
pnpm install --frozen-lockfile
pnpm build
export GSI_TOKEN=mizar-local-preview
pnpm dev
```

PowerShell 用 `$env:GSI_TOKEN = "mizar-local-preview"`。示例令牌仅用于本机开发，真实接入与 CS2 配置保持一致。

开发网页为 `http://127.0.0.1:4173/`，Companion 为 `http://127.0.0.1:3000/`。生产构建由 Companion 同时提供网页和协议。

| 路径                      | 用途                                 |
| ------------------------- | ------------------------------------ |
| `/`                       | 准备中心                             |
| `/preview`                | 节目预览；`?scene=bp` 打开 BP 工作台 |
| `/operator/hud`           | HUD 编辑器                           |
| `/workspace`              | 浏览器工作台预览                     |
| `/operator`               | 制作控制                             |
| `/program`、`/program/bp` | HUD 与 BP 播出                       |
| `/debug`                  | 运行诊断                             |
| `/operator/bp`            | 兼容重定向到 BP 预览工作台           |

桌面左右区和底栏由桌面宿主管理。Windows 窗口捕获、显示缩放与 OBS 正式输出通过实机验收验证。

## 工作区构建图

各包 `package.json` 的工作区依赖共同定义跨包构建图。pnpm 12 原生 `tasks` 调度 `build → ^build`，独立包按默认并发运行。每个 `tsc -p` 编译本包，普通构建保留增量信息；跨包顺序统一由 pnpm 调度。

`build` 产生本包 `dist`；`typecheck` 编译器全部使用 `--noEmit`。类型检查通过显式 `^build` 任务先准备依赖的公开导出，不能把类型检查的副作用当构建入口。Radar 独立消费者示例通过 `consumer:typecheck → build` 检查实际发行声明，源代码类型检查仍不输出产物。

`build:packages` 从工作区清单展开共享包的依赖，供静态检查、单元测试和浏览器验收使用。样例的 TSX 入口只构建 Companion 的工作区依赖；读取 RivalHub 发行导出的同步工具构建 RivalHub 及其依赖，不手写逐包编译顺序。所有定向构建必须带 `...` 与 `--fail-if-no-match`。包循环、未声明导入、跨 scope 识别、references、手写顺序和不安全定向构建由 architecture 门禁拒绝；实际 `--dry-run --json` 任务图也与清单自动对照。

```sh
pnpm -r run --dry-run --json build
pnpm --filter @mizar/rivalhub... --fail-if-no-match run build
pnpm --filter @mizar/companion... --fail-if-no-match run build
```

首次执行的验证必须在独立工作树中冻结安装，每个入口前清空所有 `dist` 和 `.tsbuildinfo`，分别运行构建、类型、lint、unit、样例与验收准备，不能先全量构建再声称其它入口独立成功。

## 验证层次

| 层次             | 证明什么                                          | 常用入口                                                             |
| ---------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| 领域与契约       | 状态、身份、时钟、恢复、投递、结构和依赖边界      | `pnpm test`、`pnpm architecture:check`                               |
| 类型、样式与构建 | 类型一致性和可构建性                              | `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`     |
| 浏览器           | 关键操作、布局结构、预览、配置与数据来源隔离      | `pnpm acceptance:test`                                               |
| 设计系统         | 变量、组件交互、无障碍与组件目录                  | `pnpm design:check`                                                  |
| 打包与启动       | 便携资源、脚本、服务与桌面启动                    | `pnpm qualification:offline`、`pnpm local-web:production-smoke`      |
| 真实制播         | 指定包在 Windows + CS2 + OBS 的完整流程与长时运行 | [制播实机验收 #35](https://github.com/Starfie1d1272/Mizar/issues/35) |

实时链路变更按影响覆盖：重放、慢消费者、重连、重复/乱序、代际与地图切换、错场与过期资料、正式节目与辅助隔离、队列/内存增长。界面还检查键盘、焦点、减少动效、缺失媒体与长文本。

浏览器自动化验证语义与结构，人工审查真实回放与视觉效果。宣传图集展示产品体验；功能验证与实机验收各自记录结果。

## 测试职责与独立判定

测试保持精简、高质量，只保留必要的行为、契约和风险验证。

- 不因代码变更默认新增测试。新增真实行为、安全边界或缺陷复现时优先扩展已有负责测试；纯文案、纯视觉和不改变外部契约的内部整理按受影响检查验证。
- 测试用户行为与契约，预期来自需求、独立样例或客观边界，不通过无意义模拟或复制生产算法证明实现等于自身。不锁定无需求依据的 CSS 选择器、组件或函数身份、DOM 结构、源码字符串和像素常量；雷达世界几何、裁剪、焦点、协议版本等客观安全边界可以明确断言。
- 同一规则只在唯一负责层维护完整矩阵；跨层测试只覆盖独立的真实交互或故障模式，不重复下层矩阵。
- 自动化、真实 Windows / CS2 / OBS 与视觉审美判断各有证据边界。浏览器模拟不证明原生性能，截图本身不是断言。
- 不以测试数量或覆盖率作为交付目标，不新增 skip/retry，不弱化真实发布与恢复门禁。

## CI 按改动选择检查

权威分类在 [scripts/ci](../../scripts/ci)；`ci-gate` 是稳定的必需检查。

- 普通文档只运行计划器和汇总检查；`docs/design/**` 另运行设计检查。
- 代码运行基础质量检查，Web 语义与验收路径增加浏览器验收，平台相关路径增加对应平台检查。
- Core、Radar、Radar View、HUD Config、Protocol、Telemetry GSI 的 `src/`，以及 Companion 的运行时、投影、场景、协议发布、配置、BP、比赛资料、系列进展、重放、公开输出与应用组装入口，保守增加完整的既有浏览器验收。精确前缀由计划器维护；这些规则保障消费者回归范围；本地服务与浏览器的完整链路另由集成检查验证。
- 浏览器验收映射适用于上述实现路径；普通文档、CSS 和包外部测试按各自规则分类。基础质量、平台与 Windows 资格构建分别判定，多文件变更取风险并集。
- 未知路径、无法确定的差异、工作流、锁文件、工具链或计划器改动默认完整验证。
- Box 镜像工具及其测试由基础质量任务负责：校验已发布资产身份、远端字节、授权和失败时不发布更新清单；这两个明确路径不进入产品载荷，无需重编译 Desktop 或重复安装。与安装器、更新恢复、候选来源、Desktop 或其它路径混合时仍取所有风险并集；Windows 打包、安装和恢复消费者按明确的已知文件清单保持真实 Windows 验证，不对 bundle、installer-assets 或 evidence 目录作整目录豁免；资格证据完整性及新增未知文件回退完整验证；候选、晋级、Stable 信任协议与未知 qualification 工具完整验证，工作流仍保守回退。
- 删除按旧路径分类；重命名按旧/新路径的风险并集分类。差异采用 NUL 分隔，无法解析的记录仍完整验证。
- 基础质量检查（`quality`）分为静态检查、单元测试、样例、类型与构建四路并行任务；全部选中任务通过后汇总成功。
- 浏览器验收按文件分成四个独立任务，每个任务使用一个工作进程串行执行；全部分片通过后，ci-gate 核对四份实际身份的并集恰好覆盖同一 FULL 且无重复，再汇总成功，失败报告按分片保留。`pnpm acceptance:ci --shard=N/4` 分别记录 FULL 发现、分片发现和实际执行身份，拒绝空集合、遗漏、额外用例、skip、retry 和 runner 错误；只有实际成功执行集合与所选集合一致才通过。证据保存在 `.agent-tmp/test-evidence/`，CI 随分片上传。
- 基础质量已选中时，设计任务只执行自身的 token 检查，架构和设计契约由基础质量统一执行；仅设计任务选中时仍执行这些门禁。
- Windows/macOS 验证生产构建、文件系统、进程、传输与宿主启动；完整 JavaScript 单元测试在 Ubuntu 执行，Windows 包另有 Rust 测试和桌面启动检查。
- 主分支推送与 PR 按差异选择检查；主分支的未知路径或工具链差异执行完整验证与离线验收。定时和手动验证始终完整；桌面、打包或 GSI 配置变化需要 Windows 资格构建。候选版使用独立的 Release Qualification 工作流和 `release` 构建配置。

不要为了避免检查改变分类或恢复旧锁文件。执行过的检查如实写入 PR，未执行的不得记为通过。

## 样例、重放与来源

有已提交真实记录时优先从生产适配器生成样例；合成输入只用于明确边界与展示压力，并注明来源。HUD 与雷达同时展示时必须属于同一采集来源、同一回放游标，缺失时不拼接相近帧。

```sh
pnpm fixtures:program:verify
pnpm fixtures:epl:verify
pnpm fixtures:radar:verify
pnpm fixtures:replay:verify
pnpm fixtures:epl-rehearsal:verify
pnpm fixtures:rivals-rehearsal:verify
```

生成使用同名 `:generate` / `:sync` 命令，审查产物差异；验证命令只读。真实回放从生产组合重建并核对来源、内容摘要和协议。`packages/replay` 只负责游标/调度，原始输入处理留在 Companion/testkit。

同步媒体读取 `ReplaySession.getPlaybackElapsedUs()` 的呈现时间与 `getPlaybackSpeed()` 的播放倍率，不另建播放时钟。呈现时间在相邻数据帧之间连续推进，暂停与恢复保留帧间位置，跳转重建期间冻结，成功后定位到目标帧；失败保留原位置，末帧停止。该时间只用于媒体呈现，不插值或补造 HUD、雷达的比赛事实。回归覆盖非零起点、倍率、帧间暂停恢复、跳转失败和调度延迟后的结束边界。

HUD 编辑器默认样例使用 EPL S24 Falcons 对 Natus Vincere 的 Inferno 真实采集。`fixtures/epl-s24` 保存公开比赛资料、脱敏片段和头像摘要；生成器经本机比赛资料适配器与生产重放组合，同时生成同游标的 HUD 和雷达。片段只证明已记录状态，不能代替完整比赛或当前 RC 的实机截图。历史 Rivals 样例保留为回归资料，不出现在 HUD 编辑器样例菜单中。

BP 内置 BO3 演示使用同场 EPL 公开禁选和已确认的 UTC 开赛时间，不展示未来比分或补造决胜图选边。BO1、BO5 使用明确标为合成的中性队伍，覆盖赛制边界，不声称来自该场 EPL。HUD 编辑器直接消费所选样例，不再将其他赛事的 BP 替换进历史遥测；历史 Rivals 记录仅由回归测试直接引用，不注册到产品样例中。编辑器头像预览使用 EPL 的本地媒体，合成头像边界保留给测试。

真实回放关闭现场的有界发布合并，逐帧发布对应输入游标并等待 C4 预测队列完成，由回放组合刷新当前投影；等待期间抑制重复的异步完成通知，避免系统消息调度差异改变通道序号。生产接收仍使用异步完成通知与有界合并，不等待预测线程。

开发服务默认使用 EPL S24 排练资料，包含 2–1 组比赛及 NAVI 后续比赛的四场赛程。生成器核对采集文件摘要，将 Falcons 对 NAVI 的 Inferno、Mirage 原始观测绑定到对应地图；没有对应采集的局内阶段不列入阶段选择，已确认的单图结果仍来自公开赛果。加载时同时校验遥测结构与地图名称，不能把其他地图的数据套入当前比赛。历史 Rivals 排练只保留显式回归入口。

排练通过专用系列赛驱动器和显式地图绑定组织阶段，不改造原始地图或 Steam64。排练期间不读写生产检查点、不上传快照、不入队可靠事件；退出或切换真实来源清空排练状态。运行时阶段与退出隔离由[排练测试](../../apps/companion/test/rivals-rehearsal.test.ts)验证；开发样例不能替代当前 RC 的 Windows 实机证据。

预设与样例的可选外部素材在开发期导入，记录来源和摘要；素材导入凭据不进入页面或 CI。用户可在本机配置运行时 Steam 头像备用媒体，密钥不进入比赛资料、采集、预设或支持包，见 [ADR-0034](https://github.com/Starfie1d1272/Mizar/blob/3b187e168ad755ede595eb8371bfaf5933c044fa/docs/decisions/0034-local-steam-avatar-fallback.md)。资源提取也只在开发期运行，CI 验证已提交清单、摘要和许可。

### 编辑器实景回放验证

内置 EPL 开局与决胜回合也直接定位到经过完整摘要、协议和双通道游标校验的生成投影；正式包跳转不依赖开发服务的前缀重建接口。生成时仍通过生产适配器重放原始输入，不把浏览器跳转称为重新计算原始前缀。

`epl-inferno-video` 保存 RC27 实际输出的 Program/Radar 投影及同期 OBS 游戏捕获视频。两种投影按完整游标配对；计时刷新可能复用输入序列，不要求投影序列逐次加一。素材标为 `recorded-projections`，跳转选择经过摘要与协议校验的已录投影，不声称重新执行原始 GSI 前缀。视频单独校验摘要，离线头像仅替换媒体路径，比赛事实保持原样。生产资源检查核对视频、投影、事件索引、来源文件和头像摘要。浏览器验收覆盖真实视频解码、同一事件定位、连续播放、暂停、五套预设切换、背景隐藏与恢复、损坏素材拒绝及切换来源后的资源移除；编码观感、原生回放提示和画面与投影的实际时间偏差仍需实机审查。

## 便携包自动化

离线验收与构建器共用应用版本和发布包命名函数，检查同一版本的目录及 ZIP；不接受其他版本的归档替代本次产物。检查整个应用目录中残留的开发文件和符号链接，不仅凭依赖目录名为 `test` 就删除可能被运行入口引用的资源。发布名称规范见[发布流程](release-readiness.md)。

Desktop 通过 localhost Companion 读取随包 Web，Tauri 不嵌入生产 Web 副本。便携包仅包含 Node 可执行文件与许可，不携带 npm、Corepack、TypeScript 声明（含 `.d.mts` / `.d.cts`）、明确脚本与样式扩展名的源码映射或构建缓存；资源摘要和校验清单在精简后生成。首次启动采用有界并发校验，并记录文件进度；桌面分别为产物校验和服务就绪计时，不能让校验耗时挤占服务启动期限。正式 Web 使用 EPL Inferno 开局与决胜回合回放，包含本地头像；历史 Ancient 与 Nuke 回放只用于开发回归，不进入生产包。每次产品构建校验资源边界。

常规 Windows CI 使用继承 release 断言语义的专用 `ci` 配置，降低编译优化并保留增量。CI 的手工入口可选 `benchmark_desktop`，在同一 Windows runner 对照 Host 重编译与完整启动 smoke；Cargo 缓存仅由 main 工作流写入，PR 只读；下载依赖与编译产物分开保存，编译产物按实际 Rust 工具链、依赖和 `ci` / `release` 配置建立稳定基线；Cargo.lock 中的本地 Mizar 版本及 Cargo.toml 的 package.version 不参与缓存指纹，避免每次 RC 升版本制造冷缓存，其他依赖与编译配置变更仍会改变指纹；不再按提交 SHA 保存整份 target。相同基线命中后不重复上传，依赖或工具链变化建立新基线；GitHub 仍可能按容量和最近使用时间淘汰缓存。缓存命中与恢复键写入 Actions 摘要，构建分阶段耗时写入摘要和 `build-timings.json`，失败阶段也保留记录。正式 RC 使用默认 `release` 配置，构建身份记录该差异。`--allow-dirty` 或 `--skip-node-runtime` 产物不能作为正式实机验收包。

- `local-web-production-smoke.mjs` 验证生产 HTML、资源传输、样式表类型与构建内容一致性、CS2 资源摘要及真实 WebSocket 基线；它不执行浏览器页面，不证明最终 HUD 已渲染。
- `pnpm local-web:production-browser-smoke` 在已构建的 Companion 与 Web 上执行真实 HTTP GSI → 运行时／投影 → WebSocket → Chromium，使用已保存 Ancient 回合的 628 帧并核对摘要。它检查队伍、十名选手、雷达实际绘制、C4 阶段与回合结束比分，不拦截 HTTP 或 WebSocket；比赛资料与接收时钟由回放夹具提供。先通过 pnpm 构建图构建 Companion 与 Web，并安装 Chromium；不要在浏览器运行期间重建共享包。此回合片段不证明完整现场制播或 Windows／OBS 性能。
- `product-smoke.mjs` 检查服务、安装/恢复和重启，`--no-browser` 模式不证明桌面窗口成功。
- Windows 发布与 CI 使用资源管理器 ZIP 处理器解压，等待全部文件落盘后校验资源并启动；不能只用 `tar` 解压证明“全部提取”兼容。
- `desktop-smoke.mjs` 启动正常 EXE，检查同包健康、所属进程的可见窗口、页面导航、无可见 Node 控制台与完整退出；失败注入核对错误、回滚和日志。 控制台采样遇到 Win32 5 时重新查询原 PID 与创建时间，只有确认原进程已退出才接受该采样；活进程检查失败与可见控制台仍判失败。
- `product-soak.mjs` 在同一进程运行合成比赛流程，检查连续更新和有界投递，不冒充真实整场比赛。
- 原生另存为、DPI、多显示器、真实 CS2 与 OBS 仍在 RC 上实测。
- Windows CI 与资格构建运行 `verify-update-recovery.mjs`，使用明确的独立安装器样例验证成功、取消、写入失败、宿主残留和中断后的旧版恢复及资料保留。签名测试使用真实正式发布证明，离线验证证书、签名与透明日志；浏览器验证更新日志优先展示、单次明确操作衔接安装、取消与延迟安装意图、制作保护及错误反馈。实际旧版到新 Stable 的 NSIS 升级、登录恢复入口及 CS2 / OBS 制作保护仍需 Windows 实机验收。
- PowerShell 检测回归从 DesktopLog 的真实规范化目录进入同一后台执行器，覆盖 Windows 逐字路径前缀；故障注入核对原始 stderr、退出码、超时、无效 JSON、输出限额和凭据脱敏。不能仅直接运行脚本代替桌面调用边界验证。
- Windows Steam 路径发现先规范化绝对路径、斜杠、大小写与尾部分隔符，再核对唯一安装；注册信息和库清单重复引用同一路径不算多个安装，真正不同的安装仍拒绝自动选择。候选按 AppID 730 清单定位并验证程序及新版 cfg；旧版 cfg 不产生第二份安装。原生手动选择与 GSI、启动共用安装位置，读取失败与真实配置冲突分别举证。重复接收地址自动备份／停用与恢复须覆盖重试、中断及原路径被其他软件重新创建的情况；不同地址配置保持不变。后台 CS2 巡检的锁竞争不表示人工操作正在执行，配置进度只展示启动、恢复与设置变更。

```sh
node scripts/qualification/desktop-smoke.mjs <bundle-root> <report.json>
pnpm qualification:verify <evidence-dir-or-zip>
```

验收工具与产品模式的 GSI 脚本分开使用，不混用。`MIZAR_STATE_ROOT` 如自定义，产品、脚本与验收必须指向同一绝对目录，且在 `resources` 外。工具使用说明随 RC 包交付。

## 证据与结果

Windows CI 对 Setup 启用 `create-windows-setup.ps1 -CaptureUi`，实际操作中文向导、选择桌面快捷方式、完成后启动 Mizar 并正常停止，保存欢迎、目录、快捷方式、进度和完成页截图，以及安装包摘要、系统版本和实际 DPI。截图在 Desktop smoke 诊断资产的 `installer-ui` 中供维护者签收；截图与自动化通过不代替审美判断。125% / 150% 缩放必须在对应实际 DPI 下复核中文和控件边界；报告未覆盖的缩放仍待实机验收。验收者可在对应 Windows 显示缩放下运行 `scripts/qualification/capture-setup-ui.ps1`，指定同一安装包、全新安装目录和证据目录。

安装器素材清单记录原标志来源、许可、SVG 与 BMP 的大小和 SHA-256。Setup 构建先核对清单与原标志，再将素材清单、图标和素材摘要记录到 `distribution-manifest.json`；这些是安装器构建输入，不进入被安装内容的身份。正式构建缺少素材或摘要不符时停止；直接编译 NSIS 脚本未指定素材目录时可使用 MUI2 默认画面。

报告使用 `PASS / FAIL / INCONCLUSIVE`，分别为通过、失败、证据不足。记录源码 SHA、构建包身份、环境、场景、时间、报告与完整性摘要；环境恢复结果与核心验收结果分开。

数据停止与人工确认 CS2 退出是两条不同证据，不能相互推断。最终校验器重新核对采集、标记、运行状态和摘要，不仅依赖页面状态。

目标计时的独立数值精度与生命周期判定见[专项验收](../validation/objective-timing.md)。整场验收范围只由 #35 维护，不在这里复制现场清单。
