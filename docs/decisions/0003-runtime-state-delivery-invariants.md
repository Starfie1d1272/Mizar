# ADR-0003：Runtime State、Identity 与 Delivery Invariants

- 状态：**Accepted**
- 日期：2026-09-12
- 关联：ADR-0001、ADR-0002、`docs/product.md`、`docs/architecture.md`、RivalHub #610 / #615
- Supersedes：ADR-0002「决策 5」中统一 `EventJournal` / 泛化 `Event` 的旧表述，以及「决策 6」中“`packages/protocol` 是跨仓 integration contract owner”的过宽表述；ADR-0002 其余技术基线继续有效。

> 2026-09-12 clarification：本次仅消除 ADR-0002/0003 之间的术语冲突，并明确 ReliableObservation 的派生方式；不改变本 ADR 已接受的 runtime architecture 决策。

> 2026-09-17 clarification：Issue #46 将 `ActiveLineupResolution` 与 map-scoped player stats 落为 Core Foundation seam。Raw `allplayers` 仍属于 telemetry observation；Core 维护一份 map-scoped stable membership/side assignment 与 accumulator，ProgramProjection 只消费由 Coordinator 解析并绑定到当前 source generation 的 resolved cohort。只有 `allplayers = present` 且唯一 Steam64 的无歧义 5+5 才能建立或替换 baseline；`absent` / `degraded` 只允许保留既有 membership，不能把旧 generation 的 volatile telemetry 当作当前值。Accumulator 由 phase transition、continuity、map epoch 与 evidence completeness 驱动，`map.round` 只作 sanity hint；当前回合 evidence gap 使该回合 fail closed，而同一 accumulator 提供 `liveAdr` 与 `completedAdr` 两个 read view。该 clarification 不新增第二份 `RuntimeState`，也不改变 ADR-0003 关于 projection ownership、map epoch 和 latest-wins 的决定。

> 2026-09-18 clarification：Issue #48 将 `SeriesProgress` 落为 Core-owned 的纯规则模型，由 Companion 当前唯一的 runtime composition owner 持有；它消费 `RuntimeTransition`、`MatchContext` 和同一 `sourceGeneration + mapEpoch` 下已证明的 side mapping，不复制 `RuntimeState`、`IdentityResolver`、`ActiveLineupResolution` 或 side-mapping ownership。地图计划不匹配时 Series fail closed 为 `needs_operator`，Program 仍可显示原始 telemetry。系列赛恢复只使用兼容的有界原子 JSON checkpoint，不建立 event-sourcing；Round History 由 `round_ended` 为 primary truth，`map_round_wins` 只作保守恢复、未知 `winCondition` 补充和冲突校验，不能覆盖已冻结的 `winnerSide`。兼容 checkpoint 加载后还必须校验当前 execution 的 `roundNumber`、score 与 `round_wins`；矛盾时保留 primary history 并标记 `partial/diagnostic`。Operator projection 暴露绑定与诊断；正常 Operator ingress 不建立 credential，显式 map bind command 只允许 loopback + valid local Origin，LAN mode 拒绝 mutation；GSI token 与 qualification-only token 保持独立。Companion shutdown await checkpoint flush。该 clarification 不改变现有 single-runtime、Program/Assist isolation 与 latest-wins 决定。

> 2026-09-21 clarification：Issue #56 的 HUD presentation control-plane 继续属于 Runtime 之外的 presentation owner。custom activation snapshot 是最后一次 Activate 生成的独立版本化 on-air 内容，加载时做自身 semantic safety validation，不通过当前 Theme recipe 重算来判断兼容；built-in reference 才随代码版本解析。framework-neutral widget descriptor 负责完整 settings envelope 与 variant 校验，Web React renderer registry 负责具体 renderer，未实现 widget 不得以 placeholder 泄漏到 Program。Program 与 Current Live preview 共用 stable cursor identity + fail-closed presentation boundary；producer/session/source-generation/map-epoch 变化或 accepted↔fail-closed 才 remount，不把一次性 reset flags 叠加为第二次 remount。该 clarification 不新增 RuntimeState、gameplay truth 或 normal Operator credential。

> 2026-09-22 clarification：objective progress denominator 由既有 Core objectiveTiming owner 在同一 source generation/mapEpoch 的连续安装边沿捕获；这是 witnessed presentation denominator，不是服务器配置。断流和重置清除其证明，Renderer 只对当前投影的 progress width 做短 transition，不缓存或递减 gameplay clocks。Program schema 不变。

## 背景

ADR-0002 已冻结 Runtime / Workspace 技术栈，但在正式实现 Core 前，还需要把实时系统最容易走偏的语义边界固定下来：

- 单一 `BroadcastState` 不能同时成为 domain state、WebSocket payload、Radar frame、公开网站 snapshot；
- “Event” 不能成为 round transition、operator command、RivalHub uplink、diagnostic incident 的万能桶；
- reconnect、restart、wrong match、map restart 必须有明确的 session / epoch / sequence 语义；
- latest-wins 必须落实为真实 backpressure 行为，而不是只写在文档里；
- 离线期间不能自动执行危险 canonical command，但可靠 observation 也不能因为短暂断网永久丢失；
- RivalHub 与 Broadcast 必须通过公开 versioned contract 集成，但各自拥有不同的 contract surface。

本 ADR 固定这些 **runtime invariants**。具体 schema 字段、HTTP path、WebSocket message name、持久化实现仍由后续实现/ADR 决定。

---

## 1. Core 只有一份 RuntimeState；state projection 与 edge-derived message 分离

Broadcast Core 维护一份内部事实模型：

```text
Normalized Telemetry
+ RivalHub Context
+ Accumulators
+ Identity / Session
+ Presentation Control
        ↓
    RuntimeState
```

`RuntimeState` **不是 wire DTO**，不得直接整份广播给所有 consumer。

当前状态类 consumer 通过纯 projector / selector 得到自己的模型：

```text
RuntimeState
├─ ProgramModel
├─ RadarFrame
├─ OperatorModel
├─ DebugModel
└─ BroadcastLiveSnapshot
```

可靠边沿消息不是“当前状态快照”的另一种名字。它通常由 transition 与 transition 当时的 context 派生：

```text
RuntimeTransition
+ RuntimeState / context at transition
        ↓
ReliableObservation candidate
        ↓
validation / idempotency / outbox
```

规则：

- Program/Radar/Operator/Debug/BroadcastLiveSnapshot projection 可由当前 RuntimeState 与明确 transient input 重建；
- `ReliableObservation` 必须保留触发它的 transition 与当时必要 evidence/context，不能事后只从新的 current RuntimeState 逆推出已经发生的 edge semantics；
- projection 与 observation 都不反向成为第二份 domain truth；
- Radar 高频变化不能迫使 BP、branding、diagnostics 等无关字段一起传输；
- renderer 不消费 Raw GSI，也不读取 RivalHub API；
- cloud snapshot 不等于本地 Program model。

---

## 2. Snapshot 与可靠消息继续分 lane，但“Event”必须细分语义

### Snapshot

适用于 position、HP、money、clock、bomb position 等可被更新状态覆盖的数据：

```text
latest-wins
bounded
droppable
```

旧 snapshot 没有“补播价值”。

### RuntimeTransition

表示本地 runtime 观察到的边界变化，例如：

```text
round_started
round_ended
map_started
map_ended
bomb_planted
side_changed
map_restart_detected
```

主要服务 accumulator、scene suggestion、diagnostics。要求 epoch-scoped、可去重；不自动等于 RivalHub canonical mutation。

### OperatorCommand

表示人对 presentation/runtime 的显式操作，例如：

```text
scene override
BP playback play/hide（具体控制面见 ADR-0009）
manual presentation reset
```

必须有 command/request identity 与 ack/error；OperatorCommand 不是 telemetry event。

### ReliableObservation

表示 Broadcast 准备提交给 RivalHub #610 的低频、高价值观察，例如：

```text
match_started observation
map_ended observation
series_ended observation
identity / continuity warning
result candidate
```

ReliableObservation 通常由 `RuntimeTransition + transition-time RuntimeState/context` 派生，而不是把某一时刻的 current RuntimeState 直接序列化后重命名。必须具备足够的 session / epoch / sequence / observedAt / identity / quality/evidence 上下文，并满足 retry/idempotency 要求。

### Incident

表示本地系统异常或降级状态，例如：

```text
wrong_match
stale_manifest
telemetry_stale
sequence_gap
uplink_unavailable
renderer_slow_consumer
```

Incident 用于 Operator / Debug / logging / health；不能因为“也是事件”就自动进入可靠业务 uplink。

**禁止建设一个无差别、永久保存所有东西的万能 EventJournal / event-sourcing 模型。** 需要持久化的 lane 必须有明确 consumer 与 retention 目的。

---

## 3. Session / Instance / Map execution 必须分层

至少区分：

```text
liveSessionId
  RivalHub Match ↔ 一个被服务端认可的 Broadcast producer session 绑定

producerInstanceId
  一次 Companion process/runtime 实例；进程重启后改变

mapEpoch
  当前一张地图的一次实际 execution；正式 map restart / restore 导致旧 observation 不能继续污染新 execution 时改变

seq
  在明确 scope 内单调递增，用于 stale / duplicate / reorder 检测
```

不要用一个模糊的 `epoch++` 同时代表进程重启、网络 reconnect、地图 restart、切换 Match。

具体是否还需要额外 `runtimeEpoch`，只有在实现证明上述层级仍不足时再增加。

---

## 4. Identity 是状态机，不是 boolean

推荐最小状态：

```text
unbound
→ resolving
→ matched
→ degraded
→ mismatch
```

语义：

- `unbound`：尚未绑定 RivalHub Match；
- `resolving`：已有目标 Match，但 telemetry identity 尚未完成验证；
- `matched`：队伍 / roster / map / session 等关键 invariant 满足；
- `degraded`：可继续部分本地 presentation，但存在缺失/低置信映射；
- `mismatch`：明确 Wrong Match / stale session / 冲突 identity。

Capability 由 identity + telemetry + connection health 派生，而不是由 UI 猜测。例如：

```text
presentation.branding
uplink.liveSnapshot
uplink.reliableObservation
resultCandidate.autoEligible
radar.utility
```

`mismatch` 时必须 fail closed：关闭 RivalHub uplink 与错误品牌；Program 可降级为中性 CT/T presentation，而不是自信展示错误队伍。

---

## 5. Duration 使用 monotonic clock；跨机器事实使用 wall clock

本地 duration / timeout / staleness / interpolation 使用单调时钟：

```text
performance.now()
process.hrtime.bigint()
```

不得用 wall-clock delta 作为本地 timeout 的唯一依据，因为 NTP、系统时间调整、休眠恢复会产生跳变。

跨机器 protocol / audit 使用 UTC wall-clock timestamp，例如：

```text
observedAt
producedAt
receivedAt
loggedAt
```

因此：

```text
monotonic clock → “过了多久”
wall clock      → “什么时候发生”
```

---

## 6. Latest-wins 必须是可测试的 backpressure contract

每个 snapshot consumer 都必须有**常数级有界 pending state**，不能形成旧 snapshot FIFO。

目标行为：

```text
sending snapshot 101
102 arrives → pendingLatest = 102
103 arrives → pendingLatest = 103
101 sent    → send 103
```

而不是：

```text
101 → 102 → 103 → ...
```

实现可以参考 transport 的 `bufferedAmount` / drain signal / explicit single-flight state，但语义必须保持：

- 每个 consumer 最多保留“正在发送 + 最新待发”；
- 慢 consumer 不阻塞其他 consumer；
- queue/memory 不随运行时长增长；
- slow-consumer 行为必须进入 replay/soak test。

### Browser reconnect

Program / Operator / Debug reconnect 时：

```text
hello / protocol negotiation
→ current session / epoch
→ current baseline projection
→ continue live updates
```

不重放断线期间所有历史 snapshot。

---

## 7. 离线 replay：Canonical command 与 ReliableObservation 必须区别对待

### Canonical / high-impact command

离线时不得静默排队并在恢复网络后自动执行，例如未来可能存在的 adjudication / recovery 类操作。

### ReliableObservation

短暂断网不能让 `map_ended` 等可靠 observation 永久丢失。

允许使用**有界、持久的 observation outbox**，但重连后发送前必须重新验证：

```text
liveSessionId
mapEpoch
manifest revision / relevant canonical context
identity state
credential scope
```

只有 observation 仍然属于当前可信 session/context 时才允许 retry。它提交的是“我观察到了什么”，不是离线替 RivalHub 执行 canonical mutation。

Outbox 必须有：

- bounded retention；
- idempotency key；
- retry/backoff；
- accepted / rejected / superseded 状态；
- stale session/epoch 自动失效；
- Operator/Debug 可见性。

---

## 8. Scene 分为 BaseScene 与 OverlayCue

基础节目状态：

```text
BaseScene
Waiting
Matchup
VetoPlayback
Gameplay
Halftime
MapResult
InterMap
MatchResult
Break
Emergency
```

临时反馈不继续膨胀 scene enum，而使用：

```text
OverlayCue
Clutch
Ace
MultiKill
DamageFeedback
BombUrgency
Timeout
TechnicalWarning
...
```

`TechnicalPause` 可以根据实际节目设计实现为 Gameplay 上的 overlay，也可以是独立完整画面；本 ADR 不提前强制其唯一 presentation。

Scene policy 继续维护：

```text
suggestedScene
activeScene
mode = auto | manual
```

`suggestedScene` 应由稳定后的 RuntimeTransition / state policy 推导，不应直接因为一次 partial GSI payload 瞬时跳场景。

---

## 9. Radar domain 与 Radar renderer 分离

`packages/radar` 应拥有 framework-neutral 的：

```text
RadarFrame / projection
world → radar transform
MapGeometryProvider contract
floor selection
marker / utility semantics
interpolation math
autozoom math
```

Web presentation 层拥有：

```text
React / SVG / Canvas / DOM renderer
CSS/theme
requestAnimationFrame scheduling
OBS/browser-specific rendering details
```

地图几何通过 `MapGeometryProvider` 进入 Radar；当前默认 provider 使用 Broadcast 自己持有的、显式版本化的 CS2 overview calibration snapshot。DAK `@cs2dak/maps` 仅作为独立交叉参考，不是 Broadcast 的 build/runtime owner；Radar 不直接把 DAK package shape 作为自己的 domain contract。

Boltobserv / Obserview 等用于算法与产品 UX 参考，不作为第二套 GSI runtime/sidecar。

---

## 10. 跨仓 contract ownership

### Broadcast-owned local contract

Broadcast 自己拥有：

```text
Companion ↔ Program
Companion ↔ Operator
Companion ↔ Debug
```

这些 versioned local DTO / schema 可以放在 `packages/protocol`。

### RivalHub-facing API contract

RivalHub 主仓拥有它公开的 API boundary 与长期服务端语义：

```text
BroadcastManifest API
#610 Reliable Observation ingest
#615 Live Snapshot ingest
```

Broadcast 的 `packages/rivalhub` 作为 consumer/producer adapter：

- 使用公开 machine-readable schema / documented contract；
- 可以生成或维护本地 validator/client；
- 使用 compatibility fixture 做跨仓验证；
- 不 import RivalHub 源码类型；
- 不直连 RivalHub / Supabase 内部表。

这不是“HTTP receiver 天然拥有一切”的普遍规则，而是本系统中 RivalHub 作为公开 API/provider 与 canonical authority 的具体边界。

术语固定为：

```text
BroadcastLiveSnapshot
  Broadcast → RivalHub #615 的 producer payload

EphemeralLiveProjection
  RivalHub #615 服务端维护的当前实时投影

PublicLiveMatchProjection
  RivalHub 公共页面消费的公开 read model
```

不要在 Broadcast 侧把 producer payload 也称为 `LiveProjection`。

---

## 11. Local security baseline

在只做 localhost M0/M1 时保持最小 surface；一旦进入 pairing、LAN 或 RivalHub uplink，必须满足：

```text
default bind = 127.0.0.1
LAN mode = explicit opt-in

GSI token
!= qualification-only token
!= RivalHub producer credential

normal local mutation = loopback bind + valid local Origin
LAN mutation = denied
```

并要求：

- local mutation endpoint 只校验 valid local Origin、loopback bind 与 request schema；LAN mode 拒绝 mutation；
- WebSocket 校验 Origin 与 protocol version；
- RivalHub credential scope 到 producer/season/match，不使用 service-role；
- credential 不写入普通 logs / fixtures；
- Debug/fixture 导出需处理 token 与不必要的个人数据；
- 不能为了第二台电脑访问 Operator 就默认把服务无保护暴露到 `0.0.0.0`。

当前不提供普通 Operator credential；未来 pairing/credential storage 仍需单独 ADR。

---

## 12. 实施 Gate

完整产品 scope 不缩减，但按可验证 vertical slice 推进：

```text
M0 Runtime proof
GSI → production normalizer → /debug
raw recorder / replay
session / clock / transition 基础

M1 Production kernel
RivalHub manifest
identity / wrong-match
basic Gameplay + player/bomb Radar
reconnect / backpressure
2h soak

M2 Broadcast workflow
utility（grenade/smoke/inferno）
provisional stats
Waiting / Matchup / BP / Halftime / MapResult / InterMap / MatchResult

M3 RivalHub uplink
#610 ReliableObservation
#615 BroadcastLiveSnapshot
pairing / auth / outbox / security hardening

M4 Enhanced telemetry
exact damage source
BombDamageProvider
advanced observer advisory / effects / optional adapters
```

“不做一次性 MVP”不等于所有能力必须同时实现。每一 Gate 都必须用真实生产链路产生可验证证据。

---

## 后果

### 正面

- Core 不会演化成一个通过 WebSocket 到处发送的 God Object；
- 高频 Radar/position 不拖累低频 UI；
- transition-derived ReliableObservation 保留边沿事实与当时 evidence，不依赖事后从 current state 猜历史；
- reliable observation 可以安全重试，同时不把离线 command 变成危险自动执行；
- Wrong Match、restart、reconnect、slow consumer 的行为可测试；
- #610 / #615 与 Broadcast 的 authority/terminology 清晰；
- Radar、renderer、scene effect 可以独立演进。

### 代价

- 需要显式 projector、transition-derived observation builder、identity/session model 与 outbox；
- 测试必须覆盖更多故障语义，而不只是 happy path；
- local protocol 与 RivalHub-facing contract 不再混成一个 `packages/protocol`。

这些复杂度是为了避免直播系统最难排查的长期延迟、错场写入、离线错误重放和跨仓耦合。
