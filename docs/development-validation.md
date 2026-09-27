# 开发、CI 与真实环境验收

本文定义“在哪里开发”“自动化证明什么”“真实赛事环境还需要证明什么”。三者不能互相替代。

## 1. 三类环境

```text
开发环境
  macOS / Windows / Linux
        ↓
自动化验证
  GitHub Actions + deterministic tests
        ↓
真实环境验收
  Windows + CS2/CSTV + OBS
```

开发环境不需要复制生产环境；真实环境要求也不能因为 CI 通过而被省略。

## 2. 验证层级

### A. 确定性领域与协议

任意开发机和 CI 都应尽量覆盖：

- RuntimeState / RuntimeTransition；
- objective clock anchor、map/source reset、defuse kit evidence 与 short-lease expiry；
- identity / session / map epoch；
- source continuity；
- gap-resync / stale-recovery objective anchor invalidation；
- Program / Assist non-leak；
- projection 与 wire schema；
- Radar 数学；
- latest-wins 背压；
- replay / fault injection；
- RivalHub contract validation；
- architecture guard。

如果这些测试必须依赖真实 Windows 或 CS2，优先检查是否错误耦合了平台实现。

### B. Browser / local runtime

覆盖：

- Fastify Companion；
- 静态网页与本地 WebSocket；
- `/program` / `/operator` / `/debug`；
- `/operator/hud` 的三类配置工作区、共享 `GameplayHud` 预览与 HUD ETag conditional polling；
- HUD Replay 的真实 capture browser acceptance，包括事件 seek/play、Radar utility 阶段、objective progress、Focused Player observer handoff；
- 浏览器 reconnect；
- current baseline；
- Origin / subprotocol / LAN policy；
- production web smoke。

Browser acceptance uses real-derived Program fixtures whenever committed capture evidence exists. Synthetic fixtures are reserved for explicit edge/fail-closed or presentation stress and must declare provenance/reason. Browser acceptance checks behavior and semantic state; diagnostic screenshots may be attached, but do not determine pass/fail.

1.0.0 前不维护 screenshot / pixel baseline。HUD 视觉调整通过本地 fixture 页面、真实回放和 Browser acceptance 的语义/结构断言人工验收；诊断截图可以作为临时证据，但不进入仓库，也不决定 CI pass/fail。

真实 Program fixture 经 production adapter、ProgramRuntime 和 ProjectionCoordinator 生成，包含 capture 路径、目标 sequence 和来源 hash。数据更新流程仍为：提交 capture → `pnpm fixtures:program:generate` → 审查 Program snapshot diff。#76 的连续 replay artifact 通过 `pnpm fixtures:replay:generate` 从固定 Ancient 第 3 回合与第 11 回合 capture 生成；Program、Radar、cursor 和 semantic event index 来自同一 production composition，并由 `pnpm fixtures:replay:verify` 检查 hash 与内容漂移。HUD Editor 只消费本地生成并校验过的 Program/Radar projection；seek 由 Vite 开发期 local-only harness 从 capture 起点重建 production composition 前缀，再返回同一 cursor 的 projection pair 核对 artifact。Web 与 testkit 共用 `packages/replay` 中 framework-neutral 的离散 cursor/scheduler；capture 读取、Raw GSI adapter 与 replay prefix composition 留在 Companion/testkit 边界，不能进入 Web runtime。HUD Replay browser acceptance 使用固定真实 capture，检查语义事件 seek/play、utility handoff、objective progress 和 observer identity handoff。1.0.0 前不生成、提交或比较截图 baseline。合成展示压力测试使用确定性本地/data-URI 图片；#76 的真实头像仅由本机可选导入步骤 materialize 为本地、带来源与 SHA-256 的 fixture asset。导入脚本只从 `STEAM_WEB_API_KEY` 环境变量读取，Replay、HUD editor、acceptance test 与 CI 不访问 Steam。团队名称来自 capture，team logo 单独通过 fixture-local MatchContext presentation enrichment 绑定；无可验证素材时保持 unavailable。CI 使用 `pnpm fixtures:program:verify` 检测生成产物漂移，验证命令不写入文件。

HUD 编辑器的日常场景列表只露出少量真实遥测回放与必要展示边界；完整 fixture 注册表继续服务回归测试。`bp-rivals-*` 使用生产 RivalHub 中 2026 NJU Rivals 总决赛、胜者组半决赛的公开 BP 与赛果生成系列图条切面；背景 GSI 来自另一场已提交的真实回放，**不能作为这些赛事的游戏过程证据**。未进行地图没有赛果，未确认的起始边保持缺失，决胜图不伪造选图方。

### C. 真实 CS2 / CSTV

覆盖：

- GSI cfg 安装与发现；
- planting / planted / defusing overloaded countdown semantics；
- objective timing qualification report 与真实 Capture V1 cadence / residual evidence；
- qualification measurement、provenance、scenario coverage 与独立 CSTV/demo reference gate；
- Production Capture Recorder 的 raw provenance、capture clock origin、objective reference
  contract 与显式 8 场景 marker；sanitized fixture 不能作为 production PASS；
- observer payload；
- update cadence；
- 回合与地图生命周期；
- stale / reconnect；
- source generation；
- paired no-delay / delayed CSTV；
- alignment drift 与恢复。

### D. Windows + OBS 正式验收

覆盖：

- 长时间比赛流程；
- CPU / memory / latency；
- Program Browser Source；
- reload / restart；
- DPI、多显示器和窗口模式；
- 本机 Program host 与 OBS 的语义一致性；
- Assist 私有显示不进入正式 Program capture；
- Lookahead 故障只降级 Assist；
- fallback / recovery runbook。

CI 绿灯不能替代 D 层。

## 3. PR 风险规划器

PR 使用 changed-surface planner，只运行与改动面匹配的证据。

### 仅文档改动

只修改 `docs/**` 或 Markdown / MDX：

```text
planner + ci-gate
```

不运行 quality / acceptance / platform / qualification。

### 普通代码

`apps/`、`packages/`、`tests/`、`scripts/` 的已知路径至少进入 quality。Web 的语义源码（`.ts` / `.tsx` / `.js` / `.jsx` / `.html`）、Replay 和 acceptance test 路径额外运行 browser acceptance；Web CSS-only 改动只运行 quality。Companion、telemetry 和 scripts 等平台敏感路径运行 platform。

### 现场验收敏感路径

`scripts/qualification/`、`apps/companion/src/qualification/` 和 GSI cfg 模板会触发 Windows qualification artifact / portable smoke。

### 默认完整验证

以下情况 fail closed 到 full CI：

- 未知或无法分类路径；
- rename / delete 等不安全 diff status；
- `.github/**`；
- CI planner 自身；
- lockfile / workspace / package manifest；
- TypeScript / ESLint / Vitest / Playwright 等工具链配置。

非 PR 事件使用完整验证，并包含 offline qualification。

CS2 asset import 是维护者本地资源工作流：CI 不安装 CS2、不下载 VPK、不运行 extraction，只验证 checked-in `@rivalhub-broadcast/cs2-assets` catalog、manifest、SVG hash、public output 与 resolver contract。首次生成或更新 asset 时，必须使用 `pnpm cs2-assets:import` 的 pinned Source2Viewer-CLI，并把 Steam build ID、source/output hash 和工具版本提交在 manifest 中。

`ci-gate` 是稳定 required context；条件 job 本身不需要全部设成 branch required check。

## 4. 自动化主入口

常规仓库验证：

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm fixtures:program:verify
pnpm fixtures:replay:verify
pnpm test
pnpm build
pnpm architecture:check
pnpm acceptance:test
pnpm local-web:production-smoke
```

视觉验收使用开发期 fixture 页面与真实回放人工检查；自动化只验证行为、语义、结构与运行时边界。

现场验收工具：

```text
pnpm qualification:build
pnpm qualification:offline
pnpm qualification:objective-timing <capture-dir>
pnpm qualification:verify <evidence-dir-or-zip>
```

具体 PR 由 planner 选择子集；手工排查时可直接运行需要的完整命令。

HUD 编辑器的浏览器验收覆盖样例、确定性重放与实时来源切换；实时来源失效时保持选择并安全隐藏，恢复后继续读取当前状态。验证已实现组件的显隐、拖动、Radar 尺寸与视野、保存/启用和冲突语义。普通 UI 不提供外观工作区、外观选择或未实现组件的占位与交互，既有 theme/placement schema 继续兼容。Program 保持透明且不包含产品导航或编辑辅助层。1.0.0 前不维护严格截图断言或 canonical pixel baseline；各平台只做本地预览、浏览器冒烟与语义/结构验收。

## 5. Windows 便携产品与现场验收

真实 CS2 输入使用绑定 exact git SHA 的便携式 Windows 验收包。目标机不需要安装 Git、pnpm 或 Node，也不在现场改代码。

稳定结构：

```text
rivalhub-broadcast-<shortSHA>-win-x64/
  RivalHub Broadcast.exe
  README.txt
  resources/
    runtime/node.exe
    app/
    web/dist/
    scripts/
    config/
    metadata/
  state/
    data/
    logs/
    evidence/
```

正式包需要 Windows x64 构建，编译 Tauri 2 桌面 Host 并绑定 bundled Node / supervisor 摘要。`--skip-node-runtime` 只生成结构检查包；`--allow-dirty` 生成的包同样标记 `developmentOnly`，不能作为产品启动或真实验收的 exact-revision artifact。

双击 EXE 默认打开 Broadcast Workspace：左侧 `/workspace/left`、底部 `/workspace/dock`，本机 Program Overlay 使用同一套 Program Scene registry。`resources/scripts/start-product.ps1` / `stop-product.ps1` 是自动化备用入口。GSI 配置使用 `install-gsi.ps1 -Product` 安装、`restore-gsi.ps1 -Product` 恢复；安装和恢复前停止服务。现场验收仍使用同目录下 `install-gsi.ps1`、`start.ps1` 与 `stop.ps1`，不要混用两种模式。

`BROADCAST_STATE_ROOT` 可以指定 resources 之外的绝对目录；正常运行、GSI 脚本和验收必须使用相同值。HUD 配置、系列进度、capture 和日志均进入该目录。现场验收临时状态位于 `state/qualification`，完成后仍由现有 supervisor 恢复 GSI 配置并清理。

Windows CI 从带空格路径解压 ZIP，以 `product-smoke.mjs` 调用真实 EXE，检查冷启动、同 artifact 复用、停止/重启、未知端口占用、资源损坏和 GSI 安装/恢复。该 smoke 没有 CS2/OBS，不能构成生产验收通过。

React 制作界面与 standalone `/qualification` 页面通过打包的 `product-shell.css` 共用颜色、字体、导航和外边距 token；验收页仍由 Companion 独立生成。Windows portable smoke 会确认 exact artifact 提供这份共享样式。

同一 exact artifact 随后由 `product-soak.mjs` 在单个 Companion 进程中运行三段各 24 回合的脚本化合成地图流程。测试以已脱敏 GSI fixture 的 observation 形状生成回合状态，经认证 `/gsi` 入口和 production telemetry adapter 进入 Runtime，同时观察 Program / Radar / Operator publication、浏览器断线重连、投递合并/失败、Host 连接、慢消费者事件和 Companion CPU / working set。`host-soak.json` 与 ZIP 一同作为 exact-SHA CI artifact 上传。该脚本只验证便携产品中的连续状态更新与有界投递；合成流程不是完整真实比赛录制，也不能替代 Windows + CS2 + OBS 现场验收。

现场验收标准流程：

```text
安装 GSI 配置
→ 启动验收服务
→ 打开 /qualification
→ 播放第一场
→ 退出 CS2 并观察数据停止
→ 开始下一场执行
→ 重开 CS2 并播放第二场
→ 导出并验证验收证据
→ 恢复原 GSI 配置
```

机器观测到的数据停止与人工声明“已退出 CS2”是两个不同证据；二者都必须在下一场 reset 前成立。

最终结果由独立 verifier 重新核对 capture、marker、runtime 与完整性哈希，不能只相信页面按钮状态。

## 6. 验收结果

机器 contract 使用：

```text
PASS
FAIL
INCONCLUSIVE
```

用户界面对应显示：

```text
通过
失败
证据不足
```

环境恢复状态与核心语义验收结果分开记录。恢复 GSI 配置失败不能篡改已经冻结的核心验收结果。

## 7. 证据原则

真实环境证据必须绑定：

- git SHA / artifact；
- Windows version；
- CS2 version；
- 输入配置；
- 场景说明；
- 时间与完整性哈希；
- 对应报告。

真实平台验证者使用仓库产生的 artifact，不在目标机临时改代码后把结果归因给另一个 revision。

## 8. 协作模型

默认使用：

```text
功能负责人
+ 平台验证者
```

平台验证者负责提供真实环境证据，不因此成为整个 telemetry/runtime 模块的代码 owner。

只有 installer、Windows packaging、topmost/click-through window 等平台本身就是功能语义的工作，才适合把实现 ownership 整体交给 Windows-specific contributor。

BP 浏览器验收从已提交 NJU Rivals BO3/BO5 记录构造 MatchContext 测试封装，经过生产 validator、MatchContextController、Core projection、Companion session 和共享 Web renderer。只补 fixture-local transport map ID，缺失名单保持空，不伪造 gameplay evidence。Connected 路径覆盖同一 Preview/Program 累积 reveal、BO3 决胜图只显示 SIDE_PICK actor、BO5 刀局不显示选边、reload/断连恢复 baseline、收起与重播。Local authoring 覆盖固定 BO sequence、7-map pool、选边必填、decider 自动取剩余地图、标准 Manifest validation、standalone 与 bound-overlay 权限、缓存恢复后的字段锁定、LKG provenance 保存、失败刷新与本地保存期间 pending candidate 保留、有效 candidate 原子替换、partial BP 的 explicit/legacy SIDE 恢复、保存失败保持旧 binding，以及服务重启后 cache 恢复但 session hidden。浏览器还检查 320/390px 横向溢出、键盘焦点和 reduced-motion；1.0.0 前不维护截图/pixel baseline。OBS 真实场景装载仍属于真实环境验收。
