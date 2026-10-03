# Architecture Decision Records

- [0017：自动节目编排与有界场景展示](0017-program-direction-and-presentation.md)：默认自动、手动保持、节目时序、静态场景连续性与默认视觉边界。

ADR 用于记录会长期约束仓库的技术/产品架构决策，避免重要选择只存在于 Issue、聊天或某次实现里。

## 状态

- `Proposed`：已提出，尚未冻结；
- `Accepted`：当前正式决策；
- `Superseded`：已被后续 ADR 替代；
- `Rejected`：明确评估后不采用。

## 规则

1. 一个 ADR 聚焦一组具有共同决策原因、可以独立演进/被 supersede 的决定；不要求“一项依赖一个 ADR”。
2. 记录“为什么”，不只记录最后选择。
3. 如果新事实改变旧决定，不静默改写历史语义；新建 ADR，并明确 supersede 的具体旧决定/范围。
4. 对已接受 ADR 的非语义性勘误或“让正文与已接受决策保持一致”的澄清，应显式标注 clarification；如果实际决策发生改变，仍必须新建 ADR supersede。
5. 第三方项目只是证据，不自动成为设计规范。
6. 重要实现如果没有对应的产品需求或 ADR，不应由 Agent 自行扩张范围。
7. 精确 dependency version 由 `package.json` / lockfile 记录；同一既定技术路线内的兼容 patch/minor 升级通常不需要新 ADR，除非改变架构语义或生产兼容边界。

## 当前 ADR

- [`0001-project-positioning-and-authority.md`](0001-project-positioning-and-authority.md)：项目定位与权威边界。
- [`0002-runtime-workspace-technology-baseline.md`](0002-runtime-workspace-technology-baseline.md)：Runtime、TypeScript/ESM、pnpm workspace、Web/server 构建与测试技术基线。
- [`0003-runtime-state-delivery-invariants.md`](0003-runtime-state-delivery-invariants.md)：RuntimeState/projection、transition-derived ReliableObservation、session/identity、delivery/backpressure、observation outbox、Radar/scene 与跨仓 contract invariant；其中 EventJournal/泛化 Event 语义 supersede ADR-0002 决策 5 的对应旧表述，跨仓 contract ownership supersede ADR-0002 决策 6 的过宽表述。
- [`0004-program-output-and-observer-assist-isolation.md`](0004-program-output-and-observer-assist-isolation.md)：Delayed Program timeline、machine-only Lookahead、Observer Assist Overlay、Program/Assist non-leak 与双 source continuity 边界。
- [`0005-product-capability-boundaries-and-portability.md`](0005-product-capability-boundaries-and-portability.md)：三条产品能力线、Shared Runtime Foundation、RivalHub 第一方集成语义，以及 Core / Radar / Lookahead 不被第一方实现反向锁定的可移植性边界。
- [`0006-local-independent-and-rivalhub-connected-modes.md`](0006-local-independent-and-rivalhub-connected-modes.md)：独立模式与 RivalHub 连接模式的产品边界；将校园赛、社区赛等明确为适用场景而非第三种运行模式，并冻结“RivalHub 是第一方集成但不是运行前置条件”的产品方向。
- [`0007-gameplay-hud-presentation-invariants.md`](0007-gameplay-hud-presentation-invariants.md)：Gameplay HUD 长期 presentation invariant 与已验证反模式；冻结 entrant 物理位置、稳定几何、单一 Radar 坐标 owner、局部 urgency 与真实 fixture provenance，但不冻结具体美术语言。

## Clarification

### 2026-09-17：ADR-0003 Radar ownership 用词

ADR-0003 第 9 节中的 `interpolation math / autozoom math` 是早期 broad wording。按 #30 之后已经冻结的 Radar Domain / Renderer 边界，应解释为：

- `packages/radar` 可以拥有 framework-neutral、deterministic、stateless 的 geometry / transform / floor / marker / utility 以及必要纯数学；
- temporal interpolation / smoothing、teleport/discontinuity reset、autozoom/crop 的 presentation state 与 animation scheduling 属于 Web Radar Renderer；
- React / SVG / Canvas / DOM / `requestAnimationFrame` 继续不进入 `packages/radar`。

这是一条 ownership clarification，不改变 ADR-0003 的核心决定：Radar domain 与 Renderer 分离，Renderer 不成为第二份 domain truth。

- [`0008-portable-web-product-runtime.md`](0008-portable-web-product-runtime.md)：#35 Web-first 便携产品、不可变 payload / 可写 state、launcher 与 Companion ownership。

- [`0009-bp-presentation-host.md`](0009-bp-presentation-host.md)：BP 全屏 Host、本地 authoring、有限投影、播放会话与来源恢复边界。
- [`0010-broadcast-workspace-desktop-host.md`](0010-broadcast-workspace-desktop-host.md)：#84 Tauri Desktop Host、固定工作区几何、单一 Program Scene registry、Companion OBS ownership 与便携入口迁移。
- [`0011-owned-input-and-structured-output.md`](0011-owned-input-and-structured-output.md)：#95 Mizar-owned 比赛输入与 #89 结构化实时输出的 authority、安全和恢复边界。

- [`0012-design-system-governance.md`](0012-design-system-governance.md)：设计系统文档、设计变量与组件职责、三类界面与分层验证。

- [`0013-hud-widget-customization.md`](0013-hud-widget-customization.md)：受控组件配置、通用 Inspector、四层 ownership 与 1.0 前的版本边界。
- [`0014-desktop-preparation-center.md`](0014-desktop-preparation-center.md)：#94 默认准备中心、ActiveLineup 首发捕获、桌面生命周期与本机 host policy。
- [`0015-desktop-startup-diagnostics-and-recovery.md`](0015-desktop-startup-diagnostics-and-recovery.md)：桌面冷启动的有界诊断、Main/现场窗口创建边界、进程归属与恢复、正常 GUI 自动化验证。
- [`0016-bounded-support-export.md`](0016-bounded-support-export.md)：正常产品诊断导出、日志与健康摘要白名单、内容/大小/访问边界。

- [`0018-shared-radar-view.md`](0018-shared-radar-view.md)：共享雷达展示输入、双端适配与独立 npm/资源产物。
