# 协议与本地数据契约

本文记录当前有效的三类协议边界：

1. Mizar 从赛事上下文提供方读取的比赛只读契约；
2. Companion 向本地 Program、Radar、Operator 和 Assist 提供的 WebSocket 快照协议；
3. Companion 向 Program 提供的短生命周期 transient cue 协议。

协议字段与精确字符串以代码 schema 为最终机器来源；本文负责解释语义、ownership 和兼容规则。

## Desktop Preparation 控制面（#94）

Companion 提供：`GET /local/v1/readiness` 汇总现有 projection、SceneController 与 OBS adapter 能力；OBS 要求连接、当前场景对齐和配置 findings 为空，未检查时返回检查提示；`action` 仅在需要下一步操作时提供。`GET /local/v1/production` 返回桌面表现模式与 CAS revision，`POST /operator/production` 接受 `enter | hide | finish`；finish 先切等待场景再 release，失败保持 live/hidden 供重试。`GET /local/v1/roster-candidate` 返回当前安全名单候选与精确队名/完整 Steam64 命中的本地队伍选项；`POST /operator/local-match/capture` 与 `/operator/local-match/create-from-server` 只接受候选 revision、context revision、source generation、map epoch、必要的赛制/侧别确认和显式复用的 teamAId/teamBId。服务端忽略客户端玩家列表，并在 store 原子替换前重新核验候选；候选 revision 包含相关队伍模板，写入后激活只重验 observation/context continuity，避免本次模板更新使自身失效。

`GET /local/v1/desktop-overlay` 与 `POST /operator/desktop-overlay` 保存本机 host policy，widget id 限定在 `HUD_WIDGET_REGISTRY`，策略与 preset/layout/theme 分离。`GET /local/v1/obs/confidence` 为当前 OBS Program Scene 返回限尺寸 JPEG 缩略图；同一请求期间画面切场即返回空结果。以上修改路由均受 loopback + 有效本机 Origin policy 保护，RivalHub credential、GSI token 和安装记录不进入浏览器响应。Companion 不可用时，Desktop UI 显示未连接，不在浏览器另存比赛真相。

## Program Scene 与 Workspace 控制面

`packages/protocol/src/program-scenes.ts` 是场景 ID、顺序、中文名称、路径和 composition mode 的唯一 registry。Companion 的 `GET /local/v1/program-scenes` 返回当前 scene、revision、可用 scene 和阻断原因；`POST /operator/program-scene` 使用预期 revision 切换。Workspace 只提交意图，Companion 基于当前 Program/Operator/BP projection 校验并协调 OBS，OBS Browser Source 使用相同 registry 中的路径。Tauri 仅控制本机窗口，不拥有场景真值。

`program-scenes` 另带 `director` 状态：自动、手动保持、阻断或准备，以及下一场景、阻断原因、Intro 时长和本场景已播放的单调时长。`POST /operator/program-director` 接受 `{action: "resume", expectedRevision}`，仍使用 loopback + Origin + revision CAS。`program-scenes.v1` 增加可选 `preparing: {target, revision}`，仅在切场中存在，供开场 renderer 准备展示；`active` 与主 revision 仍在 OBS 完成后提交，提交沿用准备 revision，失败清除准备。该字段不改变四个高频通道。手动 Take 立即取消在途自动转场等待并使请求失效；自动请求也走同一个 controller 和 OBS adapter，失败不自动重试。

`GET /local/v1/program-presentation` 返回严格 `mizar.program-presentation.v1`：内置节目包 ID、赛事/Series 安全展示、半场摘要、最多五张地图结束快照和可用的前后赛程卡。选手只含展示标识、昵称、头像及可空 K/A/D；快照带捕获 cursor。没有 Operator、Lookahead、Raw GSI 或完整 MatchDocument。静态 renderer 断流保留最后安全值，服务端换比赛/上下文后清除；这是展示缓存，不是赛果 owner。`matchup` 使用 Gameplay overlay；`halftime` 使用全屏 composition。

在线比赛入口先按受限 `matchId` 通过配置的只读 HTTPS Manifest URL 获取候选，再走现有 MatchContext 验证、人工确认和 LKG。刷新失败将当前在线来源标记 stale，不清除已确认上下文；本地模式无需在线凭据。OBS 状态与检查/修复通过 Companion 本地控制面提供，密钥不进入浏览器返回值。

## Mizar-owned 输入与结构化输出 V1

`packages/protocol/src/context.ts` 定义 `mizar.match-document.v1` 和 `mizar.schedule-window.v1`。比赛文档包含稳定比赛/参赛 ID、赛事、状态、BO、阶段、可选轮次与语义标签、计划/实际时间、名单、地图池、地图结果、veto 和解说。BP、名单、图片和计划时间可渐进填写；未知值使用 `null` 或空数组。赛程窗口包含有序比赛摘要，Local 未设置时间时 `from/to` 为 `null`，不以占位时间冒充赛程。来源、revision、freshness 和 diagnostics 属于 acquisition envelope，不进入文档事实。

RivalHub 通过版本化 Match/Schedule read API 提供赛事 Logo、地图池、阶段 key 与正式比赛资料；adapter 对缺失 Logo 映射为 `null`、缺失完整地图池映射为 `[]`，不从 maps/veto 反推赛事地图池，并接受以后增补的公开字段。Mizar V1 competition 不含 provider slug；`stage` 是唯一阶段标识，`stageLabel` 是显示名称。旧 RivalHub stage 无独立 key 时沿用其值，不能从中文标签推断规则。旧 Program channel 与 BP Manifest 所需 slug 仅在兼容视图填充。

当前来源的统一比赛文档通过 `GET /local/v1/match-document` 返回 acquisition envelope。独立模式通过 `GET /local/v1/tournament` 读取赛事、队伍、比赛、当前选择和赛程邻域；`POST /operator/local-match/create|select|save`、`POST /operator/local-event/save`、`POST /operator/local-schedule/reorder` 修改本机状态。创建比赛只要求队名与 BO；复用队伍通过稳定 teamId 显式选择，不根据同名猜测身份。图片上传到 `/operator/local-asset`，只接受限大小的 PNG/JPEG/WebP，本机 URL 可从 `/local/v1/local-assets/:filename` 读取。LocalTeam 是可复用创建模板：保存比赛中的队伍/名单会更新模板用于以后创建，已有其他比赛的快照保持稳定。整个持久文件使用 strict schema、大小/数量限制和 event/match/team 引用校验。所有写入受本机 origin policy 约束，比赛保存还必须带当前 context revision。RivalHub DTO 在公开 adapter 边界转成相同文档，旧 standalone BP 缓存在首次恢复时迁移；重启按本地显式选择时间与在线 LKG 保存时间恢复最后选中的来源。

`packages/protocol/src/output.ts` 定义 `mizar.live-snapshot.v1` 与 `mizar.reliable-event.v1`。`GET /local/v1/live-snapshot` 返回当前公开状态，可用 `?radar=1` 请求同代际雷达切片；无新鲜匹配上下文时返回 503。进程内 consumer 使用 latest-wins 有界 lane，重连只取得当前值。快照只复制 Program 与同代际 Radar 允许字段，不承载 Raw GSI、Assist 或整个 RuntimeState。

### LiveSnapshot V1 public realtime surface

LiveSnapshot V1 已覆盖 RivalHub 第一版 public LIVE 所需的 Program-safe realtime surface；后续破坏性字段变化必须升级 schema version。本次补齐发生在 Mizar 1.0 对外 contract freeze 前，继续使用 `mizar.live-snapshot.v1`。严格 schema、TypeScript type、parser 和 checked-in fixture 一同维护。

`roundHistory: null | { mapOrder, completeness, rounds[] }` 直接复制 `ProgramProjection.series.roundHistory`，每项保留 `roundNumber / winnerSide / winnerEntryId / winCondition`。`complete / partial / unavailable` 原样表达；SeriesProgress 负责换边、加时、map/source/session continuity 与有限历史恢复，输出端和 consumer 不根据比分补猜历史。这是当前 Program projection 的 bounded context，不是 snapshot history；LiveSnapshot 不持久化、不建立 queue/history，不含 Lookahead。

公共 `radar` 使用 `@mizar/radar` 的无状态 `projectPublicRadarFrame`，只接受与 Program 同一 producer、session、source generation、mapEpoch、receive sequence 和地图的新鲜 RadarFrame。`capability.radarCurrent` 表示当前 Radar 已通过 geometry 与公开 schema 校验；即使本机读取省略 Radar，也保留此能力状态。Radar stale、错场、代际不一致、地图不支持或 Radar contract 超限时，`radar = null`、`radarCurrent = false`，其它 LiveSnapshot 字段继续工作。

公共 Radar 包含：

- `mapName`：geometry provider 的 canonical map key；`calibrationRevision`：Mizar calibration revision。
- `layers`：`[single]` 或 `[upper, lower]`；`activeLayer`：当前观察选手所在层，否则沿用现有存活选手多数层规则，无法确定时为 `null`。
- `players[]`：`sourcePlayerId / canonicalPlayerId / side / lifeState / position / facing`。canonical identity 只从同帧 Program 中稳定的 canonical mapping 关联，无法证明时为 `null`。
- `bomb: null | { position }`：当前 C4 位置，状态与 carrier 仍读取 snapshot 顶层 `bomb`。
- `utility[]`：`sourceEntityId / kind / ownerSourceId / position / lifetimeSeconds / effectTimeSeconds / flames[]`；flame 保留 `sourceFlameId / position`。时间值是当前 telemetry 已归一化的生命周期证据，缺失为 `null`，不从速度或 renderer history 猜测 phase、剩余寿命或烟雾持续时间。inferno 没有 entity 位置时仍可通过 flames 表达燃烧区域。

`position: null | { x, y, layer }` 的 x/y 是完成 world → overview calibration 后的归一化坐标，x 从左到右、y 从上到下，范围 `[0,1]`。单层及 upper/lower 共用相同 overview transform；consumer 按自己的显示尺寸缩放，不需要 world calibration。out-of-bounds、位置缺失或 unknown layer 为 `position = null`；无效 flame 省略，不 clamp 或使用上一帧位置。`facing: null | { x, y }` 是 overview image axes 的单位方向向量（向右为 +x、向下为 +y），只有当前 alive 且 forward 可证明时提供。dead/unknown 不补朝向。

Mizar owns world → radar projection/calibration；external consumer owns final visual rendering/interpolation。公共 Radar 不携带 world x/y/z、速度、轨迹、smoothing、烟雾历史 anchor 或 renderer 动画状态。输入来自 Delayed Program feed → ProgramProjection / Radar；Lookahead / Observer Assist / future event 永不进入公共字段。

Payload 由 `parseLiveSnapshotV1` 施加 **256 KiB UTF-8 JSON hard bound**（包含字符串转义后的真实 bytes）。集合同时有严格上限：Round History 256、顶层/雷达选手各 64、utility 128、单 utility flames 64、整帧 flames 512；ID/地图/校准/kind 字符串至多 128，显示名 256，producedAt 64。坐标和 facing 有限且有范围；utility 时间值限制在非负 safe integer 数值范围，计数限制为非负 safe integer，其它 clock 数值必须有限；未知 nested 字段拒绝。数量/字符串上限不取代 hard byte guard，合法形状累计超出 bytes 上限同样拒绝，producer drop 当前 snapshot，不进入可靠 outbox。

四个 Mizar-owned V1 payload 都使用严格 schema 和大小上限；未知字段或不支持的 `schemaVersion` 拒绝。发布者不能在同一版本加入接收方未声明的字段；将来可选 enrichment 必须先进入明确的新版本契约和 fixture，破坏字段语义或移除字段同样升级版本。输入文档、赛程、快照和事件分别演进，不联动 Local Protocol channel version。

可靠事件包含 kind、幂等键、transition-time UTC、producer/session/source generation/map epoch cursor、比赛和参赛身份、context revision、证据与有限比分。事件种类为 `match_started`、`map_started`、`map_ended`、`series_ended`、`source_generation_changed`、`map_epoch_changed`、`identity_mismatch`、`lineup_mismatch`。Companion 将事件放入有界持久 outbox；注入的外部 sink 回报 `accepted/rejected/retry`，重试有退避和 24 小时过期。比赛、context revision、session、source generation 或 map epoch 改变即终止旧事件重试；高影响事件要求当前新鲜且 identity matched。outbox 原子保存投递连续性检查点，生产进程使用独立随机 session。相同比赛/revision 在 24 小时内重启时只恢复 session/source generation/map epoch/map name，不恢复 telemetry、receive sequence、Runtime sequence、统计或 monotonic clock。新进程 producer 始终不同，旧事件 producer 和幂等键保持不变；发送等待新遥测，终图事件还需 gameover/map identity、最终 CT/T source score 与同一 mapEpoch 的 SeriesProgress entrant-relative A/B final score 一致。无兼容检查点时不跨进程重试。缺失新鲜上下文只暂停，明确不兼容身份才 supersede。`GET /local/v1/reliable-output-status` 只展示本机投递状态，不暴露完整事件。外部消费者必须按幂等键去重，不能把 Mizar observation 当成官方赛果。

ReliableEvent 的 payload 按 kind 严格区分：开始事件为空对象；`map_ended` 同时包含 `scoreA / scoreB` 与 `scoreCT / scoreT`，其中 A/B 是 CompetitionEntry-relative 的最终地图结果，直接取同一 `mapEpoch` 已冻结的 SeriesProgress `finalScore`，CT/T 只保留 transition-time source evidence；`series_ended` 只有系列 A/B 比分；source/map continuity 分别包含 previousSourceGeneration 或 previousMapEpoch/reason；identity/lineup warning 只有 reason。`map_ended` 在 SeriesProgress 尚未证明 completed map 与 entrant-relative final score 时 fail closed，不要求 consumer 读取 LiveSnapshot、根据起始边或半场/加时换边自行重算。BO1/BO3/BO5 的换边与加时都由 producer 侧 SeriesProgress/side proof 归一化。每个有新鲜匹配遥测证据的 map execution 产生一次 map_started，显式 reset 后等待新的遥测。

### HTTP outbound reference

生产启动可配置 `MIZAR_LIVE_OUTPUT_URL`、`MIZAR_RELIABLE_OUTPUT_URL` 和 `MIZAR_OUTPUT_TOKEN`。两个 URL 独立可选，启用任一个必须同时提供 token。只接受无内嵌凭据的 HTTPS，禁止重定向；Bearer token 仅由 Companion adapter 使用，不进入浏览器或 Core。每次 POST 的 body 是对应 Mizar V1 payload；`MIZAR_LIVE_OUTPUT_URL` 默认发送包含合法当前 Radar 的完整 LiveSnapshot（本机 GET 仍可用 `?radar=1` 选择 Radar）。可靠事件携带 `Idempotency-Key`。

2xx 表示 accepted；408/429/5xx、网络失败和超时表示 retry；其他状态表示 rejected。请求在 4 秒后 Abort，可靠 outbox 另有 5 秒保护。Snapshot 失败只记录诊断并丢弃；lane 保留一个 in-flight 和一个最新待发值，实际发送前重新检查当前 scope 和 freshness，使用当前值。未配置 endpoint 时维持本地读取和投递状态。RivalHub 连接由 Companion 保存赛事级凭据，制作准备中心负责配对、赛程浏览、比赛选择与上下文核对加载，现场工作区按规则自动认领或由制作人员显式接管活跃数据源；可靠事件携带当前 authority revision 与首发观察证据。云端 Snapshot 以最多每秒两帧发送最新值，数据持续更新时每秒至少提供一个新观众基线；离线或缺少有效证据时不上传。

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

`POST` 只接受 `save-resource`、`save-as`、`activate-preset` 和 `import-preset-pack` 四类明确命令。正常 Operator ingress
不接受 Operator token、Bearer credential 或其他普通凭据；写操作只允许 Companion 以 loopback bind
接收，且请求必须通过 valid local Origin；`LOCAL_WEB_LAN_MODE=1` 时 control-plane 保持 read-only，即使 Origin 在 LAN allowlist 中也
必须拒绝 mutation。GSI ingress 继续使用独立的 `GSI_TOKEN`，qualification-only control plane
继续使用独立的 `QUALIFICATION_CONTROL_TOKEN`。mutation response 必须返回本次 command 的明确
`resourceId` / `sourceId`，客户端不得从前后资源 ID 集合差推断本次创建的资源。内置 `builtin:*` 资源只读；
配置文件由 Companion 以同目录临时文件加原子 rename 保存。`HudResolvedPreset` activation snapshot 有独立的 v3
compatibility boundary：严格校验 schema version、exact widget keys、嵌入布局、preset/layout/theme
引用一致性、descriptor-owned settings，以及颜色、透明度、圆角和字体等 semantic value 的安全域；
加载时不得通过当前 Theme recipe 重算并要求 canonical bytes 相同。recipe 变化不会改写旧 custom
snapshot，重新 Activate 才产生当前 recipe 的新 snapshot。1.0 发布前不保留旧版本兼容，旧 resolved 版本直接拒绝，不提供 migration；当前 resolved settings 必须完整，不读取时补默认值。该 control-plane 的版本与 Local Protocol / channel schema 版本独立。

`import-preset-pack` 提交 `{ kind, value: HudPresetPack, expectedEditorRevision }`，复用同一 loopback/Origin/CAS 边界。`value` 使用 `format: "mizar-hud-preset"`、`formatVersion: 1`，包含完整 `preset`、`layout`、`theme`，最多 256 KiB UTF-8 JSON；未知字段、组件方案、recipe、版本及不一致引用拒绝。成功一次性保存三个新 ID 并重写引用，response 的 `command` 返回 `resource: "preset"` 与新 `resourceId`，on-air snapshot/ETag 保持不变；持久化失败或 revision 冲突不留下部分资源。外部预设文件不成为新网络通道，不允许脚本、CSS、素材 URL 或比赛数据注入。

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

`POST /operator/bp-local-save` 接收 `{draft: LocalBpDraft, expectedContextRevision}`，请求体最多 65,536 bytes。Companion 校验结构化输入、按固定赛制生成 veto sequence，并通过现有 validator、MatchContextController 与 ProjectionCoordinator。独立模式将 BP 写回 Mizar 本机 MatchDocument；旧 standalone BP Manifest 首次恢复时迁移。在线或 cache-online 比赛的 `bound-overlay` 只补 BP，沿用 canonical match、competition、entrant、roster 和 commentator 元数据，拒绝更改这些字段并保留已完成地图；这类覆盖仍保存在原 LKG。`localAuthoringMode` 是 MatchContextBinding acquisition metadata，不进入 MatchContext domain。旧 v1 local cache 没有 provenance 时按 `bound-overlay` 恢复以维持 fail-closed。保存前不清除当前 binding；校验、revision、身份或原子持久化失败时旧 binding 保持有效。成功后来源成为 `local`，播放 session 回到 hidden。

`POST /operator/bp-rivalhub` 接收 `{expectedContextRevision, expectedPendingRevision}`，只确认切换到 MatchContextController 已暂存的 online candidate，不负责获取网络数据。活动 binding 生命周期与 online candidate acquisition generation 独立：开始 refresh 不清除已有有效 candidate；较新的失败请求保留它，较新的有效请求才原子替换它。本地保存成功或失败都不清除 candidate。激活必须同时匹配 `expectedContextRevision` 与 `expectedPendingRevision`；候选获取在激活期间推进时，旧激活不能清除更新候选。当前 RivalHub `main` 没有正式 BroadcastManifest HTTP endpoint；未来接入必须复用 shared controller。online candidate 恢复时不会自动覆盖 local 或 cached-from-local 比赛，只有制作人员显式确认后才切换并更新 LKG。

以上写入口仅允许 loopback 与有效 Origin；LAN 模式拒绝写入。旧 context revision 返回 409，不自动重试或排队。生产 `match-context.json` LKG 在重启后恢复比赛上下文并标记为 `cache`，BP playback session 仍从 hidden 开始。

### 本机制作提示

`GET /local/v1/production-guidance` 为私有、只读、no-store 的本机展示响应，包含当前任务、阶段、地图结果、下一图、图间软提醒和安全的 RivalHub 工作台链接。Bilibili 状态由 Companion 独立 best-effort 查询，仅为本机 UI 使用；失败为 unknown，不进入公开 LiveSnapshot / ReliableEvent 或制作门禁。字段类型见 `ProductionGuidance`，语义见 ADR-0019。


### Program v8：站立 C4 预测

`bombDamage` 为 required、有界最多 10 人的 Program-safe derived projection，含 available/unavailable、reason、模型版本与资源 SHA-256、逐人 predicted/unavailable。predicted 保留 standing、damage、hpAfter、lethal、assumptions 与 unknownInputs。只允许当前 Program accepted cursor 的 fresh 同图同代数据；不带 Lookahead。失效时显式 unavailable；真实 player.health 不变。HUD resolved v3 增加 showBombPrediction 与独立 series-overview 组件。
