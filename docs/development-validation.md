# 开发与验证

本文维护本地开发、自动化和证据方法。RC 构建、Windows 实机测试与正式发布的顺序由[发布流程](release-readiness.md)维护。

## 本地运行

Node 与 pnpm 版本以根 [package.json](../package.json)为准。云环境先 `source /workspace/.onboarding/activate.sh`（如存在）。依赖变化遵循[依赖维护](dependency-maintenance.md)。

```sh
pnpm install --frozen-lockfile
pnpm build
export GSI_TOKEN=mizar-local-preview
pnpm dev
```

PowerShell 用 `$env:GSI_TOKEN = "mizar-local-preview"`。示例令牌仅用于本机开发，真实接入与 CS2 配置保持一致。

开发网页为 `http://127.0.0.1:4173/`，Companion 为 `http://127.0.0.1:3000/`。生产构建由 Companion 同时提供网页和协议。

| 路径 | 用途 |
| --- | --- |
| `/` | 准备中心 |
| `/preview` | 节目预览；`?scene=bp` 打开 BP 工作台 |
| `/operator/hud` | HUD 编辑器 |
| `/workspace` | 浏览器工作台预览 |
| `/operator` | 制作控制 |
| `/program`、`/program/bp` | HUD 与 BP 播出 |
| `/debug` | 运行诊断 |
| `/operator/bp` | 兼容重定向到 BP 预览工作台 |

桌面左右区和底栏由 Host 管理。浏览器预览不证明 Windows 窗口捕获、DPI 或 OBS 正式输出。

## 工作区构建图

各包 `package.json` 的 workspace 依赖是唯一跨包构建图。pnpm 12 原生 `tasks` 调度 `build → ^build`，独立包按默认并发运行；不使用额外编排器或实验性 pipeline。TypeScript 不维护第二套跨包 references，每个 `tsc -p` 只编译本包，普通构建保留增量信息而不用 `--force`。

`build` 产生本包 `dist`；`typecheck` 编译器全部使用 `--noEmit`。类型检查通过显式 `^build` 任务先准备依赖的公开导出，不能把类型检查的副作用当构建入口。Radar 独立消费者示例通过 `consumer:typecheck → build` 检查实际发行声明，源代码类型检查仍不输出产物。

`build:packages` 从 workspace manifest 展开共享包的依赖，供 lint、unit 和浏览器验收使用。样例命令选择 Companion 或 RivalHub 及其依赖；不会手写逐包编译顺序。所有定向构建必须带 `...` 与 `--fail-if-no-match`。包循环、未声明导入、跨 scope 识别、references、手写顺序和不安全定向构建由 architecture 门禁拒绝；实际 `--dry-run --json` 任务图也与 manifest 自动对照。

```sh
pnpm -r run --dry-run --json build
pnpm --filter @mizar/rivalhub... --fail-if-no-match run build
pnpm --filter @mizar/companion... --fail-if-no-match run build
```

首次执行的验证必须在独立工作树中冻结安装，每个入口前清空所有 `dist` 和 `.tsbuildinfo`，分别运行构建、类型、lint、unit、样例与验收准备，不能先全量构建再声称其它入口独立成功。

## 验证层次

| 层次 | 证明什么 | 常用入口 |
| --- | --- | --- |
| 领域与契约 | 状态、身份、时钟、恢复、投递、结构和依赖边界 | `pnpm test`、`pnpm architecture:check` |
| 类型、样式与构建 | 类型一致性和可构建性 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` |
| 浏览器 | 关键操作、布局结构、预览、配置与数据来源隔离 | `pnpm acceptance:test` |
| 设计系统 | 变量、组件交互、无障碍与组件目录 | `pnpm design:check` |
| 打包与启动 | 便携资源、脚本、服务与桌面启动 | `pnpm qualification:offline`、`pnpm local-web:production-smoke` |
| 真实制播 | 指定包在 Windows + CS2 + OBS 的完整流程与长时运行 | [Production Acceptance #35](https://github.com/Starfie1d1272/Mizar/issues/35) |

实时链路变更按影响覆盖：重放、慢消费者、重连、重复/乱序、代际与地图切换、错场与过期资料、正式节目与辅助隔离、队列/内存增长。界面还检查键盘、焦点、减少动效、缺失媒体与长文本。

1.0 前不维护全站截图或像素门禁。浏览器自动化验证语义与结构，人工查看真实回放和画面；宣传截图与诊断截图不能替代功能或实机证据。

## CI 按改动选择检查

权威分类在 [scripts/ci](../scripts/ci/)；`ci-gate` 是稳定的必需检查。

- 普通文档只运行计划器和汇总检查；`docs/design/**` 另运行设计检查。
- 代码运行基础质量检查，Web 语义与验收路径增加浏览器验收，平台相关路径增加对应平台检查。
- 未知路径、无法确定的差异、工作流、锁文件、工具链或计划器改动默认完整验证。
- 删除按旧路径分类；重命名按旧/新路径的风险并集分类。差异采用 NUL 分隔，无法解析的记录仍完整验证。
- quality 分成 static、unit、fixtures、typecheck/build 四个并行 lane；所有选中 lane 成功才算 quality 成功。
- 浏览器验收按文件分成四个独立 job，每个保持一个 worker 和原串行语义；所有 shard 成功才算 acceptance 成功，失败报告按 shard 独立保留。
- Windows/macOS 验证 production build、文件系统/进程/传输与 production host smoke；完整 JS unit suite 在 Ubuntu 执行一次，Windows 包另有 Rust 与 GUI smoke。
- 普通 main push 与 PR 按差异选择；main 的未知/工具链差异完整验证并包含离线验收。定时和显式手工验证始终完整；Desktop、打包或 GSI 配置差异需要 Windows qualification。RC 使用独立 Release Qualification 和 release profile。

不要为了避免检查改变分类或恢复旧锁文件。执行过的检查如实写入 PR，未执行的不得记为通过。

## 样例、重放与来源

有已提交真实记录时优先从生产适配器生成样例；合成输入只用于明确边界与展示压力，并注明来源。HUD 与雷达同时展示时必须属于同一采集来源、同一回放游标，缺失时不拼接相近帧。

```sh
pnpm fixtures:program:verify
pnpm fixtures:radar:verify
pnpm fixtures:replay:verify
pnpm fixtures:rivals-rehearsal:verify
```

生成使用同名 `:generate` / `:sync` 命令，审查产物差异；验证命令只读。真实回放从生产组合重建并核对来源、内容摘要和协议。`packages/replay` 只负责游标/调度，原始输入处理留在 Companion/testkit。

Rivals 排练的赛事资料来自公开赛程，局内遥测来自独立真实采集，两者来源必须区分。排练通过专用系列赛驱动器和显式地图绑定组织阶段，不改造原始地图或 Steam64。排练期间不读写生产检查点、不上传快照、不入队可靠事件；退出或切换真实来源清空排练状态。完整阶段断言以[浏览器验收](../tests/acceptance/)与相关运行时测试为准。

头像等可选外部素材仅在开发期导入，记录来源和摘要；凭据不进入运行时、页面或 CI。资源提取也只在开发期运行，CI 验证已提交清单、摘要和许可。

## 便携包自动化

Desktop 通过 localhost Companion 读取随包 Web，Tauri 不嵌入生产 Web 副本。正式 Web 保留 Ancient 编辑器回放，排除开发专用 Nuke 回放；每次产品构建校验资源边界。

常规 Windows CI 使用继承 release 断言语义的专用 `ci` 配置，降低编译优化并保留增量。CI 的手工入口可选 `benchmark_desktop`，在同一 Windows runner 对照 Host 重编译与完整启动 smoke；Cargo target cache 仅由 main 写入，PR 读取共享缓存。正式 RC 使用默认 `release` 配置，构建身份记录该差异。`--allow-dirty` 或 `--skip-node-runtime` 产物不能作为正式实机验收包。

- `product-smoke.mjs` 检查服务、安装/恢复和重启，`--no-browser` 模式不证明桌面窗口成功。
- `desktop-smoke.mjs` 启动正常 EXE，检查同包健康、所属进程的可见窗口、页面导航、无可见 Node 控制台与完整退出；失败注入核对错误、回滚和日志。
- `product-soak.mjs` 在同一进程运行合成比赛流程，检查连续更新和有界投递，不冒充真实整场比赛。
- 原生另存为、DPI、多显示器、真实 CS2 与 OBS 仍在 RC 上实测。

```sh
node scripts/qualification/desktop-smoke.mjs <bundle-root> <report.json>
pnpm qualification:verify <evidence-dir-or-zip>
```

验收工具与产品模式的 GSI 脚本分开使用，不混用。`MIZAR_STATE_ROOT` 如自定义，产品、脚本与验收必须指向同一绝对目录，且在 `resources` 外。工具使用说明随 RC 包交付。

## 证据与结果

报告使用 `PASS / FAIL / INCONCLUSIVE`，分别为通过、失败、证据不足。记录源码 SHA、构建包身份、环境、场景、时间、报告与完整性摘要；环境恢复结果与核心验收结果分开。

数据停止与人工确认 CS2 退出是两条不同证据，不能相互推断。最终校验器重新核对采集、标记、运行状态和摘要，不仅依赖页面状态。

目标计时的独立数值精度与生命周期判定见[专项验收](validation/objective-timing.md)。整场验收范围只由 #35 维护，不在这里复制现场清单。
