# 协议与本地数据契约

本文记录当前有效的三类协议边界：

1. Mizar 从赛事上下文提供方读取的比赛只读契约；
2. Companion 向本地 Program、Radar、Operator 和 Assist 提供的 WebSocket 快照协议；
3. Companion 向 Program 提供的短生命周期 transient cue 协议。

协议字段与精确字符串以代码 schema 为最终机器来源；本文负责解释语义、ownership 和兼容规则。

## Program Scene 与 Workspace 控制面

`packages/protocol/src/program-scenes.ts` 是场景 ID、顺序、中文名称、路径和 composition mode 的唯一 registry。Companion 的 `GET /local/v1/program-scenes` 返回当前 scene、revision、可用 scene 和阻断原因；`POST /operator/program-scene` 使用预期 revision 切换。Workspace 只提交意图，Companion 基于当前 Program/Operator/BP projection 校验并协调 OBS，OBS Browser Source 使用相同 registry 中的路径。Tauri 仅控制本机窗口，不拥有场景真值。

在线比赛入口先按受限 `matchId` 通过配置的只读 HTTPS Manifest URL 获取候选，再走现有 MatchContext 验证、人工确认和 LKG。刷新失败将当前在线来源标记 stale，不清除已确认上下文；本地模式无需在线凭据。OBS 状态与检查/修复通过 Companion 本地控制面提供，密钥不进入浏览器返回值。

## 1. RivalHub 只读赛事上下文

RivalHub 连接模式通过 `packages/rivalhub` 消费公开、版本化的只读契约。Mizar 不直连 RivalHub 数据库，也不导入 RivalHub 内部 domain 类型。

```text
RivalHub API / 同形 fixture / 本地 LKG
                ↓
packages/rivalhub
  parse → validate → convert
                ↓
packages/core
  MatchContext / ScheduleWindow / identity
```

`schemaVersion`、`revision`、来源和新鲜度属于 acquisition metadata，不进入纯 `MatchContext`。

### 1.1 BroadcastManifestV1

当前 schema version：

```text
rivalhub.broadcast-manifest.v1
```

顶层结构：

```ts
{
  schemaVersion: "rivalhub.broadcast-manifest.v1",
  revision: string,
  match: {
    matchId: string,
    competition: {
      competitionId: string,
      slug: string,
      name: string,
      themeColor: string | null
    },
    status: "scheduled" | "in_progress" | "finished" | "cancelled",
    format: "bo1" | "bo3" | "bo5",
    stage: string,
    round: number | null,
    entryRound: string | null,
    scheduledAt: string | null,
    startedAt: string | null,
    completedAt: string | null,
    scoreA: number | null,
    scoreB: number | null,
    isForfeit: boolean
  },
  entrants: {
    a: BroadcastEntrantV1,
    b: BroadcastEntrantV1
  },
  maps: BroadcastMapV1[],
  veto: BroadcastVetoStepV1[],
  commentators: BroadcastCommentatorV1[]
}
```

Entrant 包含 `entryId / name / logoUrl / roster`。Roster 中的选手包含 `playerId / steam64 / displayName / avatarUrl / isStarter`。

地图包含 `mapId / mapOrder / mapName / pickedByEntryId / teamAStartSide / scoreA / scoreB / completedAt`。`teamAStartSide` 只表示地图起始边，不是整场永久 CT/T 映射。

时间字段保持赛事 authority 的原始语义：

```text
scheduledAt  计划开始时间
startedAt    官方实际开始时间
completedAt  官方完成时间
```

Mizar 不从本地观测反向改写这些字段。

### 1.2 BroadcastScheduleWindowV1

当前 schema version：

```text
rivalhub.broadcast-schedule-window.v1
```

ScheduleWindow 是轻量赛程视图，只包含时间窗口内比赛的身份、状态、BO、阶段、比分和双方参赛实体，不复制 roster、BP、maps 或 commentator 细节。

窗口请求由：

```ts
{
  competitionId: string,
  from: string,
  to: string
}
```

唯一确定。内存绑定和 LKG 只有在该请求三元组完全兼容时才能复用，避免跨赛事或跨时间窗口泄漏旧数据。

### 1.3 结构校验与语义校验

所有 RivalHub read-side payload 先通过结构 schema，再通过语义 validator。

语义诊断使用：

```ts
{
  kind: "structural" | "semantic",
  severity: "warning" | "error",
  code: string,
  path: string,
  message: string
}
```

Blocking error 会阻止 candidate 进入 Core。可恢复的缺失信息保留为 warning，不通过猜测制造身份或赛事事实。

Steam64 始终以字符串处理，不转换成 JavaScript number。

## 2. 身份证明

赛事身份与运行时 side mapping 分离：

```text
CompetitionEntry.entryId
  参赛实体身份

playerId + Steam64
  选手官方身份

CT / T
  当前运行时阵营映射

observer slot / nickname
  显示或辅助诊断信息
```

运行时匹配只把 Steam64 作为稳定玩家键，不用昵称或 observer slot 兜底猜测身份。

身份状态：

```text
unbound
resolving
matched
degraded
mismatch
```

source generation 或 map epoch 改变后，旧 identity proof 失效，必须由新鲜 evidence 重新证明。

## 3. LKG 与本地恢复

MatchContext 与 ScheduleWindow 分别维护独立的 Last Known Good（LKG）缓存。

规则：

- 只有结构和 blocking 语义校验都通过的 payload 才能替换 LKG；
- 缓存保存原始 DTO 与必要 metadata，恢复时重新 parse、validate、convert；
- 写入使用临时文件 + 原子替换，失败时保留旧缓存；
- 切换比赛失败不能残留上一场上下文；
- 同一比赛刷新失败时可以继续使用当前内存绑定并标记过期；
- ScheduleWindow 失败不清除当前 MatchContext；
- latest-wins generation 防止旧请求晚返回后覆盖当前选择。

`stale` 表示上下文获取或新鲜度问题，不等于 identity mismatch。

## 4. Local Protocol V1

Mizar 本地协议用于 Companion → Program / Radar / Operator / Assist 的只读快照，以及
Companion → Program 的短生命周期 transient cue。两类消息共享 WebSocket 承载和安全策略，
但不共享 snapshot 的 latest-wins 语义。

### 4.1 版本

当前精确版本的唯一代码来源是 `packages/protocol/src/version.ts`；本文不复制各 channel 的
数字常量，避免 schema 演进后文档形成第二份版本真相。Local Protocol 版本与各 channel
schema 版本独立。单个 channel payload 演进时，不要求其它 channel 或 WebSocket 子协议同步升级。

当前 Local Protocol 子协议仍为 `mizar.local.v1`，路由前缀见下节。

### 4.2 路由

```text
/local/v1/program
/local/v1/radar
/local/v1/operator
/local/v1/assist
/local/v1/program-cue
```

`program`、`radar`、`operator`、`assist` 是 snapshot channel；`program-cue` 是独立 transient
channel。每个 channel 有独立 Zod schema、DTO、发布器和接收状态，不存在一个包含全部字段的万能
union payload。

### 4.2.1 HUD presentation control-plane

HUD 配置不进入上述 WebSocket channel，也不扩展 `ProgramSnapshot`。Companion 通过：

```text
GET  /local/v1/hud-config
GET  /operator/hud-config
POST /operator/hud-config
```

`GET /local/v1/hud-config` 是 Program/on-air read model，只返回当前已启用的
`HudResolvedPreset`、`activeRevision` 和基于 resolved canonical JSON 的 SHA-256 ETag。浏览器每 500ms
使用 `If-None-Match` 条件请求；保存布局/外观/预设资源不会改变该 ETag，重复启用同一 resolved preset
也必须保持 ETag 不变，只有启用新的 resolved preset 才改变它。它的 HTTP representation 在 active
revision 不变时不得改变。

`GET /operator/hud-config` 是编辑器 read model，返回完整的 `HudConfigDocument`、`activationStale`、
编辑器 `revision` 和针对这整个 representation 计算的 ETag。保存资源会更新编辑器 revision，但不
改变 on-air ETag；启用预设会同时更新编辑器 read model，并在 resolved 内容变化时更新 on-air revision。
读取、解析或持久化失败时，Companion 保留 last-known-valid 配置，不能清除或猜测 gameplay snapshot。

每个 mutation 都必须提交客户端刚读取并实际编辑的 `expectedEditorRevision`（实现上可由同一值映射到
`If-Match`）。Companion 在 `SerialCommitQueue` 内执行该 revision 的 compare-and-swap：revision 过期时返回
`409`，不覆盖磁盘或内存中的新配置；命令或 schema 无效返回 `400`；持久化或内部错误返回 `500`。
`500` 的 response 只包含 bounded user-facing message，详细的底层错误只写入 Companion diagnostics/log。
编辑器收到 `409` 后必须保留本地 draft，并明确提示用户先处理 conflict；不能把 stale mutation 当成成功。

`POST` 只接受 `save-resource`、`save-as` 和 `activate-preset` 三类明确命令。正常 Operator ingress
不接受 Operator token、Bearer credential 或其他普通凭据；写操作只允许 Companion 以 loopback bind
接收，且请求必须通过 valid local Origin；`LOCAL_WEB_LAN_MODE=1` 时 control-plane 保持 read-only，即使 Origin 在 LAN allowlist 中也
必须拒绝 mutation。GSI ingress 继续使用独立的 `GSI_TOKEN`，qualification-only control plane
继续使用独立的 `QUALIFICATION_CONTROL_TOKEN`。mutation response 必须返回本次 command 的明确
`resourceId` / `sourceId`，客户端不得从前后资源 ID 集合差推断本次创建的资源。内置 `builtin:*` 资源只读；
配置文件由 Companion 以同目录临时文件加原子 rename 保存。`HudResolvedPreset` activation snapshot 有独立的 v1
compatibility boundary：严格校验 schema version、exact widget keys、嵌入布局、preset/layout/theme
引用一致性、descriptor-owned settings，以及颜色、透明度、圆角和字体等 semantic value 的安全域；
加载时不得通过当前 Theme recipe 重算并要求 canonical bytes 相同。recipe 变化不会改写旧 custom
snapshot，重新 Activate 才产生当前 recipe 的新 snapshot；真正不兼容的版本必须在该 boundary 增加显式
migration。该 control-plane 的版本与 Local Protocol / channel schema 版本独立。

### 4.3 快照 envelope

通用 envelope：

```ts
{
  type: "snapshot",
  protocolVersion: 1,
  channel: "program" | "radar" | "operator" | "assist",
  schemaVersion: number,
  channelSeq: number,
  cursor: {
    producerInstanceId: string,
    liveSessionId: string | null,
    runtimeSeq: number,
    programSourceGeneration: number,
    programReceiveSequence: number | null,
    mapEpoch: number
  },
  payload: ChannelPayload
}
```

`schemaVersion` 由具体 channel schema 决定，不能假定所有 channel 都是 1。

`channelSeq` 在 `producerInstanceId + channel` 范围内单调递增。`runtimeSeq`、`programSourceGeneration` 与 `mapEpoch` 分别表达不同的连续性语义，不能互相替代。

### 4.3.1 Program transient cue envelope

`program-cue` 不伪装成 `type: "snapshot"`，也不进入 `ProgramSnapshot`。它只有自己的 schema
version 和最小 CSTV continuity cursor：

```ts
{
  type: "cue-baseline" | "cue",
  protocolVersion: 1,
  channel: "program-cue",
  schemaVersion: 1,
  channelSeq: number,
  cursor: {
    producerInstanceId: string,
    liveSessionId: string | null,
    mapEpoch: number,
    cstvProgramGeneration: number
  },
  cue?: {
    id: string,
    mapEpoch: number,
    source: { generation: number, sequence: number, tick: number },
    kind: "player-impact" | "player-elimination",
    // kind-specific Program-safe semantic fields
  }
}
```

`cue-baseline` 是每个新连接的第一条业务基线，也是 reset barrier；它只建立“从现在开始”的
接收上下文，不携带旧 cue。`cue` 每条只承载一个 semantic edge。`cstvProgramGeneration`、
CSTV source sequence 和 local `channelSeq` 分别属于 source continuity、source ordering 和
delivery ordering，不能互换；cue 不携带 GSI `programSourceGeneration`、`runtimeSeq` 或
`programReceiveSequence`。

### 4.4 Program payload

Program payload 只包含正式节目允许显示的信息：

- telemetry / context / identity 状态；
- 比赛、赛事和 BO 信息；
- canonical 或 neutral team presentation；
- 地图、比分、回合与时钟；其中 `clock` 只表达 `phase_countdowns` 的 phase clock，不表达永久保留的爆炸倒计时；
- Core 解析后的稳定 5+5 on-air player cohort；raw `allplayers` 中未进入 cohort 的 extra 不进入 Player Rails；
- 选手显示身份和装备状态；
- `weaponsAvailable` 表达当前 player weapons block 是否有证据；`currentRoundDamage` 只表达当前完整、连续回合中按 Steam64 累积的最大 `roundTotalDamage`；`roundMoneySpent` 只表达由 Core 冻结的 freezetime round-start money baseline 与当前 money 的非负差值；证据不足时均为 `null`（`weaponsAvailable` 为 `false`）；
- `identityEvidence: canonical | observed | unresolved`，表达 canonical identity 是否已核验；
- `lineupEvidence: current | retained`，表达当前 entry 是否来自本帧或稳定 baseline；`retained` 不等于已确认掉线；
- `liveAdr`，由 Core 的 map-scoped accumulator 按已完成 counted rounds 与当前 eligible round 的 damage / rounds 计算；没有可计入分母时为 `null`；
- `completedAdr`，只按已完成 counted rounds 的 damage / rounds 计算；在当前回合进行中保持稳定，尚无 counted round 时为 `null`；
- `lifeState: alive | dead | unknown`；
- C4 的状态、爆炸时钟和当前 plant/defuse action；爆炸时钟只来自 Core 保留的 planted countdown anchor，defusing frame 的 overloaded countdown 不会覆盖它；
- 数据覆盖状态。

地图 Program projection 还保留当前 side 的 `consecutiveRoundLosses`（CT/T 各自为
`number | null`）；它来自 GSI `map.team_*.consecutive_round_losses`，非法或缺失值不补猜。

Program 的 `bomb` 结构为：

```ts
{
  state: BombState | null,
  sourcePlayerId: string | null,
  explosion: { remainingSeconds: number | null, durationSeconds: number | null } | null,
  action:
    | { kind: "plant", sourcePlayerId: string | null,
        remainingSeconds: number | null, durationSeconds: number | null }
    | { kind: "defuse", sourcePlayerId: string | null,
        remainingSeconds: number | null, durationSeconds: number | null,
        hasDefuseKit: boolean | null }
    | null
}
```

`planting` 的 action duration 只在同一 generation/mapEpoch 连续观察到 carried/dropped → planting 时记录首个非负 countdown。explosion duration 只在连续 planting → planted 时记录首个非负 planted countdown，后续 planted sample 可向上校准；它是观测到的展示分母，不是 server cvar。late join 不建立分母，gap/stale recovery、generation/mapEpoch、terminal 清空分母。`defusing` 只有当前 player evidence 明确提供
`hasDefuser` 时才给出 5 秒或 10 秒 duration，不能用默认值猜测。没有已知 planted anchor
时，defusing 不合成爆炸倒计时。numeric objective clock 只在短 lease 内由 Core 使用
monotonic time 插值；lease 过期后保留语义状态但将 numeric remaining 置为 `null`。Renderer
可以在收到的当前值之间做视觉插值，但不能在本地 retention、reconnect 或 stale 后继续推演。

Program 不包含：

- player position / forward；
- grenade 世界状态；
- 地图几何；
- identity issue 细节；
- Raw GSI / Raw CSTV；
- Raw GSI 的 `bomb.countdown`；它只保留在 telemetry observation，不能作为 Program wire 字段；
- LKG metadata；
- Lookahead / future 信息。

`lifeState` 由 Core 的共享领域 helper 推导，Program 与 Radar 不各自重复根据 health 猜测。

`ProgramProjection` 不从 renderer 侧推断 active player，也不累计 ADR。Active lineup 只有在 `coverage.allPlayers = present`、10 个唯一稳定 Steam64、CT 5 人 + T 5 人且无歧义时才建立或替换 baseline；稳定 baseline 遇到 transient missing/extra 或 `degraded` evidence 时可以保留并标记 `retained` / `degraded`。没有 previous baseline 时，degraded 的 clean-looking 5+5 仍不得晋升。same-map source generation 变化时，retained membership 重新挂到当前 generation；generation continuity 由 resolution cursor 表达，证据质量由 `lineupEvidence` 表达。RivalHub roster 是 connected mode 的 strongest prior，但未知 Steam64 的稳定 active player 仍可进入节目，canonical identity 保留为 `null` 并通过 Operator/diagnostics 报告 warning。

Stable membership（Steam64 集合）与当前 CT/T side assignment 分离：halftime / overtime 换边只更新 side，不重置 membership。`coverage.allPlayers = absent` 表示没有新的 lineup evidence，不触发 lineup transition；如果成员暂时缺失，`retained` 只保留节目槽位和 identity metadata，缺失成员的当前 health、equipment、weapons、observer slot 等 volatile telemetry 以 unavailable/null 表达，不从上一帧伪造。

### 4.4.1 Series projection

Program 的 `series` 是 Core `SeriesProgress` 的 entrant-oriented 只读 projection，包含 `format`、`requiredWins`、双方 entrant、Mizar 本地冻结的 `score`、`planned | live | completed` 状态、`bindingState`、`currentMapOrder`、地图 compact strip、原始 veto steps，以及当前/刚结束地图的有限 `roundHistory`。

`series.score` 与兼容保留的 `teams.ct/t.seriesScore` 必须来自同一份 `SeriesProgress`；不能继续以 `MatchContext.scoreA/scoreB` 作为第二份实时真相。地图异常时 `bindingState = needs_operator`、`currentMapOrder = null`，但当前 GSI map/CT/T score 仍可正常进入 Program。Renderer 不读取 `MatchContext.maps[]`、`veto[]` 或 Raw GSI 自行推导 Series。

`roundHistory` 的 item 只表达已证明的 `roundNumber`、source `winnerSide`、可冻结的 `winnerEntryId` 和 normalized `winCondition`。历史恢复不完整时暴露 `partial`，不填补无法证明的回合。

### 4.5 Radar schema v2

Radar 快照包含当前雷达领域所需的比赛游标、新鲜度、身份状态、地图、选手、C4 和手雷等信息。雷达 schema 表达 domain frame，不承诺 React / SVG / Canvas 等具体渲染实现。

v2 显式增加了以下字段以支持端侧轻量动效与战术标记渲染，同时保持严格 schema 校验：

- `RadarPlayer` 补充 `health: number | null`、`flashAmount: number | null` 与 `activeWeapon: { name: string | null, ammoClip: number | null, state: 'active' | 'holstered' | 'reloading' | 'unknown' | null } | null`；
- `RadarGrenade` 补充从 GSI raw payload 归一化提取的 `effectTimeSeconds: number | null`（缺失/异常为 `null`）；
- 全部 payload 与 nested 对象采用 strict schema，未知字段 fail closed。

### 4.6 Operator schema v4

Operator 快照包含制作控制需要的比赛上下文、运行转换、身份、ActiveLineup diagnostics、SeriesProgress binding/issues 和 source health。`seriesProgress` 只提供 Operator 恢复所需的有界地图状态、比分与诊断；它可以比 Program 拥有更多运行诊断，但不能成为 Program 的数据来源；`activeLineup.extras` 与 resolver issues 只用于 Operator/debug，不进入正式 Player Rails。

当 `seriesProgress.bindingState = needs_operator` 时，Companion 提供 `POST /operator/series/bind`。该
正常 Operator ingress 不接受 token 或 Bearer credential；写操作只允许 loopback bind 且 Origin 通过
local Web Origin policy，LAN mode 一律拒绝 mutation。请求提交
`bind-current-map-execution-to-series-map`、`mapOrder` 与非空 `reason`；服务只返回 command
acknowledgement，不允许通过该入口直接改写比分。qualification-only 路由的
`QUALIFICATION_CONTROL_TOKEN` 不属于此正常 Operator ingress。

### 4.7 Assist schema v1

当前 Assist schema 仅表达该通道的可用性与游标，不预留未经设计冻结的未来字段。Assist 负载发生不兼容演进时，只提升 Assist 自己的 schema version。

## 5. 接收规则

每个 WebSocket connection 使用独立 acceptance state。Snapshot connection 使用 snapshot
acceptance；`program-cue` connection 使用 cue-specific acceptance，不能把 transient message
写入当前 snapshot store。

接收方必须：

- 拒绝 protocol / channel / schema version 不兼容；
- 旧 Program receiver 与当前 Program schema 不是兼容 envelope；旧 receiver 必须拒绝当前 schema，当前 receiver 必须拒绝旧 schema，不能按字段猜测版本；
- 忽略重复或倒序 `channelSeq`；
- 拒绝同一 producer 下 `runtimeSeq` 回退；
- 拒绝一个连接中途切换 `producerInstanceId`；
- 在 `liveSessionId`、`programSourceGeneration` 或 `mapEpoch` 改变时重置对应连续性证明；
- `program-cue` 连接在 baseline 前不接受 cue；重复或倒序 `channelSeq` 忽略，允许 sequence gap；
  每个 baseline 最多保留最近 128 个 cue id 做 bounded dedupe。

新 producer 必须建立新连接和新 acceptance state。

## 6. 投递与背压

Snapshot channel 每条消息都是完整快照，不发送 delta、历史快照 ACK 或离线 history queue。

每个 subscriber 只保留：

```text
1 个正在发送
+ 1 个最新待发
```

新的待发快照覆盖旧待发快照。慢 subscriber 不阻塞其它 subscriber，也不能让内存队列随时间增长。

连接建立或重连后立即发送当前基线，不重放断线期间的旧快照。

`program-cue` 使用独立的 bounded delivery：每个 subscriber 保留 1 个 in-flight、最多 32 个
按 source order 排列的 pending cue FIFO，以及最多 1 个 pending baseline/reset barrier。队列溢出丢弃
最旧 pending cue 并记录 diagnostic；pending cue 超过 1000 ms monotonic age 在发送前丢弃。baseline
会清空旧 pending cue 并成为下一条 control message。没有 subscriber 时不保留 cue history；visual
TTL 不进入 wire，由 Renderer 自己管理。

## 7. WebSocket 承载与安全

Companion 使用同一 Fastify 实例提供网页静态资源和 Local Protocol WebSocket。

当前传输约束：

- 子协议：`mizar.local.v1`；
- 默认监听：`127.0.0.1`；
- 本机回环模式只接受本机 HTTP(S) Origin；
- 非回环监听必须显式开启 `LOCAL_WEB_LAN_MODE=1`；
- `LOCAL_WEB_ALLOWED_ORIGINS` 使用精确 Origin 允许列表；
- 本地 snapshot 与 transient channel 均为 server → browser 只读；
- 浏览器发送业务消息时以 close code `1008` 关闭；
- `perMessageDeflate` 关闭；
- 单条 WebSocket payload 上限 64 KiB；
- `bufferedAmount` 与序列化快照使用 256 KiB hard guard；
- ping/pong heartbeat 周期 15 秒，约 30 秒无 pong 时清理连接。

浏览器从当前页面 Origin 推导 `ws:` / `wss:` 地址。每次新连接建立独立 acceptance state；
收到第一份有效基线后重连退避重新计时。Program cue 还必须与当前 Program snapshot 的
`producerInstanceId`、`liveSessionId` 和 `mapEpoch` 相同；不一致时立即丢弃，不等待未来 snapshot，
也不比较 CSTV generation 与 GSI source generation。断线、刷新、baseline 或 Program continuity
reset 都从当前时刻重新开始，不补播旧动画。

## 8. 协议维护原则

- 精确 schema 以代码为准，本文不得保留已失效版本号；
- 不为兼容旧文档维持双重语义；
- 新字段如果改变既有必需语义，提升对应 schema version；
- Local Protocol 不承担 RivalHub API 的 authority；
- Raw GSI、第三方 CSTV parser shape 和整个 RuntimeState 都不能直接成为 wire contract；
- 用户界面本地化不改变协议精确字符串。

### BP presentation control-plane

`GET /local/v1/bp` 使用独立 `mizar.bp.v2` schema：有限 cards/steps、赛事与赛制标题、公开队名和队标，以及 hidden/revealing/shown/hiding、revealedCount 与 revision。Match / entry IDs 留在 Companion 内部，不进入浏览器快照。仅包含 Program-safe BP presentation；没有 Manifest、roster、Raw GSI、Lookahead 或诊断。ETag 覆盖 revision、当前状态与 reveal 数量。每个浏览器串行 250 ms conditional polling，1.5 s 请求超时后隐藏；恢复只应用当前 baseline，不重演已显示步骤。此 HTTP 资源不改变现有 snapshot channel schema。

`POST /operator/bp-command` 接收 `{kind: "play" | "hide", expectedRevision}`。revision 在命令、比赛/BP 变更和回到 hidden 时变化；自动 reveal 仅改变 ETag，避免正常推进导致收起请求冲突。只允许 loopback 与有效 Origin，旧 revision 返回 409；不自动重试或排队。

`POST /operator/bp-demo` 接收 typed command `{kind: "start", format: "bo1" | "bo3" | "bo5"}` 或 `{kind: "exit"}`，请求体最多 4,096 bytes。成功响应返回当前 Demo 格式和切换后的 BP revision；工作台收到该 hidden baseline 前暂不允许播放，避免 source 切换期间提交旧 revision。它只修改 Companion 内存中的 BP Demo 状态，不调用 MatchContextController 或 LKG。进入、切换和退出都要求同一个 `BpSession` 当前为 `hidden`；其它状态返回 409 和 `请先收起当前 BP 场景。`，不会自动收起。该入口沿用 loopback only 与精确 Origin 校验，LAN 禁写。

`GET /local/v1/bp-workspace` 返回独立 `mizar.bp-workspace.v4` schema，增加 `{ demo: { active: "bo1" | "bo3" | "bo5" | null } }`，只公开当前 Demo 格式，不包含 Demo Manifest 或其内部 ID。其余字段仍是有限的来源、`authoringMode`、就绪状态、比赛双方公开名称、`authoringDraft`、仅 local/cache-local binding 可编辑的 `localDraft`、map catalog 和当前 context revision。`authoringMode` 为 `standalone | bound-overlay`：无 binding 和 standalone local match 可编辑本地赛事字段；从 online/cache-online 补录 BP 后仍为 `bound-overlay`，canonical match、competition、entrant、roster 与 commentator 元数据持续锁定。待确认 RivalHub candidate 只公开不透明 candidate revision、赛事、阶段、赛制和双方队名；不暴露内部 match/entry IDs、队标、roster、诊断或 schema version。来源显示值为 `none | online | local | cache`，Demo 不改变真实来源。Companion 重启后 Demo 状态为 inactive。

`POST /operator/bp-local-save` 接收 `{draft: LocalBpDraft, expectedContextRevision}`，请求体最多 65,536 bytes。Companion 校验结构化输入、按固定赛制生成 veto sequence，编译成标准 BroadcastManifest，再经过现有 validator、MatchContextController、ProjectionCoordinator 和本机 LKG store。无 binding 时创建 `standalone` 本地身份；已有 online/cache-online binding 时创建 `bound-overlay`，只允许补 BP，沿用比赛和参赛身份，拒绝更改 canonical metadata，并保留已完成地图；已有 `standalone` local/cache-local binding 可修改本地显示字段但保持稳定 IDs 和名单；已有 `bound-overlay` local/cache-local binding 仍只允许修改 BP。`localAuthoringMode` 属于 MatchContextBinding acquisition metadata 与 LKG metadata，不进入 MatchContext domain，也不从 ID 推断。LKG 使用 v2 envelope 保存该字段；旧 v1 local cache 没有 provenance 时按 `bound-overlay` 恢复以维持 fail-closed。保存前不清除当前 binding；校验、revision、身份或原子持久化失败时旧 binding 保持有效。成功后来源成为 `local`，播放 session 回到 hidden。该流程不创建第二份 LocalBPState，也不写 RivalHub。

`POST /operator/bp-rivalhub` 接收 `{expectedContextRevision, expectedPendingRevision}`，只确认切换到 MatchContextController 已暂存的 online candidate，不负责获取网络数据。活动 binding 生命周期与 online candidate acquisition generation 独立：开始 refresh 不清除已有有效 candidate；较新的失败请求保留它，较新的有效请求才原子替换它。本地保存成功或失败都不清除 candidate。激活必须同时匹配 `expectedContextRevision` 与 `expectedPendingRevision`；候选获取在激活期间推进时，旧激活不能清除更新候选。当前 RivalHub `main` 没有正式 BroadcastManifest HTTP endpoint；未来接入必须复用 shared controller。online candidate 恢复时不会自动覆盖 local 或 cached-from-local 比赛，只有制作人员显式确认后才切换并更新 LKG。

以上写入口仅允许 loopback 与有效 Origin；LAN 模式拒绝写入。旧 context revision 返回 409，不自动重试或排队。生产 `match-context.json` LKG 在重启后恢复比赛上下文并标记为 `cache`，BP playback session 仍从 hidden 开始。
