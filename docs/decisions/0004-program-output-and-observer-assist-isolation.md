# ADR-0004：Program 输出与 Observer Assist 隔离

- 状态：**Accepted**
- 日期：2026-09-14
- 关联：ADR-0001、ADR-0003、`docs/product.md`、`docs/architecture.md`、RivalHub #610 / #613 / #615、RFC-0001

## 背景

当前 RivalHub Major 的真实制播工作流是**单机、单人解说兼 OB**：同一个人在一台 Windows 机器上连接延迟 GOTV、解说、手动切换观察视角，并通过 OBS 输出正式节目。

Perfect World 当前实际提供同一场比赛的两条成对 GOTV：

```text
No-delay GOTV
  例如 endpoint ...5
  不给人直接观看
  不进入 OBS
  只供机器 headless 解析 future event / timeline alignment

Delayed Program GOTV
  例如 endpoint ...6
  约 120 秒 spectator delay
  CS2 observer 实际连接
  Program HUD / Radar 跟随该时间轴
  OBS 捕获正式节目
```

此前讨论曾把这个场景抽象成 `Caster` 与 `Operator` 两类现场用户，以及两个可相互降级的 telemetry source。该抽象不符合当前真实运营方式，也制造了并不存在的 Program failover 问题。

本 ADR 重新冻结最小、真实的业务边界。

---

## 决策 1：现场只有一个制作角色，不建立独立 Caster role

当前产品的主要现场用户是：

> **解说兼 OB / 制作人员。**

同一个人：

- 看 CS2 延迟节目画面；
- 看与正式 Program 同一 `ProgramProjection` 驱动的本机 Program HUD / Radar Overlay；
- 解说；
- 手动切 POV；
- 需要时打开 Operator 配置/诊断；
- 可以看到独立的本机 Observer Assist Overlay。

因此本仓**不要求**存在独立 `/caster` surface，也不建立 `CasterProjection` 作为长期业务角色模型。

`/operator` 是控制/诊断界面，不意味着现场存在另一位“导播用户”。

---

## 决策 2：Program feed 与 Lookahead feed 不是两个对等 Program source

二者的资格不同：

```text
Delayed Program feed
  → CS2 renderer
  → Runtime 的正式节目时间轴
  → ProgramProjection
  → Program renderer
       ├─ 本机透明 Program Overlay（制作人员可见）
       └─ 官方 OBS Program host（Browser Source 为基线实现）
  → #615 BroadcastLiveSnapshot

No-delay Lookahead feed
  → machine-only parser
  → future-event evidence / timeline alignment
  → Observer Assist
  × 不渲染为 Program
  × 不进入 OBS
  × 不进入 #615
  × 不具备 Program fallback eligibility
```

因此不设计：

```text
Program down
→ 自动/手工把 Lookahead feed 切成 Program
```

如果 Program feed 故障，就是节目输入故障；如果 Lookahead feed 故障，Program 正常继续，只关闭/降级 Assist。

完美平台的 `...5 / ...6` 与约 120 秒延迟属于当前部署和地址派生规则，不能硬编码进 Core。启用 Assist 前仍要校验同一比赛、同一地图执行和可信的时间轴关系。

### 澄清（2026-09-27）：Program 时间轴、Program 遥测与精确事件增强分责

当前真实完美平台输入进一步确认：解说拿到的是直连 GOTV `connect IP:port;password ...`。该地址不能被视为 `cs2parser HttpBroadcastReader` 可直接消费的 HTTP Broadcast URL。

因此，本 ADR 中的“延迟 Program 数据流（Delayed Program feed）” 不等于“必须再用无头解析器读取一遍延迟 CSTV”。当前 V1 主数据链路是：

```text
延迟直连 GOTV
→ 真实 CS2 观战客户端
→ GSI
→ Program-safe Runtime
→ ProgramProjection / RadarFrame
```

精确 GameEvent 是独立增强：

```text
可选 Program 事件数据源
→ GameEventObservation<'program'>
→ ProgramCue
```

精确事件数据源不可用时，Program / Radar 仍保持正常；依赖精确事件元数据的 HE / Zeus / 狙击枪武器类型专属命中特效，保守降级为已有的 GSI 通用受伤反馈。

这一澄清不改变 Program / Assist 硬隔离、Lookahead 不能作为 Program 备用数据源或“一份 `RuntimeState`”的决定。详细运行方案与能力矩阵见 `docs/data-source-capabilities.md`。

Lookahead 所需的无头直连 CSTV 客户端后续**新建独立仓库**研发和维护；本仓不实现直连 CSTV 网络协议本身，只保留其接入后的标准事件、时间轴对齐和 Observer Assist 语义。

---

## 决策 3：Observer Assist 是本地私有显示层，不是第二套节目

Observer Assist 的目标是帮助同一个解说兼 OB 提前切镜。

第一阶段的最小完整产品：

```text
No-delay GOTV
→ 观察到 player_death
→ attacker / victim / event tick / 可可靠获得的位置上下文

Delayed Program GOTV
→ 当前 program tick

Timeline alignment
→ 计算该 kill 距离 Program 还有多久

约 T-10s
→ 本地透明 / click-through Assist Overlay
→ countdown + killer → victim + optional location

人
→ 自己决定切 POV
```

第一阶段**不要求**：

- 佯攻/主攻识别；
- engagement/story 聚类；
- 复杂 importance ranking；
- AI / physics prediction；
- 自动 TAKE / 自动切镜；
- 第二个 CS2 renderer。

RFC-0001 可以继续研究更丰富的 cue aggregation、推荐 POV、local relay 等能力，但这些不是基础 Assist 的上线前提。

---

## 决策 4：Program / Assist 在数据和捕获边界上硬隔离

Core 仍只有一份内部 `RuntimeState`。Assist 不成为第二份 domain truth，但“一份 RuntimeState”也不能意味着把所有数据混在同一个无边界对象里。

Runtime 内至少需要结构化区分：

```text
RuntimeState
├─ official / match context
├─ program-safe runtime slice
│  ├─ normalized Program telemetry
│  ├─ accumulators / identity / session
│  └─ Program presentation control
├─ assist-private runtime slice
│  ├─ bounded Lookahead evidence
│  ├─ timeline alignment health
│  └─ current/scheduled Assist cue
└─ operational health / incidents
```

至少区分 consumer projection：

```text
ProgramProjection
  正式节目允许显示的信息
  只从 program-safe input 构造

ObserverAssistProjection
  只包含本机 Assist 所需的未来事件提示
  可以同时消费 program-safe timing/context 与 assist-private input
  不作为 Program 的超集

OperatorProjection
  match / health / scene / incident / recovery / OBS / uplink

DebugProjection
  raw / normalized diagnostics / timing / evidence
```

安全原则是 **safety by construction**：Program projector / #615 producer 不应拿到一个必须靠“记得别读某字段”才能安全使用的万能 state view。实现可通过 typed selector / narrowed input / schema boundary 等方式做到；具体 TypeScript symbol 不由本 ADR 锁死。

规则：

- Lookahead future information 不得进入 `ProgramProjection`；
- Assist-only 字段不得先发给 Program 再靠 CSS 隐藏；
- 官方 OBS Program preset 不得包含 Assist surface/window；
- #615 只从 Delayed Program timeline 生成 public live snapshot；
- Assist 以透明置顶窗口实现时，必须在真实 Windows + OBS 验收中证明不会被官方 capture 路径误录。

### Clarification（2026-09-15）：Projection、Renderer 与 Host 分层

这一澄清不改变上述 Program/Assist 安全决策，只把此前隐含的 presentation boundary 写清楚：

```text
Projection
  决定该 consumer 被允许看到什么数据
        ↓
Renderer
  决定如何把该 projection 画成 HUD / Radar / scene / cue
        ↓
Host
  决定 renderer 运行在哪里以及如何被人或 OBS 消费
```

因此：

```text
ProgramProjection
  → Program renderer
      ├─ browser/dev host
      ├─ OBS Browser Source host
      └─ local transparent/topmost/click-through Program Overlay host

ObserverAssistProjection
  → Assist renderer
      ├─ browser/debug prototype（可选）
      └─ local transparent/topmost/click-through Assist Overlay host
```

约束：

- 同一 Program renderer 可以同时运行多个 instance，分别给制作人员和 OBS 使用；这些 instance 不拥有第二份 RuntimeState，也不重新解释 Program truth；
- Program Overlay 与 Assist Overlay 必须是独立 surface/window，不能把 future cue 与 Program HUD 混在一个窗口后再依赖 OBS crop/visibility 隐藏；
- Program/Assist 的安全性由 projection/schema 保证，OBS 捕获哪个 host 只是第二道部署级防线；
- OBS Browser Source 是当前首个、明确验收的 Program host，但不是 `ProgramProjection` 的唯一合法承载方式；
- 直接捕获独立 Program Overlay、桌面 WebView 或其它 host 只有在完成真实 Windows + OBS 验收后才能成为正式 deployment path；
- 本 ADR 不冻结 Electron、Tauri、WebView2 或其它桌面宿主技术，完整 packaging 继续由后续 ADR/Issue 决定。

---

## 决策 5：Lookahead feed 不自动扩张为 #610 canonical source

#610 Match lifecycle 不依赖 Broadcast/GSI；Broadcast 仍是可选 observation source。

当前 no-delay feed 的明确业务 owner 是 **Observer Assist**。

虽然未来技术上可以让更早的可信 evidence 参与 `match_started / map_ended` 等 ReliableObservation，但本 ADR 不因为“数据已经存在”自动赋予该 feed canonical responsibility。

若未来需要，应在 RivalHub-facing contract 中单独决定：

- 哪些 observation 可以来自 lookahead feed；
- identity / session / health 要求；
- 是否影响自动 canonicalization eligibility。

这避免把一个简单的切镜辅助功能变成 Match Runtime 的隐式依赖。

---

## 决策 6：#610 / identity 的既有边界继续成立

Broadcast 必须自动比较：

```text
canonical MatchRoster / Steam64
↕
observed players
```

正常一致时无感通过；mismatch / wrong-match / stale 等异常才进入人工处理。

`MatchPreparation` 与 `ObservationHealth` 不压成一个 `canStart` boolean。现实比赛已经可信开始时，准备事项或 roster incident 不能否认已经发生的事实；但有身份冲突的 result candidate 不应自动 canonicalize。

---

## 决策 7：Program 与 Lookahead 各自拥有 source-local continuity

Program GSI、可选 Program 事件数据源和 Lookahead 接入是彼此独立的数据入口，它们可能分别重连、重启或发生延迟。不能把一个全局 `seq`、Companion `producerInstanceId` 或 Match `mapEpoch` 当成两个数据源的连接连续性。

每个 telemetry source 至少要能在 adapter/alignment 层表达等价概念：

```text
sourceRole
  program | lookahead

sourceInstance / sourceGeneration
  当前 source consumer/parser 连接世代

source-local seq / tick / observedAt
  仅在明确 scope 内解释

sourceHealth
  connecting / healthy / stale / disconnected / mismatch 等
```

其中：

- `liveSessionId` 仍表示 RivalHub Match ↔ Broadcast producer session；
- `producerInstanceId` 仍表示 Companion runtime 实例；
- `mapEpoch` 仍表示一次比赛地图 execution；
- **Lookahead parser reconnect 不应因为只是连接重建就推进 Program `mapEpoch`**；
- source reconnect / generation change 必须使现有 timeline alignment 失效，重新证明 same match / map / tick relation 后才能恢复 cue；
- Runtime / uplink 的 `seq` 与 ingress source-local sequence 不得混为一个含义模糊的编号。

这让比赛事实连续性、进程连续性、地图 execution 连续性与各 telemetry source 的连接连续性保持分责。

---

## 验证要求

自动验证至少覆盖：

- `ObserverAssistProjection` 的 future fields 不出现在 `ProgramProjection`；
- Program projector / #615 producer 的输入边界不依赖过滤一个万能 future-aware payload 才安全；
- 同一 `ProgramProjection` 驱动不同 Program host 时不产生 host-specific domain truth；
- #615 producer 不读取 no-delay future state；
- Lookahead feed down 时 Program 不受影响；
- Program feed down 时不存在 Lookahead→Program fallback；
- wrong-match / map mismatch / alignment unhealthy 时 Assist fail closed；
- Lookahead source generation/reconnect 后旧 alignment 立即失效；
- timeline reconnect/map change 后重新建立 alignment 才恢复 cue。

真实生产验收分层进行。Program V1 / 制播工作区现场验收至少覆盖：

```text
Windows + CS2 延迟观战 + GSI + OBS
+ local Program Overlay
```

当 Observer Assist / Lookahead 能力进入可交付状态时，再增加：

```text
无延迟 Lookahead 数据源
独立私有 Assist 承载面
```

Lookahead 的专项验收不再阻塞 Program V1 / 制播工作区的生产验收。

并验证：

- 制作人员看到的 Program Overlay 与官方 OBS Program host 在相同 projection/scene 下语义一致；
- Program Overlay 的透明/topmost/click-through、DPI 与窗口模式满足实际制作；
- Assist overlay 不进入官方 OBS Program output；
- kill cue lead time 稳定可用；
- CPU / memory / network 不影响 CS2/OBS 稳定性；
- Lookahead 故障只降级 Assist。

---

## 结果

本 ADR 保留 ADR-0003 的核心结论：

- 一个 `RuntimeState`；
- consumer-specific projection；
- snapshot / transition / command / observation / incident 分离；
- latest-wins、identity、session/time/outbox invariant 继续成立。

新增冻结的是：

- 单人解说兼 OB 的真实角色模型；
- Delayed Program feed 与 machine-only Lookahead feed 的不对等职责；
- Observer Assist 作为本地私有 overlay；
- no Lookahead→Program fallback；
- future cue 与 Program/#615/OBS 的硬隔离；
- Runtime 内 Program-safe 与 Assist-private 数据结构化分区；
- Program / Lookahead source-local continuity 与 Match/producer/map continuity 分责。

2026-09-15 clarification 进一步明确：Program 与 Assist 的 projection 安全边界独立于具体 browser/desktop/OBS host；Program 可以有多个 host instance，而 Program Overlay 与 Assist Overlay 必须物理独立并继续保持 projection-level non-leak。