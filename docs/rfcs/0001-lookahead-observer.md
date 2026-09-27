# RFC-0001：Lookahead Observer / Observer Assist

| 字段 | 值 |
| --- | --- |
| 状态 | Draft |
| 主题 | 较早比赛时间轴、对齐、未来击杀提示、私有制播工作区 |
| 需要真实验证 | Windows + CS2 + 完美平台直连 CSTV + OBS |

## 摘要

Lookahead 利用两个存在时间差的比赛时间轴：较早时间轴上的事件已经真实发生，但延迟 Program 尚未到达。Broadcast 将这种时间优势转换成低干扰的私有提示，帮助同一名解说兼 OB 提前准备切 POV。

这不是 AI 预测未来，也不宣称 delayed observer cue 概念首创。HOT / HLAE Observer Tools 已公开实现 Delayed Observer Cues，是重要 prior art。

## 产品问题

人工 Observer 的困难不是“缺少更多统计”，而是常常在 kill feed 出现后才知道该切谁。一个有用的第一层提示只需要回答：

```text
+5.2s
playerA → playerB
```

系统负责给人反应时间；人继续决定是否切 killer、victim 或保持当前故事。

## 产品边界

### 目标

- 提前显示下一次可靠 future kill cue；
- cue 至少包含 countdown、killer、victim；
- location 只在可靠时显示；
- 只运行一个真正承担 Program rendering 的 CS2 observer；
- 用 match / map / tick relation 建立 alignment；
- Program 与 Assist projection-level non-leak；
- source reconnect 后默认关闭旧 cue，直到重新建立 alignment；
- 提前量可配置。

### 非目标

第一层产品不要求：

- AI / LLM camera model；
- full-auto observer；
- 自动 TAKE；
- execute / engagement classification；
- importance ranking；
- Future Radar；
- 第二个完整 CS2 renderer；
- server plugin 前置依赖；
- 自动 replay / highlight。

## 现有先例：HOT

HOT 证明两件事：

1. CS2 可以作为 Observer Desk / Workspace 中的主要 viewport，而不是唯一全屏界面；
2. 较早 publisher 向 delayed observer 提供 cue timeline 是真实可用的产品模式。

Broadcast 借鉴的是产品范式，不复制 HOT 的具体布局或 injection 技术。

Broadcast 的差异化组合是：

```text
无头无延迟数据源
+ 显式时间轴对齐
+ Program / Assist 硬隔离
+ 单 Program 渲染流程
+ 本地优先的独立模式
+ 可选 RivalHub canonical 赛事上下文
```

## 产品承载方式

Observer Assist 不锁死为 Overlay-only。

```text
ObserverAssistProjection
  ├─ transparent/topmost Assist window
  └─ private Broadcast Workspace region
```

制播工作区中，CS2 Program 画面应保持视觉主体，外围只放真正降低切镜成本的信息。

第一层不做两套 Radar。推荐信息架构：

```text
ONE Program Radar
+
low-bandwidth future event cue
```

如果真实使用证明 spatial future cue 有价值，再研究同一 Radar 上极轻量、可关闭的 future marker。

## 概念模型

```text
SourceTimeline
- source role
- match / map identity
- generation
- tick
- observedAt

TimelineAlignment
- lookahead tick
- program tick
- estimated gap
- health / confidence

FutureKillCue
- event tick
- killer
- victim
- optional reliable location
- desired lead
- source evidence
```

Future cue 不建立第二份长期 `FutureTimelineState` truth；它是 bounded Lookahead evidence 与当前 Program timing 的派生结果。

## 方案 A：完美平台双直连 CSTV（目标方案）

当前真实完美平台输入是 `connect IP:port;password ...`，不是已知 HTTP Broadcast URL。因此目标链路调整为：

```text
无延迟直连 CSTV
  → 无头直连 CSTV 客户端
  → Lookahead 事件证据
  → 时间轴对齐 / 调度
  → Assist cue

延迟直连 CSTV
  → 真实 CS2 观战客户端
  → GSI
  → Program
```

这保持“只有一个真正承担 Program 画面渲染的 CS2”的原始目标。

**无头直连 CSTV 客户端后续新建独立仓库研发和维护。** RivalHub-Broadcast 不实现 直连 CSTV 网络协议本身，只定义接入后的 `GameEventObservation`、时间轴对齐和 Observer Assist 语义。该独立仓库的研发进度不阻塞 Program V1 或制播工作区。

当前 `cs2parser + HttpBroadcastReader` 只适用于真正提供 HTTP Broadcast URL 的数据提供方，不能由直连 GOTV 的 `IP:port` 自动推导。

优点：

- 不需要 Broadcast 自己实现延迟缓冲；
- Program 继续只运行一个真实 CS2；
- Program GSI 与 Lookahead 接入分责；
- 上层时间轴对齐和 cue 语义不绑定具体接入方式。

任何端口命名或相邻端口规律都只能作为数据提供方专用的地址派生规则。启用 Assist 前必须验证同一比赛、同一地图执行和可信的时间轴关系。

## 方案 B：单 CSTV + 本地延迟中继

当 provider 只有一条流时，可以研究本地 relay：

```text
source
  ├─→ Lookahead parser
  └─→ bounded delay relay → Program observer
```

该方案增加 buffer correctness、断线恢复和生产运维责任，因此不是默认方案。无论 acquisition 如何变化，上层 alignment / cue semantics 应保持一致。

## 时间轴对齐

不能只依赖 wall-clock sleep。

需要至少验证：

```text
same match
same map execution
compatible game tick
effective gap healthy
source generation unchanged
```

错误比赛、地图不一致、source reconnect、gap 不可信时默认关闭 cue。

## 提前量

`desiredLead` 是产品参数，不是 Core constant。

需要用真实使用回答：

- 多久足够完成 POV 切换；
- 多久会让解说过早知道结果；
- 是否需要个人可调；
- 是否需要根据实际操作和 effective gap 自适应。

## 失败语义

| 失败 | 行为 |
| --- | --- |
| Lookahead 断流 | Program 正常；Assist 关闭 |
| Program 断流 | 正式节目输入故障；不切换到 Lookahead |
| wrong match / map | Assist 默认关闭 |
| alignment unhealthy | 不显示 future cue |
| source generation change | 清除旧 alignment / cue |
| cue 过密 | 保持最小提示；真实使用证明需要后再增加聚类 |

## 仍需验证的问题

- 最合适的默认 lead time；
- 独立无头直连 CSTV 客户端的连接、认证、协议维护与长期稳定性；
- Program / Lookahead tick relation 的漂移特征；
- 私有 Workspace 与透明窗口哪种更适合同一名解说兼 OB；
- kill cue 密度何时需要聚类；
- 是否存在足够强的证据支持 recommended POV。

这些问题只影响 Assist 产品增强，不改变 Program / Assist 隔离与单 Program renderer 的架构边界。
