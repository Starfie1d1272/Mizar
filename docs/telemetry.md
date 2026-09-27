# Telemetry 数据语义

本文定义 CS2 GSI 与 CSTV 输入在 Mizar 中的职责归属、数据源语义、规范化和证据要求。它不描述某个实施阶段，只记录当前有效规则与仍有长期价值的真实数据源事实。

## 1. 数据流

### GSI

```text
CS2 Raw GSI
    ↓
Companion HTTP ingress
    ├─→ bounded Capture Recorder
    └─→ packages/telemetry-gsi
            ↓
      TelemetryObservation
            ↓
        packages/core
```

### CSTV

```text
CSTV / playcast
    ↓
packages/telemetry-cstv
  third-party parser binding
    ↓
      GameEventObservation (role-scoped)
    ↓
Core / 数据源管理 / ProgramCue 或 Lookahead 时间轴对齐
```

Raw GSI 和第三方解析器对象都必须在各自适配器边界内终止。

### 1.1 正式运行方案与接入边界

当前完美平台 V1 的 Program 主数据链路是：

```text
延迟直连 GOTV
→ 真实 CS2 观战客户端
→ GSI
→ TelemetryObservation
→ Runtime / ProgramProjection / RadarFrame
```

直连 GOTV 的 `connect IP:port;password ...` 与 HTTP Broadcast 是不同接入方式。只有直连地址时，不能假定存在可供 `HttpBroadcastReader` 使用的 HTTP URL。

因此：

- GSI 是当前完美平台 Program 状态的正式数据入口；
- Program role 的 GameEvent 数据源属于可选精确事件增强；
- `packages/telemetry-cstv` 的 HTTP reader 继续服务真正提供 HTTP Broadcast 的数据提供方，以及离线验证、现场验收参考和未来兼容；
- 精确事件增强未启用或不可用，不等于 Program 比赛数据不可用；
- 详细能力矩阵见 `docs/data-source-capabilities.md`。

## 2. GSI observation 不是 patch

每个通过认证的 GSI payload 首先被解释为**当前 source observation**。

禁止全局规则：

```text
field absent
→ retain previous value
```

也禁止把：

```text
deepMerge(previous, current)
```

当成“当前真实 GSI state”。

真实 CS2 payload 会让某些只在特定阶段存在的字段自然消失。如果一律保留旧值，会制造上一回合 `winner`、`bomb` 等 ghost state。

## 3. Block-specific semantics

当前 adapter 按 block 独立表达 coverage：

```text
present
absent
degraded
```

主要 block：

```text
map
round
phase_countdowns
player
allplayers
bomb
grenades
```

Absence 可能表示：

- 当前语义不存在；
- 当前 observer context 不提供该 capability；
- source 暂时没有提供该 block；
- source/context 正在转换。

因此 `absent` 不等于 `unchanged`。

对特定 block 如果需要跨帧 continuity，必须有明确真实 evidence、局部实现和可测试 diagnostic，不能扩张成通用 merge policy。

### 3.1 已验证的 source facts

仓库现有真实 capture 已经足以证明以下规则，后续实现不应重新退回 universal retain-on-omit：

- 一份完整 Demo observer capture 中，`allplayers` 出现的 150 个 frame 每帧均包含 10 名玩家；
- 一份 BOT spectator capture 中，`allplayers` 出现的 1936 个 frame 每帧均包含 10 名玩家；
- 这些已观测 frame 中，每个 player object 持续提供 `name / team / observer_slot / state / weapons / match_stats / position / forward`；
- `round` 在 warmup 场景可以整体不存在；
- root `bomb` 在已观测 BOT warmup 中不存在，正式回合开始后才持续出现；
- normal-player capture 中，`round.bomb` 与 `round.win_team` 会在对应语义结束后从 current payload 消失；
- `previously` / `added` 通常提供有价值的 change hint，但真实 capture 也存在 current state 已变化而 hint 不完整的 frame。

### 3.2 地图 canonicalization 与 `map_round_wins`

Core 与 Radar 共用 Mizar-owned 的显式 CS2 地图别名表，例如 `Mirage / mirage / de_mirage` 归一为 `de_mirage`，`Dust 2 / dust2 / Dust II / de_dust2` 归一为 `de_dust2`。只允许明确别名和空白/大小写规范化，不使用编辑距离或模糊猜测。

`map.round_wins` 在 `packages/telemetry-gsi` 中解析为 normalized `ObservedRoundWin[]`。已知 `ct_win_* / t_win_*` 原因映射为 `elimination`、`bomb`、`defuse`、`time`；未知原因保留 `winnerSide = unknown` 与 `winCondition = unknown`，并产生 adapter diagnostic。

它不是独立实时状态机：连续运行时由 `round_ended` transition 冻结 Round History，`map_round_wins` 只用于中途加入、重连/进程恢复和同一回合的安全校验/原因补充。只有能够证明 key 是当前地图的绝对连续回合号时才恢复缺失历史；加时可能重置局部 key 时标记 `partial`，不猜 OT offset。Core 对每张地图的历史保留显式上限，避免 source payload 或恢复路径造成无界增长。

这些事实只证明**已录制场景**中的 source behavior，不声明所有 CS2 版本和 observer context 永远保持完全相同。Adapter 仍需 tolerant，并在实际 shape 偏离已知 evidence 时输出 diagnostic，而不是崩溃或伪造缺失字段。

## 4. `previously` / `added`

Raw GSI 中的 `previously` 与 `added` 只作为 change hint 和 diagnostic evidence：

- parser compatibility 调查；
- current-vs-previous diff 交叉验证；
- corpus 分析；
- regression test。

它们不是 Mizar domain truth，也不能直接生成 `RuntimeTransition`。

## 5. TelemetryObservation

`TelemetryObservation` 是 Core-owned input contract，表达某一 source frame 经解释后的 current observation。

概念结构：

```text
TelemetryObservation
├─ receive
│  ├─ sequence
│  ├─ receivedAt
│  └─ receivedMonotonicMs
├─ source
├─ coverage
└─ telemetry
   ├─ map
   │  └─ roundWins（map_round_wins 的 normalized recovery evidence）
   ├─ round
   ├─ phaseCountdowns
   ├─ player
   ├─ allPlayers
   ├─ bomb
   └─ grenades
```

它不包含：

- canonical RivalHub identity；
- official lifecycle / result；
- scene state；
- operator override；
- accumulator output；
- Lookahead future cue。

GSI-specific diagnostics 与 `TelemetryObservation` 并列返回，不塞进 Core domain。

### 5.1 Objective Clock 与 overloaded bomb countdown

Raw GSI 的 root `bomb.countdown` 是 state-dependent observation，不是一个跨状态同义的永久
时钟：

| `bomb.state`                       | `bomb.countdown` 语义                                  |
| ---------------------------------- | ------------------------------------------------------ |
| `carried` / `dropped`              | 没有 objective action clock                            |
| `planting`                         | 当前 plant action remaining                            |
| `planted`                          | C4 explosion remaining                                 |
| `defusing`                         | 当前 defuse action remaining，不是 explosion remaining |
| `defused` / `exploded` / `unknown` | terminal 或不可用                                      |

`phase_countdowns` 只表达当前 phase clock。它可以与 bomb state 做同语义交叉验证，但不能
在 defusing 时被当作 explosion fallback。

Core 在 `RuntimeState.objectiveTiming` 内维护一个不进入 wire 的 anchor：

```text
{ remainingSecondsAtSample, sampledAtMonotonicMs,
  source: "bomb-planted-countdown" }
```

只有 `coverage.bomb = present`、当前 round 不是 `over` 且 `state = planted` 携带 finite
countdown 时才建立或重新校准 anchor。planted countdown 暂缺时保留既有 anchor；defusing
保留 anchor 且不使用 defuse countdown 覆盖它；没有 anchor 的首次 defusing 保持 explosion
为 `null`，不合成 40 秒。carried、dropped、planting、terminal、unknown、bomb absent 或
degraded、map epoch 变化和 Program source generation 变化都会清除/失效 objective timing。
同一 generation / map epoch 内一旦发生 `gap-resync` 或 `stale-recovery`，也不得跨断点继承旧
explosion anchor；恢复帧只有携带新的 authoritative planted countdown 才能重新建立它。

Core 同时记录 previous accepted bomb state 与 witnessed presentation denominator：连续 carried/dropped → planting 捕获 plant duration，连续 planting → planted 捕获 explosion duration。相同 planting action 保留分母，abort 清除；explosion 分母在 contiguous defusing/abort 中保留，后续 planted sample 只可向上校准。baseline、gap/stale recovery、generation/mapEpoch、terminal 不继承 duration；不得把分母称为 canonical mp_c4timer。

plant/defuse action 由当前 observation 即时派生。actor 缺失不清除 action time；defuse kit
只从当前 matching player 的 `hasDefuser` evidence 读取，未知就是 `null`，不做 heuristic。
所有 duration / interpolation / lease 使用 monotonic clock；UTC 只用于 capture、报告和审计。
短 objective-clock lease 的 canonical policy 在
`packages/core/src/runtime/objective-timing-policy.json`；当前默认值为 1000 ms、上限为
2000 ms。它独立于全局 `staleAfterMs = 20000`。
lease 过期时 Program 保留当前 bomb semantic state，但 numeric remaining fail closed 为
`null`。浏览器 reconnect 只重新取得 baseline，Core 才负责 anchor continuation。

Raw `bomb.countdown` 仍只存在于 telemetry adapter / capture 边界。它不能穿透为 Program
顶层 `bomb.countdownSeconds`，也不能由 React state retention 补回。

### 5.2 Active lineup 与 map-scoped player stats

`telemetry.allPlayers` 是当前 source observation，不是已经筛选好的正式节目名单。Core 在 identity 与 continuity 之后派生两个独立结果：

```text
allPlayers observation
  ├─ ActiveLineupResolution → Program Player Rails 的稳定 5+5 cohort
  └─ MapPlayerStatsAccumulator → map-scoped ADR
```

Active lineup 只在 `coverage.allPlayers = present`、10 个唯一稳定 Steam64、CT 5 人 + T 5 人且无歧义时建立或替换 baseline。observer、coach、spectator 和 transient extra 不进入 cohort；稳定 baseline 遇到单帧缺失、extra 或 `degraded` evidence 时保留原 logical participants，并以 `lineupEvidence: retained` 与 `degraded` 表达证据质量。没有 previous baseline 时，degraded 的 clean-looking 5+5 仍不得晋升。`coverage.allPlayers = absent` 不触发 lineup transition。Stable Steam64 membership 与 CT/T side assignment 分离，halftime / overtime 换边只更新 side。same-map source generation 变化时，retained membership 使用当前 generation 的 resolution cursor，但不复用旧 entry 的 volatile telemetry。连接模式的 MatchRoster / gameplay identity 用于排序、消歧和 canonical mapping，不作为未知 Steam64 active player 的硬 allowlist。

`retained` 只表示节目 membership 仍然成立，不表示 source 仍提供该 entry 的当前状态。缺失成员的 health、equipment、weapons、observer slot 等 volatile telemetry 必须保持 unavailable/null；Raw source observation 不能为了填满 HUD card 而回写上一帧数值。

ADR 只使用 Steam64 keyed player state 的 `roundTotalDamage`，每个 counted round 保存该字段的最大值，避免死亡后 source 把累计值回报为零。round phase transition、continuity 和 `mapEpoch` 驱动生命周期；`map.round` 只作 sanity hint，因此 `freezetime/live round=N → over round=N+1` 仍可 finalize 当前有效回合。完整观察到 freezetime → live 的回合才进入 counted rounds；当前 counted round 任意时刻出现 `coverage.allPlayers != present` 时立即 `invalidated=true`、`eligible=false`，不对有洞的回合插值；已完成历史保留，后续新的完整回合可以重新开始统计。`liveAdr` 包含当前 eligible round，`completedAdr` 只包含已完成 counted rounds；`mapEpoch` 改变才清空 map-level history。

这些都是 Core 派生语义。Renderer 不负责 roster inference、identity binding 或 ADR history；Raw GSI `previously` / `added` 仍只作为 adapter diagnostics 和 regression evidence。

## 6. GSI ingress

Companion 的 GSI ingress 只负责：

1. 接收 HTTP POST；
2. 验证 GSI token；
3. 应用 body / request limit；
4. 记录 UTC 与 monotonic 接收时间；
5. 将 accepted payload 交给 Capture Recorder 和 telemetry adapter；
6. 快速 ACK。

request hot path 不执行磁盘等待、RivalHub 网络调用、场景选择或重型业务逻辑。

默认监听 loopback。LAN exposure 不是 telemetry 默认行为。

## 7. Capture

Production Capture Recorder 属于 Companion telemetry runtime，不属于 `packages/testkit`。

基本要求：

- 写盘与 GSI request ACK 解耦；
- queue 有明确 item 和 byte 上限；
- queue overflow 时记录 degraded state，不无限积压；
- writer failure 不阻塞 Runtime；
- shutdown 尝试 bounded finalization 并明确 incomplete 状态；
- token 和不必要个人数据不进入可共享 fixture。

Capture format 必须保留足够的 receive time、sequence 和 integrity information，使 offline verifier 能证明某个 runtime observation 对应真实 accepted frame。

## 8. Replay

Replay 必须重新经过 production adapter：

```text
recorded raw input
→ production parser / normalizer
→ Core
→ Projection
```

禁止测试直接伪造最终 RuntimeState 或 ProgramProjection 来替代 telemetry semantics validation。

`packages/testkit` 可以对输入注入：

- packet drop；
- duplicate；
- reorder；
- jitter；
- disconnect / reconnect；
- time acceleration；
- slow consumer；
- source generation change。

## 9. CSTV / GameEvent 边界

`packages/telemetry-cstv` 是第三方 CSTV parser 的 isolation layer。

它负责：

- 读取 CSTV fragment；
- 维护 source-local generation / sequence / tick / health；
- 将支持的 GameEvent 立即复制为 Mizar-owned scalar observation；
- 将 parser exception 转成受控 source diagnostic。

它不负责：

- 修改 RuntimeState；
- 推导 Program fallback；
- 建立第二套 event-sourcing；
- 渲染 HUD / Radar；
- 决定 canonical 比赛事实。

Program 与 Lookahead 各自维护数据源连接连续性。Lookahead 重连必须让旧时间轴对齐失效，但不能仅因为连接重建就改变 Program `mapEpoch`。

### 9.1 可选 Program GameEvent 消费链

`CstvSourceManager<R>` 当前承载 HTTP CSTV 适配器，并在类型边界固定数据源 role、提供仅实时事件订阅：

```ts
subscribeLiveGameEvents(
  listener: (event: RoleScopedGameEventObservation<R>) => void,
): () => void
```

事件在 `session.start()` / `connecting` 阶段仍会进入有界 `recentGameEvents`，只作为 Debug / 制作控制证据；只有 `start()` 返回 `ready`、manager 进入 `live` 后，`run()` 阶段的新事件才会通知实时 listener。因此重连时的初始化 / 补齐事件不会被当作新的 Program 边沿补播。

`ProgramCueCoordinator` 当前实现只能接收 `CstvSourceManager<'program'>`，在事件到达时读取当前
Program Runtime 的 freshness、`mapEpoch` 和已知地图名。数据过期 / 等待遥测、明确错地图、缺少目标 / 被击杀者稳定数据源玩家 ID，或事件并非来自实时数据源时，立即丢弃且不进入等待队列。Lookahead manager 不进入 Program cue 的类型或组装路径。

这一实现约束不代表 Program 必须拥有 HTTP CSTV 数据源。完美平台 Program V1 在该数据源未启用时继续使用 GSI；Renderer 的通用掉血、死亡和低血量表现仍由连续 Program snapshot 驱动。只有依赖精确 `player_hurt / player_death` 元数据的武器类型专属短时特效会缺少增强。未来其它精确事件适配器可以复用同一 Program role 语义，不应把具体接入方式提升为 Core contract。

Lookahead 的无头直连 CSTV 客户端后续在新的独立仓库研发，本仓的 telemetry 边界只定义其接入后的标准 observation 语义。

## 10. 时间与序列

本地 duration、timeout、staleness 和 interpolation 使用 monotonic clock。

跨进程、跨机器、报告和审计使用 UTC wall clock。

```text
monotonic → 过了多久
wall clock → 什么时候发生
```

sequence value 必须明确 scope，不能把 ingress sequence、runtime sequence、channel sequence 混成同一个编号。

## 11. 真实证据与 Fixture

真实 Windows + CS2 / CSTV 输入用于证明数据源行为；synthetic fixture 用于可重复覆盖边界条件。

当真实采集记录与旧假设冲突时：

1. 保留原始证据；
2. 修正数据源语义；
3. 更新适配器；
4. 从真实采集记录派生新的脱敏 fixture；
5. 删除已经不成立的兼容假设。

参考样本集应覆盖：

- warmup / freezetime / live / round end；
- halftime / side switch；
- map end / map change；
- disconnect / reconnect；
- source restart / generation change；
- Program 与 Lookahead 时间轴对齐；
- 长时间运行 / 慢消费方行为。

新增采集记录只用于回答明确问题，不为了样本数量重复录制已经充分证明的场景。

### 11.1 Objective Clock qualification report

Capture V1 的真实 observer evidence 可通过 Production Capture Recorder 生成的原始
capture 做离线分析。qualification 模式下 recorder 会在同一 manifest 写入 raw recorder
provenance、capture-relative monotonic clock origin、exact CS2 build、验收包 SHA-256 和环境/运行编号绑定；普通或脱敏
fixture 没有资格伪装成 production capture：

```text
pnpm qualification:objective-timing <capture-dir>
```

分析器分三层输出：measurement 只计算 active packet interval 的 p50/p95/p99/max、countdown
delta 与 monotonic residual、source-local state/phase residual、plant/defuse/explosion terminal
residual、provider/receive 时间证据、missing countdown spans 和 packet/sequence gaps；evidence
coverage 再验证 raw recorder provenance、canonical production GSI config 和 Issue #49 的 8 个
最小 objective scenario。若同一场 CSTV/demo 可用，再把独立的 `objective-events.jsonl` 作为
精度交叉核验；它不是仅用 GSI 数据完成生命周期语义验收的前置条件。验收判定最后才组合这些 gate。报告只打印 allowlisted GSI config，不打印 token；原始 frames、
manifest、reference file、scenario marker 和 SHA-256 仍是证据源。

同一个 GSI payload 内的 bomb/phase 对齐只能作为 source-local consistency，不能证明 observer-visible
transition residual、common-mode fixed offset 或 random delay。缺少 raw production provenance、完整
scenario coverage 或来源语义证据时，目标证据基础判定必须保持
`INCONCLUSIVE` 或 `FAIL`；缺少可选独立 reference 只会让 0.1 秒数值能力保持
`INCONCLUSIVE`，不能把它误报为 `PASS`。synthetic fixture 和 sanitized fixture 只能测试
measurement/analyzer 回归，不能冒充 production qualification。

目标证据基础、来源语义/生命周期验收与数值精度能力是三个独立结论。
前者必须处理 overloaded countdown 的 phase 切换、`round.bomb`、matching defuser 的 kit
evidence、abort/restart 和显式场景 consequence；显式 semantic mismatch 为 `FAIL`，缺少语义证据为
`INCONCLUSIVE`。terminal residual 与 countdown sample completeness 属于 numeric/availability
gate：终止时刻误差超过 100 ms 为 numeric `FAIL`，缺少终止样本或倒计时样本时 numeric 保持
`INCONCLUSIVE`，不把数值/可用性缺口误判成来源语义 `FAIL`。目标证据基础只要求真实采集记录完整、正式配置和来源可追溯、八类场景
覆盖、短时有效窗口足够且来源语义通过；0.1 s 数值能力即使 `FAIL`，基础验收
仍可为 `PASS`，这表示 HUD 不得承诺 0.1 秒。后者的 0.1 s gate
包括 active packet interval p99 ≤ 200 ms、独立 reference transition residual p95 ≤ 100 ms、
独立 absolute offset ≤ 100 ms、canonical production config 匹配、完整 scenario coverage，
countdown samples complete、terminal residual coverage/bound，并且 configured objective lease ≥ `3 × measured p99` 且不超过 Core policy 上限。lease 与 Core
共用 canonical policy；因此一次 capture 即使 0.1 s gate FAIL，也必须单独报告 lease sufficiency。
plant、defuse、explosion 三类 terminal residual 必须各自有统计样本；缺样本时 coverage gate
保持 `INCONCLUSIVE`。`precision_time=3` 不构成 1 ms 保证，0.01 s 不承诺。

8 个场景不是从形状推断出来的布尔值，而是由 qualification marker 明确声明窗口：
`freezetime-live`、`plant-abort`、`planted-explode`、`defuse-kit-abort-restart`、
`defuse-no-kit-abort-restart`、`too-late-defuse`、`fast-defuse-missing-planted-sample`、
`reconnect-restart`。每个窗口必须有同一 Capture V1 `captureId` 绑定的 `before`/`after`
marker；raw frames 验证实际 consequence。fast-defuse 只看窗口内的第一帧，不能看整段 capture
的第一帧。reconnect 不由 heartbeat 间隙或 sequence gap 推断，只能由显式 marker 绑定不同
采集记录身份的整轮汇总验证；同时必须有开始侧已下包/拆弹状态、结束侧
新采集记录中的正常观测，以及 Runtime 中递增的 Program source generation。现场验收通过
`rotate.ps1` 在同一现场验收轮次内切换采集记录身份并推进既有 Program source generation；
GSI ingress sequence 保持单调，不另造 qualification-only generation truth。结束标记在新
generation 尚未接受到正常 GSI 观测时会被拒绝。Windows 备用入口为：`mark.ps1 objective-plant-abort -Phase before`
/ `-Phase after`，重连场景还需在实际重连或接收端重启后执行 `rotate.ps1`，等待新的已下包链路
观测，再记录 `objective-reconnect-restart -Phase after`。

canonical production GSI config 的唯一代码来源是
`packages/telemetry-gsi/src/production-config.json`；analyzer 会对 capture manifest 的
`timeout`、`precision_time`、`buffer`、`throttle` 和 `heartbeat` 做规范化比较。

`objective-events.jsonl` 是 Production Capture Recorder 在 Program CSTV source 可用时写入的
独立 reference contract，每行格式为：

```json
{"version":2,"referenceId":"cstv-program-3-41-bomb-planted","kind":"bomb-planted","source":"cstv","captureId":"capture-1","timebase":"capture-elapsed-us","occurredAtUs":1234500,"sourceCursor":{"kind":"cs2-cstv","role":"program","generation":3,"sequence":41,"tick":123456,"observedAt":"2026-09-21T00:00:01.234Z","observedMonotonicMs":1240.5,"mapName":"de_ancient","ticksPerSecond":64},"sourceArtifact":{"id":"program-cstv-endpoint","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}
```

`kind` 必须是精确的 `bomb-begin-plant`、`bomb-abort-plant`、`bomb-planted`、
`bomb-begin-defuse`、`bomb-abort-defuse`、`bomb-defused` 或 `bomb-exploded`；`sourceCursor`
必须携带 role、generation、sequence、tick、UTC observation time、map identity 和 tick rate，
`sourceArtifact` 必须有 id 与 SHA-256。Production Recorder 默认把 Program CSTV endpoint 的
identity hash 写入 `sourceArtifact`；离线 CSTV/demo extractor 应写入对应输入 artifact 的内容
SHA-256，不能把 endpoint identity 当作内容完整性证明。`occurredAtUs` 由同一进程的 CSTV observation monotonic
time 按 manifest 的 `clock.originMonotonicMs` 对齐，analyzer 会拒绝无法复现 common clock alignment
的记录。没有该文件、clock、source provenance 或对齐证明时 transition/absolute-offset precision
gate 为 `INCONCLUSIVE`；仅用 GSI 数据的生命周期语义仍可由原始帧和显式场景窗口完成。

## 12. 隐私与安全

Capture、日志和 fixture 必须：

- 移除 GSI token；
- capture sanitizer v2 移除认证凭据、本机/私有 endpoint、绝对本机路径和机器特有元数据；
- public-match real-derived fixture 保留原始 Steam64、GSI player display name 与 team/clan name，以维持身份连续性和来源真实性；
- 不把 Steam64、公开选手昵称或队名作为 secret；runtime/debug/qualification 各自既有的隐私与 secret guard 保持独立；
- 保留验证 continuity 需要的结构，不通过删字段破坏语义；
- 在进入仓库前执行 sanitizer 和 integrity check。

本机私人比赛的原始账号素材不属于 public-match acceptance corpus。需要覆盖字段形状时使用明确标记的 synthetic contract fixture，不把私人账号伪装成公开职业选手。
