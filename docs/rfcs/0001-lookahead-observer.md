# RFC-0001：Lookahead Observer / Observer Assist

| 字段 | 值 |
| --- | --- |
| 状态 | Draft |
| 主题 | 较早比赛时间轴、对齐、未来击杀提示、私有制播工作区 |
| 需要真实验证 | Windows + CS2 + 完美平台直连 CSTV + OBS |

## 摘要

Lookahead 利用两个存在时间差的比赛时间轴：较早时间轴上的事件已经真实发生，但延迟 Program 尚未到达。Mizar 将这种时间优势转换成低干扰的私有提示，帮助同一名解说兼 OB 提前准备切 POV。

这不是 AI 预测未来，也不宣称“延迟观察提示”概念首创。HOT / HLAE Observer Tools 已公开实现 Delayed Observer Cues，是重要参考。

## 产品问题

人工 OB 的困难不是“缺少更多统计”，而是常常在击杀信息出现后才知道该切谁。一个有用的第一层提示只需要回答：

```text
+5.2s
playerA → playerB
```

系统负责给人反应时间；制作人员继续决定是否切向攻击者、被击杀者，或保持当前叙事。

## 产品边界

### 目标

- 提前显示下一次可靠的未来击杀提示；
- 提示至少包含倒计时、攻击者和被击杀者；
- 位置只在证据可靠时显示；
- 只运行一个真正承担 Program 画面渲染的 CS2 观战客户端；
- 用比赛、地图执行和 tick 关系建立时间轴对齐；
- Program 与 Assist 在 Projection 层硬隔离；
- 数据源重连后默认清除旧提示，直到重新建立时间轴对齐；
- 提前量可配置。

### 非目标

第一层产品不要求：

- AI / LLM camera model；
- 全自动 OB；
- 自动 TAKE；
- 战术执行 / 交战分类；
- 重要性排序；
- Future Radar（未来雷达）；
- 第二个完整 CS2 渲染实例；
- 服务器插件前置依赖；
- 自动重放 / 集锦。

## 现有先例：HOT

HOT 证明两件事：

1. CS2 可以作为观察工作台中的主要画面，而不是唯一全屏界面；
2. 较早的数据源向延迟 OB 提供提示时间轴，是已经被实际产品验证过的模式。

Mizar 借鉴的是产品范式，不复制 HOT 的具体布局或注入技术。

Mizar 的差异化组合是：

```text
无头无延迟数据源
+ 显式时间轴对齐
+ Program / Assist 硬隔离
+ 单 Program 渲染流程
+ 本地优先的独立模式
+ 可选 RivalHub canonical 赛事上下文
```

## 产品承载方式

Observer Assist 不限定为只能使用 Overlay。

```text
ObserverAssistProjection
  ├─ 透明 / 置顶 Assist 窗口
  └─ 制播工作区私有区域
```

制播工作区中，CS2 Program 画面应保持视觉主体，外围只放真正降低切镜成本的信息。

第一阶段不做两套 Radar。推荐信息结构：

```text
一套 Program Radar
+
低信息量未来事件提示
```

如果真实使用证明空间位置提示有价值，再研究在同一 Radar 上增加极轻量、可关闭的未来标记。

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

未来提示不建立第二份长期 `FutureTimelineState` 事实；它只是有界 Lookahead 证据与当前 Program 时间信息的派生结果。

## 方案 A：完美平台双直连 CSTV（目标方案）

当前真实完美平台输入是 `connect IP:port;password ...`，不是已知 HTTP Broadcast URL。因此目标链路调整为：

```text
无延迟直连 CSTV
  → 无头直连 CSTV 客户端
  → Lookahead 事件证据
  → 时间轴对齐 / 调度
  → Assist 提示

延迟直连 CSTV
  → 真实 CS2 观战客户端
  → GSI
  → Program
```

这保持“只有一个真正承担 Program 画面渲染的 CS2”的原始目标。

**无头直连 CSTV 客户端后续新建独立仓库研发和维护。** 本仓库不实现直连 CSTV 网络协议本身，只定义接入后的 `GameEventObservation`、时间轴对齐和 Observer Assist 语义。该独立仓库的研发进度不阻塞 Program V1 或制播工作区。

当前 `cs2parser + HttpBroadcastReader` 只适用于真正提供 HTTP Broadcast URL 的数据提供方，不能由直连 GOTV 的 `IP:port` 自动推导。

优点：

- 不需要 Mizar 自己实现延迟缓冲；
- Program 继续只运行一个真实 CS2；
- Program GSI 与 Lookahead 接入分责；
- 上层时间轴对齐和 提示语义不绑定具体接入方式。

任何端口命名或相邻端口规律都只能作为数据提供方专用的地址派生规则。启用 Assist 前必须验证同一比赛、同一地图执行和可信的时间轴关系。

## 方案 B：单路 CSTV + 本地延迟中继

当数据提供方只有一条流时，可以研究本地中继：

```text
数据源
  ├─→ Lookahead 读取器
  └─→ 有界延迟中继 → Program 观战端
```

该方案会增加延迟缓冲正确性、断线恢复和现场运维责任，因此不是默认方案。无论底层接入如何变化，上层时间轴对齐和提示语义都应保持一致。

## 时间轴对齐

不能只依赖墙上时钟等待。

需要至少验证：

```text
同一比赛
同一地图执行
兼容的 game tick
有效时间差可信
数据源 generation 未变化
```

比赛或地图不一致、数据源重连、时间差不可信时默认关闭提示。

## 提前量

`desiredLead` 是产品参数，不是 Core 常量。

需要用真实使用回答：

- 多久足够完成 POV 切换；
- 多久会让解说过早知道结果；
- 是否需要个人可调；
- 是否需要根据实际操作和有效时间差自适应。

## 失败语义

| 失败 | 行为 |
| --- | --- |
| Lookahead 断流 | Program 正常；Assist 关闭 |
| Program 断流 | 正式节目输入故障；不切换到 Lookahead |
| 比赛 / 地图不一致 | Assist 默认关闭 |
| 时间轴对齐不健康 | 不显示未来提示 |
| 数据源 generation 改变 | 清除旧时间轴对齐和提示 |
| 提示过密 | 保持最小提示；真实使用证明需要后再增加聚类 |

## 仍需验证的问题

- 最合适的默认提前量；
- 独立无头直连 CSTV 客户端的连接、认证、协议维护与长期稳定性；
- Program / Lookahead tick 关系的漂移特征；
- 制播工作区私有区域与透明窗口哪种更适合同一名解说兼 OB；
- 击杀提示密度何时需要聚类；
- 是否存在足够强的证据支持推荐 POV。

这些问题只影响 Assist 产品增强，不改变 Program / Assist 隔离与单 Program 渲染实例的架构边界。
