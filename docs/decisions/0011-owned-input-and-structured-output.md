# ADR-0011：Mizar 自有输入与结构化实时输出

状态：Accepted（Issue #89、#95）

## 决策

- `MatchDocumentV1` 与 `ScheduleWindowV1` 由 Mizar 定义并版本化。Local 与 RivalHub 是同级 provider；RivalHub 公开 DTO 经 adapter 转换后才进入共享领域模型。来源、revision、新鲜度、诊断留在 acquisition envelope。
- 独立模式由 Companion 持久化本机赛事、可复用队伍、比赛和赛程顺序。比赛可无 BP、名单或计划时间先创建。旧 standalone BP Manifest 只迁移一次；现有 BP consumer 所需 Manifest 是临时兼容视图，不反向决定本地存储 schema。在线 authority 和人工切换规则保持有效。
- `LiveSnapshotV1` 是 Program-safe 最新值，来自 Program 与同代际 Radar projection，经严格公开 schema 校验；每个消费者只保留一个待发送值。它不是新的 RuntimeState，也不能携带 Lookahead 或 Assist。
- `ReliableEventV1` 是 transition-time 的有限边沿记录。Companion 持久化有界 outbox，使用确定性幂等键、退避、过期和状态记录。外部 sink 是注入边界；Mizar 不因此建立云端数据库或 RivalHub 写入路径。
- 可靠事件重试必须验证当前比赛、context revision、producer、session、source generation 和 map epoch。身份或遥测不足时暂停高影响事件；上下文变化后旧事件被 supersede，不在恢复后静默执行。

## 原因与边界

本机赛事输入不能依赖 RivalHub wire shape，否则独立模式会继承在线提供方的字段、BP 前置条件和所有权。公开输出也不能直接透传 RuntimeState，因为其中包含消费者不该依赖的内部状态，且 Assist 与 Program 有不同安全边界。高频状态与可靠边沿采用不同交付语义，才能同时限制内存增长和保留关键证据。

RivalHub 仍拥有其官方赛事事实；Mizar 只拥有本地赛事事实、实时 observation 和自己的投递记录。外部消费端自行决定是否采纳 observation，并按幂等键去重。真实 Windows/CS2/OBS 现场接受度需 exact-revision 实机证据，自动测试只证明契约、恢复和本机路径。
