# 开发与验证

本文维护开发入口、验证选择与证据要求。版本命名、RC 构建、Windows 实机验收和正式发布门禁由[发布流程](release-readiness.md)维护；普通修改不自动扩展为发布任务。

## 本地运行

Node、pnpm 和命令以根 [package.json](../../package.json)为准。云环境如有 `/workspace/.onboarding/activate.sh`，先 source；依赖变化遵循[依赖维护](dependency-maintenance.md)，已有环境满足验证时不重复安装。

```sh
pnpm install --frozen-lockfile
pnpm build
export GSI_TOKEN=mizar-local-preview
pnpm dev
```

PowerShell 使用 `$env:GSI_TOKEN = "mizar-local-preview"`。示例令牌仅供本机开发，实际接入须与 CS2 配置一致。

开发网页为 `http://127.0.0.1:4173/`，Companion 为 `http://127.0.0.1:3000/`；生产构建由 Companion 同时提供网页和协议。

| 路径 | 用途 |
| --- | --- |
| `/` | 准备中心 |
| `/operator/hud` | HUD 编辑器 |
| `/workspace` | 浏览器工作台预览 |
| `/operator` | 制作控制 |
| `/program`、`/program/bp` | HUD 与 BP 播出 |
| `/debug` | 运行诊断 |
| `/operator/bp` | 重定向到 BP 预览工作台 |

Windows 窗口、缩放、游戏与 OBS 交互必须另做实机验证，浏览器预览不能替代。

## 工作区构建图

工作区 `package.json` 共同定义依赖图，pnpm 原生任务调度 `build → ^build`。每个 `tsc -p` 只编译本包，普通构建保留增量；不手写跨包编译顺序。

- `build` 产生本包 `dist`。`typecheck` 使用 `--noEmit`，其公开依赖通过显式 `^build` 先准备，不能借类型检查副作用构建。
- `build:packages` 从清单展开共享包依赖，供 lint、测试和浏览器验收使用。
- 定向构建必须包含依赖闭包 `...` 与 `--fail-if-no-match`。Radar 独立消费者检查发行声明，而非只检查源代码。
- 架构门禁检查工作区和包内相对运行时循环、未声明导入、路径映射、references、不安全定向构建及实际任务图与清单的一致性。桌面原始 IPC 仅允许统一传输入口调用，参数与结果由 Rust 契约生成；新增命令必须同步窗口权限和生成文件。

```sh
pnpm -r run --dry-run --json build
pnpm --filter @mizar/rivalhub... --fail-if-no-match run build
pnpm --filter @mizar/companion... --fail-if-no-match run build
```

修改工具链、构建图或入口前置依赖时，在独立工作树冻结安装；分别在无 `dist`/`.tsbuildinfo` 的状态验证受影响入口，不能先全量构建再声称入口独立可用。普通任务不重复这套验证，也不清空其他任务的产物。

## 验证层次

按改动风险选择检查，保留能独立证明边界的最少验证，不为每次修改扩大矩阵。

| 改动面 | 必要核对 |
| --- | --- |
| 文档 | 当前源码/界面/命令、内容归属、链接与被引用标题；无产品改动不声称已验证产品行为 |
| 领域逻辑、协议、持久化 | 对应现有测试、类型和生产构建；涉及依赖或职责边界另跑 `pnpm architecture:check` |
| 界面或视觉 | 类型、构建、相关交互与失败状态；按设计系统执行 `pnpm design:check` |
| 脚本、工具链、CI | 相关脚本测试及真实入口；构建图变化另验证入口独立性 |
| 原生宿主、安装、更新 | Windows 编译与受影响原生验证；真实生命周期按任务范围另做实机验收 |
| 候选或正式发布 | [发布流程](release-readiness.md)规定的精确产物、资格与实机门禁 |

自动化启动实际构建的 Companion，核对就绪、主页面渲染无未捕获异常及正常退出。Chromium 被信号终止、失败或超时应保留原因和有界 stderr，不放宽门禁。`--app-version` 只核对 EXE 版本，不证明 GUI 加载或正常退出。

### 测试职责与独立判定

- 只保留能独立证明关键风险结果的用例。优先从生产入口核对实际副作用、持久化结果或隔离边界；删除依赖内部调用顺序、重复覆盖或需要随实现同步改写的低价值用例。预期结果由独立证据确定。
- 对真实风险覆盖成功、失败/未知、取消、重试和陈旧请求。不同领域复用窄契约，不在每层复制完整矩阵。
- 持久化和恢复检查原文件、精确身份、提交顺序与重启后的结果；不能以空队列、空状态或一次成功请求证明恢复完整。
- 对外命令的受理、回执、读回与最终音画分开验证。协议桩能证明控制逻辑，不能证明 Windows、CS2、OBS 或直播平台真实效果。
- 检查通过后，只有新改动、失败或未解决风险才补充验证。最终提交后重跑受影响检查；环境缺失明确列为未运行或证据不足。

## 操作记录与失败可诊断性审查

目标是按时间还原所选会话中的用户操作、系统阶段和失败原因。文档要求不等于现有产品已经满足，缺口在 PR 明确。

1. **产生**：操作执行前记录名称、必要参数、时间与关联身份；多阶段操作记录转换和终态。正常操作同样记录，不采集无关软件活动。
2. **保留原因**：简化为界面提示之前，保存原错误链、稳定原因码和失败阶段。区分拒绝、取消与未知，不用统一 `false/null` 吞因；重复观察聚合仍保留首末、次数和原因变化。
3. **持久化**：区分已受理、已提交、未提交及未知。日志容量和保留期受控，写失败不能掩盖原操作或递归报错。
4. **导出**：包括所选保留范围的完整记录及相关快照，摘要只作索引。大包分卷或明确选择范围，不静默裁剪后称完整；过期、读取失败、未落盘、缺卷等在覆盖信息中表达。
5. **隐私**：保留排查所需技术路径、业务身份、请求和配置上下文，精确替换密码、令牌及推流密钥。文件内容只在必要且授权的范围收集，用户诊断包不进公共仓库或 CI。
6. **独立验证**：在生产导出入口读取实际包，核对操作顺序、参数、阶段、原因、结果与缺口，验证凭据不泄露。仅 HTTP 400、日志调用次数或生成一个文件不足以通过。

PR 核对“产生 → 持久化 → 导出 → 可定位”。界面保持简短、可操作，技术完整性不应转成默认界面的大段说明。导出职责见[架构](../reference/architecture.md#诊断证据历史与导出)，回传另见[诊断契约](../reference/diagnostics-delivery.md)。

## CI 检查

常规 CI 执行类型、构建、格式、基础 lint、`architecture:check`、仓库保留的全部 JavaScript/TypeScript 独立测试，以及实际 Companion/网页启动和正常退出。main、手动运行或涉及桌面宿主、嵌入资源、CI 工作流的 PR 另做 Windows 编译；无法确定差异时也编译。

测试入口：[scripts/ci/tests.mjs](../../scripts/ci/tests.mjs)。它从 Git 跟踪文件发现 `*.test.*` / `*.spec.*`，按 `node:test` 或 Vitest 导入分派，未知或混用框架时失败，不维护逐文件允许列表。保留测试所需数据随仓库交付，并由所属 CI 作业执行。

```sh
node scripts/ci/tests.mjs scripts
pnpm build
node scripts/ci/tests.mjs product
pnpm typecheck
pnpm format:check
pnpm lint
pnpm architecture:check
```

`quality` 运行脚本组，`build` 完成生产构建后运行产品组。Windows 常规作业执行 build/clippy；涉及原生准备、取消或恢复的行为，以目标环境的实际验证记录为准。安装器源码或构建流程改变时，同一 Windows 作业使用正式 .NET Framework 编译器和引用编译 C#，不运行安装器。

`ci-gate` 要求所选作业成功，并检查从运行创建到门禁的 180 秒预算；排队/执行不保证到期瞬间被终止。作业摘要记录运行尝试、runner 等待、执行时长和失败步骤。常规 Ubuntu 作业跳过历史截图，保留运行时素材。ESLint 使用推荐的语法级规则，类型语义由 TypeScript 检查。缓存键、稀疏检出和调度细节由[工作流](../../.github/workflows/)维护，达标必须看真实整轮结果。

**常规 CI 不运行真实安装、同版更新、取消或回滚生命周期。** `verify-update-recovery.mjs` 是显式 Windows 受控验证，不在常规 CI 中。编译、脚本桩和门禁成功均不能代替安装验收或实机音画。

## 桌面 IPC 与可靠输出

修改[桌面 IPC 声明](../../apps/desktop/src-tauri/ipc_contract.rs)后，从 `apps/desktop/src-tauri` 编译并运行 `ipc_generate.rs`，命令为 `rustc --edition=2021 ipc_generate.rs -o <临时可执行文件路径>`。Windows 构建核对生成的命令名及全部参数与结果校验。

`runtime_performance_window` 分别记录 Outbox worker 的快照准备、SQLite 写事务以及 Companion 主线程的事件循环延迟。主线程诊断使用 20 ms 采样间隔，实际制作机的接收间隔以现场诊断为准。

## 样例、重放与来源

优先使用已有真实记录经生产适配器生成样例；合成输入仅用于明确边界/压力，并标明来源。HUD 与雷达必须来自同一采集和游标，不拼接相近帧。

```sh
pnpm fixtures:program:verify
pnpm fixtures:epl:verify
pnpm fixtures:radar:verify
pnpm fixtures:replay:verify
pnpm fixtures:epl-rehearsal:verify
pnpm fixtures:rivals-rehearsal:verify
```

生成使用对应 `:generate` / `:sync` 命令并审查差异；验证只读。重放组合核对来源、摘要和协议，`packages/replay` 只拥有调度/游标，原始输入处理仍在生产适配器。

- 编辑器默认 EPL S24 Falcons 对 Natus Vincere 的 Inferno 真实采集；BO3 BP 使用同场公开禁选与确认开赛时间。BO1/BO5 的合成中性队伍明确标注，不造公开赛事事实。
- 开发排练按显式地图绑定使用对应采集，没有记录的局内阶段不提供选择。历史 Rivals 入口仅作回归，不进入产品样例菜单。
- 排练隔离生产检查点、网站快照与可靠队列；退出/换来源清空排练状态。来源切换变更需核对这些边界。
- 真实重放逐帧发布并等待该帧 C4 计算；现场接收继续异步和有界合并，不因测试改成阻塞。
- 媒体使用 `ReplaySession.getPlaybackElapsedUs()` / `getPlaybackSpeed()`，不另建时钟。帧间呈现可连续，比赛事实不插值；暂停、跳转失败和结束边界保留正确游标。
- 外部素材记录来源、摘要和许可，导入凭据不进页面或 CI。素材提取在开发期运行，CI 校验提交清单。

### 编辑器实景回放验证

正式包的 EPL 开局/决胜定位使用已校验的生成投影，不依赖开发服务前缀重建。`epl-inferno-video` 属于 `recorded-projections`：投影与同期视频分别校验摘要，同游标配对；跳转不冒充重新计算原始 GSI。

浏览器验收核对视频解码、事件定位、播放/暂停、预设切换、背景隐藏恢复、损坏素材拒绝与切换后的资源清理。实际编码观感、声音及视频/投影时间偏差仍需实机证据。样例不能替代当前 RC 验收。

## 便携包自动化

构建器与离线检查共用版本和命名规则，只验本次目录/ZIP。整个应用目录检查开发文件和符号链接，不能仅因依赖目录叫 `test` 就删除运行资源。Desktop 从同包 Companion 加载 Web，不嵌入第二份生产网页。

便携包仅保留运行需要的 Node 与许可，不携带 npm、Corepack、类型声明、源码映射或构建缓存；精简后生成摘要和清单。正式资源集与历史测试素材由构建器隔离，产品构建核对边界。首次校验与服务启动各有期限和进度，不能让前者吃掉后者预算。

定向 Windows CI 使用继承 release 断言语义的 `ci` profile；正式 RC 使用 `release`。`--allow-dirty` 或 `--skip-node-runtime` 产物不能用于正式实机验收。完整打包、GUI、安装、恢复及来源身份仍由 Release Qualification 验证。

```sh
node scripts/qualification/desktop-smoke.mjs <bundle-root> <report.json>
pnpm qualification:verify <evidence-dir-or-zip>
```

验收脚本与产品 GSI 配置分开。自定义 `MIZAR_STATE_ROOT` 时，产品、脚本和验收指向同一绝对目录，且在 `resources` 外；操作说明随 RC 交付。

## 证据与结果

- 使用 `PASS / FAIL / INCONCLUSIVE`，记录源码 SHA、构建身份、环境、场景、时间、报告及摘要。区分实现、自动化、实机和环境恢复，不把未运行记为通过。
- 并发构建/验证结束前等待全部必要任务，失败不能留下通过结论。各阶段耗时记录实际边界，不能相加重叠阶段推算墙钟，也不以历史单轮结果替代新版本 Qualification。
- 数据停止与确认 CS2 退出分别取证；最终校验器重新核对采集、运行状态、标记和摘要，不只相信页面。
- 安装器桩验证文件系统及受控失败，不证明真实 NSIS 或登录恢复。资源/SDK 只读检查可并行，原生 UI、截图与安装生命周期顺序执行并完整收尾。
- 更新计时等诊断不改变原核验、恢复或回滚语义。测量失败应保留原操作结果并明确告警，不为了取得数字削弱验证。

目标计时的独立数值与生命周期判定见[专项验收](../validation/objective-timing.md)，整场验收范围由 [#35](https://github.com/Starfie1d1272/Mizar/issues/35)维护。正式发布要求以[发布流程](release-readiness.md)为准。
