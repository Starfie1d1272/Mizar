# 系统架构

本文只描述当前有效的架构边界。设计过程、实施顺序和一次性调查不进入本文。

## 1. 总体模型

Mizar 是一套本地优先、snapshot-driven 并带显式边沿转换的 CS2 制播 Runtime。

```text
赛事上下文                    实时数据
RivalHub / 本地配置           GSI / CSTV
       │                         │
       └───────┐         ┌───────┘
               ▼         ▼
              Adapters
                 │
                 ▼
        Shared Runtime Foundation
        ├─ continuity
        ├─ identity
        ├─ RuntimeState
        ├─ RuntimeTransition
        ├─ health / capability
        └─ bounded delivery
                 │
      ┌──────────┼───────────┐
      ▼          ▼           ▼
正式节目      制作控制      观察辅助
Program       Operator      Observer Assist
HUD / Radar   Debug         Lookahead cues
```

架构目标按优先级为：

1. 长时间运行不积压旧状态；
2. 官方赛事事实与本地 observation 严格分权；
3. Program 与 Assist 的数据边界默认安全；
4. 错场、断流、重连和重启可以明确降级；
5. 输入可 capture、可 replay、可测试；
6. Presentation 可以持续演进而不反向污染 Core。

## 2. Authority 与数据 ownership

### 2.1 赛事上下文提供方

RivalHub 连接模式下，RivalHub 拥有官方比赛、队伍、名单、BP、赛程和赛果等赛事事实。独立模式可以提供同形的本地比赛上下文，但不会改变 Runtime ownership。两种模式的长期产品边界见 ADR-0006。

Mizar 不直接读取或写入 RivalHub 数据库，也不导入 RivalHub 页面或内部 domain 类型。

`MatchDocumentV1` 与 `ScheduleWindowV1` 是 Mizar 自有输入契约；来源、revision、新鲜度和诊断放在独立 acquisition envelope。独立模式的赛事、队伍、比赛和赛程顺序由 Companion 本机持久化，RivalHub 公开 DTO 只经 `packages/rivalhub` 转换。旧 BP Manifest 仅在本地迁移和现有 BP consumer 的兼容边界使用，不成为新的本地持久化格式。

### 2.2 Mizar

Mizar 拥有：

- 实时数据 ingress 与 normalization；
- source continuity；
- 本地比赛绑定与 identity state；
- `RuntimeState` 与 `RuntimeTransition`；
- HUD、Radar、场景和制作控制所需 Projection；
- Lookahead alignment 与 Observer Assist；
- 本地 diagnostics、capture 与 replay；
- Local Protocol 与 delivery semantics。
- `LiveSnapshotV1` 的有界最新值分发与 `ReliableEventV1` 的持久 outbox、幂等键和失效判断；外部 sink 只消费 Mizar-owned 公开契约；Companion 提供 authenticated HTTPS reference adapter、请求 Abort 与进程重启投递连续性恢复，不恢复旧 telemetry/clock。

### 2.3 赛后证据

DAK、OCR 或其它赛后来源属于 evidence / reconciliation 链，不进入低延迟 Program 主循环。

核心原则：

> Mizar 可以产生 observation；official fact 由对应赛事 authority 决定。

## 3. Package ownership

```text
apps/companion
  本地服务与 composition root。
  组装 HTTP、GSI/CSTV、比赛上下文、Core、Local Protocol、Web、HUD 配置持久化、capture 与 qualification tooling。
  拥有 Program Scene controller、OBS adapter、ProgramCueCoordinator 与 transient delivery publisher。

apps/desktop
  Windows Tauri 2 Host。只拥有 CS2 PID/HWND、窗口几何、焦点、置顶、鼠标穿透和 tray；
  启动同包 Companion，不复制 Match、Runtime、Program Scene 或 OBS 状态。

apps/web
  Program、Operator、Workspace 与 Debug 的 Web Renderer / Host。
  拥有 ProgramCueClient 与 Renderer-local ephemeral cue state；不拥有 RuntimeState，也不直接解释
  Raw GSI / Raw CSTV。

packages/core
  纯 TypeScript Runtime domain。
  拥有 continuity、identity、RuntimeState、RuntimeTransition、accumulator、Projection 和
  framework-neutral ProgramCue projector。

packages/hud-config
  framework-neutral HUD 配置 owner：HudPreset、HudLayout、HudTheme、组件 registry、严格 v1 schema、
  逻辑坐标几何约束和纯 Theme resolver。
  不依赖 React、ProgramSnapshot、GSI、RuntimeState、浏览器 API 或 Node 文件系统；Companion 负责持久化，
  Web 负责编辑器与 renderer host。组件 settings 的通用 envelope 不锁死未来 variant；每个 descriptor
  自己声明 strict settings schema、default、source owner 和 framework-neutral editorControls；通用 Inspector 仅消费声明并验证 draft。四层 ownership 与 variant policy 见 ADR-0013。resolved activation snapshot 由独立版本化兼容边界校验，不依赖当前 recipe 重算。

apps/web/src/program
  Web-owned HUD renderer registry。它把 framework-neutral descriptor 的 availability 与 React renderer
  entry 一致性锁在一起；未实现组件在 production 隐藏，只能在编辑器预览显示语义占位。Program 与 HUD
  控制台 Current Live preview 共用同一个 stable presentation boundary identity。

packages/protocol
  Mizar 自有的 Local Protocol、schema 和 acceptance rules。
  拥有 snapshot、Program Scene registry 与 `program-cue` transient wire contract；不拥有 RuntimeState 或业务状态机。

packages/telemetry-gsi
  Raw GSI parsing、source semantics、diagnostics 和 normalization。
  Raw GSI 类型不得越过本 package。

packages/telemetry-cstv
  CSTV GameEvent 读取与 parser-neutral observation。
  第三方 parser 类型不得越过本 package。

packages/rivalhub
  RivalHub 公开赛事上下文 contract 的 adapter。
  不拥有 Core / Radar / Lookahead domain。

packages/radar
  framework-neutral Radar domain：RadarFrame、world→radar、MapGeometryProvider、floor、marker / utility semantics。
  不拥有 React/SVG/Canvas/DOM，也不拥有 temporal interpolation、smoothing、autozoom/crop animation state。

packages/cs2-assets
  CS2 official presentation asset 的唯一 owner：semantic catalog、content-hashed generated SVG、manifest、provenance 与 framework-neutral resolver。
  不拥有 RuntimeState、Program protocol、Raw GSI/CSTV、React renderer 或地图 geometry；Source 2 解包只通过 pinned development-time VRF CLI adapter 完成。

packages/replay
  framework-neutral 的离散回放 cursor 与 scheduler；按 capture 时间选择 authoritative frame，并通过注入的 source seam 请求 deterministic prefix rebuild。
  不读取 capture 文件、不解析 Raw GSI、不构造 gameplay truth，也不依赖 React、DOM、浏览器或 Node API。

packages/testkit
  capture 读取、production replay composition、simulation、fault injection 和 deterministic assertions；复用 `packages/replay` 的 cursor 与 scheduler。
  不得成为 production runtime dependency。
```

依赖方向必须保持：

```text
adapter → Mizar-owned domain → consumer Projection → Renderer / transport
```

禁止通过 deep import、TypeScript `paths` 或共享数据库绕过 ownership。

## 4. RuntimeState 与 Projection

Core 只有一份内部 `RuntimeState`，但它不是所有消费面的万能 payload。

概念上区分：

```text
RuntimeState
├─ match context
├─ program-safe runtime data
│  ├─ map-scoped player stats accumulator
│  ├─ ActiveLineupResolution input seam
│  └─ Core-owned objective timing anchor (not wire state)
├─ assist-private runtime data
└─ operational health / incidents
```

不同消费面只通过自己的 Projection 获取数据：

```text
RuntimeState
├─ ProgramProjection
├─ RadarFrame
├─ OperatorProjection
├─ ObserverAssistProjection
└─ DebugProjection
```

规则：

- Projection 不能反向成为第二份 domain truth；
- Renderer 不读取整个 RuntimeState；
- ProgramProjection 不包含 Lookahead future 字段；
- Raw `allplayers` 只作为 telemetry observation 输入；Core 的 `ActiveLineupResolution` 负责确定稳定的 on-air 5+5 cohort，Program 不机械透传 raw collection；
- Steam64 是 player logical identity 与 map-scoped stats 的 key；observer slot、昵称和数组位置不能建立或分裂 identity；
- Stable membership 与 CT/T side assignment 分离；halftime / overtime 换边只更新 side，不重置同一 `mapEpoch` 的 logical participants；`allPlayers` absent 不产生 lineup transition；
- `lineupEvidence: retained` 只保留 membership/identity metadata，不复制缺失 entry 的上一帧 volatile telemetry；
- 只有 `allPlayers = present` 且能无歧义证明唯一 Steam64 的 5+5 才能建立或替换 stable baseline；`degraded` / `absent` evidence 不能建立“看起来干净”的新 baseline。same-map source generation 变化只更新 resolution cursor，不清除 stable membership；Program 只消费当前 generation 的 resolved lineup。
- map-scoped accumulator 由 `mapEpoch` 负责 reset。source gap/reconnect 只使无法证明的当前回合失效，不清除同一 map execution 已完成的统计；
- ADR 的 `liveAdr` 与 `completedAdr` 是同一 accumulator 的两个 pure read views；当前回合出现 `allPlayers != present` 时 invalidated，不得把有 evidence gap 的回合 finalize。
- DebugProjection 可以更宽，但不因此成为其它消费面的数据源；
- domain interpretation 在 Projection 结束，例如 `lifeState` 由 Core 统一推导，Renderer 不重复根据 HP 猜测。
- objective timing 的 overloaded GSI countdown 只在 Core 解释；Program 只消费短 lease 内的 semantic clock/action projection，Renderer 不保留 anchor 或猜测 explosion/defuse duration。

### 4.1 SeriesProgress 与本地恢复

`SeriesProgress` 是 Core-owned 的系列赛事实模型，表达地图计划与实际 execution 的绑定、已冻结地图结果、有限的 Round History 以及当前系列赛比分。它由 Companion 当前唯一的 runtime composition owner 持有，但不是第二份 `RuntimeState`、event journal 或赛事数据库。

接线边界固定为：

```text
RuntimeTransition + MatchContext + 当前已证明的 side mapping
                         ↓
                 Core SeriesProgress reducer
                         ↓
                    ProgramProjection
```

> **SeriesProgress 赛果 Ownership 规则**：`MatchContext` 可以在首次建立某场比赛的 `SeriesProgress` 时提供已完成地图的历史赛果作为初始化事实；但 `SeriesProgress` 已经建立并开始运行后，后续 map completion 只能由 Runtime transition、SeriesProgress reducer 与显式 operator evidence 推进。普通 `MatchContext` refresh（无论来自 stale、fresh、local 或 online）均不能作为第二个 mutable score owner 回写已运行或已冻结的地图结果。

`IdentityResolver`、`ActiveLineupResolution` 和 side-mapping 仍由既有 owner 维护；Series reducer 只接收同一 `sourceGeneration + mapEpoch` 的显式 proof，不复制这些状态。实际地图与计划不一致时保留原始 Program telemetry，Series binding fail closed 为 `needs_operator`，不猜 map slot 或 canonical series score。

连续运行时 `round_ended` 是 Round History 的 primary truth；后续 `map_round_wins` 只能恢复缺失历史、补充未知 `winCondition` 或做保守校验，不能覆盖已经冻结的 `winnerSide`。如果 snapshot 与 transition 冲突，保留 primary fact，并将 history 降级为 `partial`、留下 Operator diagnostic。兼容 checkpoint 加载后还必须把当前 GSI 的 `roundNumber`、CT/T score 和 `round_wins` 与已冻结 history 做一次 execution-state reconciliation；发现回退或矛盾时同样保留 checkpoint history 并降级，不把 schema compatibility 当作 execution compatibility。

Series checkpoint 是小型、有界、单文件的本地恢复事实，复用 Companion 现有 durable JSON 原子替换与串行提交队列。它按 `matchId + entrants + format + ordered canonical map plan fingerprint` 校验兼容性；不兼容时丢弃旧 checkpoint 并产生诊断。checkpoint 只在回合、地图绑定、地图结束、reset/restore、operator bind 或 Series completion 等业务边界写入，不按每帧 GSI 写盘。Companion shutdown 会先 quiesce Projection / ProgramCue owner，再 await ProgramRuntime checkpoint drain，因此最后一个已提交业务边界可以作为重启恢复的 durability contract。

Operator projection 暴露有界的 SeriesProgress binding、map status、score 与 issues；`POST
/operator/series/bind` 作为现有 OperatorCommand 的本地 ingress，不建立普通 Operator credential
机制，只接受 loopback bind 且 Origin 通过 local Web Origin policy 的写请求；LAN mode 一律拒绝
mutation。成功或拒绝都返回明确 acknowledgement。GSI 与 qualification-only 路径各自保留自己的
token 边界。

## 5. 状态、转换、命令与事件

系统不使用一个万能 Event 类型承载所有语义。

### 高频 Snapshot

位置、HP、金钱、时钟等使用：

```text
latest-wins
bounded
droppable / supersedable
```

旧 snapshot 没有补发价值。

### RuntimeTransition

表达 Runtime 观察到的明确边沿，例如回合、地图执行或关键比赛状态变化。Transition 用于 accumulator、场景建议、diagnostics 和 ReliableObservation 派生。

### OperatorCommand

表示制作人员的显式操作，需要 request identity 与结果。它不是 telemetry event。

### ReliableObservation

由 `RuntimeTransition` 与 transition-time context 派生。它不是把当前 RuntimeState 序列化后换个名字。

### Incident

表示错场、数据过期、序列异常、slow consumer 等运行问题，只用于 health、Operator、diagnostics 和日志。

## 6. 连续性模型

至少区分四个维度：

```text
liveSessionId
  一场比赛与 Mizar producer session 的绑定

producerInstanceId
  一次 Companion 运行实例

mapEpoch
  一张地图的一次实际执行

sourceGeneration / source sequence
  单个数据源自己的连接与读取连续性
```

不能用一个全局 `epoch` 或 `seq` 同时代表进程、比赛、地图和数据源。

Program GSI、可选 Program 事件数据源与 Lookahead 数据源各自维护连接连续性。任一数据源的 generation 改变时，只使依赖该数据源的连续性证明失效；Program 事件增强数据源重连不推进 Program `mapEpoch`，Lookahead 重连也不会自动推进 Program 的 `mapEpoch`。

## 7. Program 与 Observer Assist 隔离

当前完美平台 V1 的 Program 主数据链路是：

```text
延迟直连 GOTV
  → 真实 CS2 观战客户端
  → GSI
  → Program-safe Runtime
  → ProgramProjection / RadarFrame
  → Program Renderer
  → Program Host / OBS
```

精确 GameEvent 是独立、可选的 Program 增强能力：

```text
可选 Program 事件数据源
  → GameEventObservation<'program'>
  → ProgramCueCoordinator
  → program-cue 短时通道
  → ProgramCueClient
  → Renderer 本地短时特效
```

当前 `cs2parser + HttpBroadcastReader` 只适用于真正提供 HTTP Broadcast URL 的数据源；直连 GOTV 的 `connect IP:port` 不能当作 HTTP URL。精确事件增强不可用时，Program / Radar 继续由 GSI 正常工作，武器类型专属命中特效等精确短时增强保守降级。

```text
Lookahead 数据源
  → Assist 私有证据
  → 时间轴对齐
  → ObserverAssistProjection
  → 私有 Assist Renderer / Host
```

无头 Direct CSTV 客户端后续在新的独立仓库研发；本仓只保留 Lookahead 接入、时间轴对齐和 Observer Assist 上层语义。

具体运行方案与降级矩阵见 `docs/data-source-capabilities.md`。

硬约束：

- Lookahead 不能作为 Program 的备用数据源；
- Lookahead 故障只降级 Assist；
- Program 故障不会自动切换到 Lookahead；
- 未来信息不能先进入 Program，再靠 CSS、窗口层级或 OBS 裁剪隐藏；
- Program 与 Assist 可以使用不同 Host，但数据安全由 Projection / schema 保证。

观察辅助可以由透明置顶窗口承载，也可以放在制播工作区的私有区域；Host 技术不改变这一边界。

## 8. Radar 边界

`packages/radar` 拥有：

- `RadarFrame`；
- world → radar 坐标变换；
- `MapGeometryProvider`；
- floor selection；
- marker / utility semantics；
- 与时间无关、可确定性验证的几何和 domain 计算；
- 供 LiveSnapshot 使用的无状态公共归一化 overview projection 与楼层选择，复用同一 geometry/calibration；外部 renderer 无需 world calibration。

`apps/web` 的 Radar Renderer 拥有：

- React / SVG / Canvas / DOM；
- CSS 和 theme；
- `requestAnimationFrame` scheduling；
- temporal interpolation / smoothing；
- teleport / discontinuity reset；
- autozoom / crop 的 presentation state 与动画；
- OBS / browser Host 的 rendering adaptation。

LiveSnapshot 的 Round History 直接来自 Program/SeriesProgress 当前有界 context；公共 Radar 只消费与 Program 同代际、同 mapEpoch 与当前 receive sequence 的 RadarFrame，invalid/stale 时明确 unavailable。HTTP live sink 默认包含合法当前 Radar。Snapshot 不持久化历史、不含 Lookahead，consumer 只拥有最终渲染与 interpolation。

地图几何作为 provider 输入 Radar domain。第三方地图包可以作为 reference 或 adapter source，但不能成为 Mizar Radar contract 的 shape owner。

## 9. Local Protocol 与 delivery

本地 WebSocket 使用独立 channel：

```text
program
radar
operator
assist
program-cue (transient, Program-only)
```

Snapshot channel 与 `program-cue` transient channel 各自有 schema version、publisher 和 acceptance
state。Program cue 只来自 Program role 的精确事件数据源；该数据源属于可选增强，不是 Program 是否正常的判断前提。cue 不进入 snapshot `LocalChannelStore`，也不共享 Lookahead 数据源或通用事件总线。protocol version 与 channel schema version 分离，因此单个 payload
演进不要求整个 Local Protocol 同步升级。

HUD 配置属于独立的 presentation control-plane，不是 Local Protocol channel，也不修改
`ProgramSnapshot` schema。`packages/hud-config` 定义并解析 `HudPreset`、`HudLayout`、`HudTheme` 和
组件 registry；Companion 将 `/local/v1/hud-config` 作为只读的 Program/on-air read model，将
`/operator/hud-config` 作为保存文档的 editor read model。两者各自拥有覆盖完整 HTTP representation 的
ETag/revision；保存资源不会改变正式节目的 ETag，只有启用 preset 才会冻结新的 resolved snapshot。Web
编辑器通过仅限 loopback 且要求 valid local Origin 的本地 HTTP mutation 保存资源或启用 preset；LAN
mode 下该 endpoint 只读，任何 mutation 都会拒绝。当前版本 custom snapshot 在重启和 recipe 升级后仍保持最后
一次上屏内容，直到重新启用，built-in reference 则解析当前代码版本。配置读取/解析失败保留
last-known-valid runtime，不让 HUD 配置故障伪造或中断 Gameplay telemetry。1.0 前不保留旧版本兼容；resolved v2 必须完整，拒绝旧版本与缺失设置，不加载时套用当前默认值。

连接建立后立即发送当前 baseline；断线重连重新取得 current baseline，不补发历史 snapshot。

每个 consumer 的发送状态保持常数级：

```text
in-flight
+ latest pending
```

新 snapshot 覆盖旧 pending snapshot。slow consumer 不能让内存 queue 随运行时间增长。

Transient cue 不使用 latest-wins 覆盖：每个 subscriber 保留 1 个 in-flight、最多 32 个 pending cue
FIFO 和 1 个 pending reset barrier。旧 pending cue 可因 overflow 或超过 1000 ms monotonic delivery
age 丢弃；baseline/reset 会清空旧上下文。断线、刷新或 reset 不补播历史 cue，Renderer TTL 不属于
Core 或 wire。

## 10. 本地安全

默认网络边界：

```text
bind = 127.0.0.1
```

非 loopback 监听必须显式开启，并配置精确 Origin allowlist。

凭据分离与本地写入边界：

```text
GSI token
!= qualification-only token
!= RivalHub producer credential

normal local mutation = loopback bind + valid local Origin
LAN mutation = denied
```

Local WebSocket 校验 Origin 与 subprotocol；只读 snapshot channel 不接受浏览器业务消息。日志、fixture 和导出文件不得包含不必要的 token 或个人数据。

## 11. Capture、Replay 与测试

真实输入通过 production ingress 同时进入 capture 与 Runtime processing：

```text
Raw input
├─→ bounded Capture Recorder
└─→ production adapter → Runtime
```

capture 写盘失败不能阻塞 GSI request hot path。`packages/testkit` 消费保存的输入进行 replay、加速、drop、duplicate、reorder、disconnect 和 slow-consumer 测试。

真实 production evidence 优先于 synthetic fixture；fixture 用于可重复边界条件，不用于证明真实 CS2 source behavior。

## 12. 扩展规则

新增能力优先使用现有 owner：

- 新赛事上下文来源 → adapter；
- 新 CSTV / telemetry provider → source adapter；
- 新显示形态 → 现有 Projection 的新 Host / Renderer；
- 新节目数据 → 先判断是否属于 Core、Radar、Program 或 Assist；
- 新可靠上行 → 独立 reliable message，不把 snapshot 改成 FIFO。

只有出现第二个真实 consumer、真实 provider 或独立发行需求，并且现有边界造成明确摩擦时，才增加新的 public abstraction 或物理拆分。

## Desktop Preparation 与窗口生命周期（#94）

Companion 是本地制作控制面的唯一运行事实 owner。它提供当前能力摘要、制作生命周期 revision、ActiveLineup 派生的名单候选、OBS 当前 Program 低频缩略图和独立桌面显隐策略。高频状态仍走现有 Local Protocol projection；新增 HTTP view 只组合 owner 已有事实，不增加第二份 `RuntimeState`。

`preparation | live | hidden` 仅描述当前桌面展示生命周期，不是比赛、Runtime 或 OBS 状态。对 enter/hide/finish 的写入使用 revision CAS 和本地 Origin policy；进入需要当前比赛上下文。结束先请求等待场景，再释放 RivalHub 当前 source；失败保留 live/hidden 供重试，全部成功才进入 preparation。本地赛事数据始终保留。Tauri 只拥有窗口可见性、布局、焦点和工具窗口，不推导比赛资格或名单身份。

Preparation 当前比赛统一消费 `/local/v1/match-document` envelope；`/local/v1/tournament` 承接本地资产库、赛程邻域和 mutation 所需元数据。工具界面使用无 Main 导航的 ToolShell；独立 Preview 只渲染 Program scene。Host 在布置前重新发现 CS2，窗口或显示器变化后重选 work area。OBS readiness 由 Companion 组合 adapter 的连接、findings 与当前 scene 对齐事实。

名单候选由 Companion 从当前 fresh Program-safe observation 与 ActiveLineup 构造，不接受浏览器提交的玩家身份。候选 revision 覆盖 context revision、source generation、map epoch 和观测成员；LocalTournamentStore 在原子文件替换前执行同步 continuity guard。服务器队名或现存规范 roster 可证明 CT/T 映射时自动映射，否则由操作者一次确认。保存合并既有玩家记录并保留替补。

本机 HUD policy 是单独的 host display preference，只接受 HUD registry 中已有 widget id；不复制 preset/layout/theme，也不改 OBS Program composition。Tauri Overlay 仅在显式 `host=desktop` 时读取此策略并覆盖本机 renderer 可见性，初始化前保持隐藏。OBS confidence 使用 Companion 已配置连接，以限尺寸 JPEG 读取当前 Program Scene 并复核场景未切换；它是低频信心视图，不承担实时监看。

## BP presentation

Core `projectBp` 从 canonical MatchContext 的 maps/veto 派生最多 7 张地图卡和 14 个 reveal step；选图与选边分别表达，决胜图不归 entrant。`sideChoice` 保留真正执行 SIDE_PICK 的队伍；只有 `teamAStartSide` 不足以生成选边行，BO5 决胜图不显示选边。`ProjectionCoordinator` 在身份 mismatch 或 BP 数据冲突时 fail closed。Companion 内存 `BpSession` 仅拥有播放状态，使用 monotonic clock 推进；Web 共用 `BpPresentation`，由 `/program/bp` 全屏不透明场景和 `/operator/bp` 预览承载。制作首页提供播放/收起。

RivalHub 已绑定的 Manifest 继续沿用 MatchContextController 与现有本机 LKG store，并更新同一个 ProjectionCoordinator/SeriesProgress。独立模式的比赛和 BP 保存在 Mizar 本机赛事库；现有 BP consumer 读取临时 BroadcastManifest 兼容视图，不建立第二份 BP truth。在线比赛的本地 BP 补录仍使用既有 bound-overlay LKG，不能修改 canonical metadata。`standalone | bound-overlay` provenance 属于 MatchContextBinding acquisition metadata，不进入 MatchContext domain。服务重启按本地显式选择时间与在线 LKG 保存时间恢复最后选中的来源，BP 播放会话从 hidden 开始。活动 binding selection 与在线 candidate acquisition 分开管理 generation；候选失败刷新保留已验证候选，只有新的有效候选才替换它。

## 设计系统职责

`packages/design-tokens` 管理静态 CSS，JSON 是视觉值的唯一源文件，包没有运行时依赖。Web `ui/` 使用用途/组件变量，负责控件样式、无障碍和交互；`patterns/` 组合基础组件；功能页面读取既有业务领域模块，负责布局与组合，不把比赛、运行时或 RivalHub 的业务事实引入基础组件和组合组件。架构检查覆盖依赖方向、变量声明来源、生成物漂移和新增页面主题；历史 CSS 使用精确迁移清单。三类界面与播出渲染例外见 [设计系统](design/README.md) 和 ADR-0012。
