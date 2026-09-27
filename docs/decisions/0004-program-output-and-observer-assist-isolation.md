# ADR-0004：Program 输出与 Observer Assist 隔离

- 状态：**Accepted**
- 日期：2026-09-14
- 关联：ADR-0001、ADR-0003、`docs/product.md`、`docs/architecture.md`、RivalHub #610 / #613 / #615、RFC-0001

## 背景

当前 RivalHub Major 的真实制播工作流是**单机、单人解说兼 OB**：同一个人在一台 Windows 机器上连接延迟 GOTV、解说、手动切换观察视角，并通过 OBS 输出正式节目。

完美平台当前实际提供同一场比赛的两条成对 GOTV：

```text
较早 / 无延迟 GOTV
  例如 ...5
  不直接提供给解说观看
  不进入 OBS
  后续由无头直连 CSTV 客户端读取，用于 Lookahead 事件和时间轴对齐

延迟 Program GOTV
  例如 ...6
  约 120 秒观战延迟
  由真实 CS2 观战客户端连接
  Program HUD / Radar 跟随该时间轴
  OBS 捕获正式节目
```

此前讨论曾把这个场景抽象成“解说”和“制作控制”两个独立现场角色，并把两条数据流设计成可以互相替代。这个抽象不符合当前真实运营方式，也制造了并不存在的 Program 备用切换问题。

本 ADR 重新冻结最小、真实的业务边界。

---

## 决策 1：现场只有一个制作角色，不建立独立解说角色模型

当前产品的主要现场用户是：

> **解说兼 OB / 制作人员。**

同一个人：

- 看 CS2 延迟节目画面；
- 看与正式 Program 同一 `ProgramProjection` 驱动的本机 Program HUD / Radar Overlay；
- 解说；
- 手动切 POV；
- 需要时打开制作控制与诊断；
- 可以看到独立的本机 Observer Assist。

因此本仓**不要求**存在独立 `/caster` 页面，也不建立 `CasterProjection` 作为长期业务角色模型。

`/operator` 表示制作控制职责，不意味着现场存在另一位独立“导播用户”。

---

## 决策 2：Program 数据流与 Lookahead 数据流职责不对等

二者的资格不同：

```text
延迟 Program 数据流
  → 真实 CS2 观战客户端
  → GSI
  → Runtime 的正式节目时间轴
  → ProgramProjection
  → Program Renderer
       ├─ 本机透明 Program Overlay（制作人员可见）
       └─ 官方 OBS Program Host（Browser Source 为基线实现）
  → #615 BroadcastLiveSnapshot

较早 Lookahead 数据流
  → 后续独立无头直连 CSTV 客户端
  → 未来事件证据 / 时间轴对齐
  → Observer Assist
  × 不渲染为 Program
  × 不进入 OBS
  × 不进入 #615
  × 不能作为 Program 的备用数据源
```

因此不设计：

```text
Program 故障
→ 自动或手工切换到 Lookahead 作为 Program
```

Program 数据流故障时按节目输入故障处理；Lookahead 数据流故障时 Program 正常继续，只关闭或降级 Observer Assist。

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
较早 GOTV
→ 观察到 player_death
→ 攻击者 / 被击杀者 / event tick / 可可靠获得的位置上下文

延迟 Program GOTV
→ 当前 Program tick

时间轴对齐
→ 计算该击杀距离 Program 还有多久

约 T-10s
→ 本机私有 Observer Assist
→ 倒计时 + killer → victim + 可选位置

制作人员
→ 自己决定是否切换 POV
```

第一阶段**不要求**：

- 佯攻/主攻识别；
- 交战 / 叙事聚类；
- 复杂重要性排序；
- AI / 物理预测；
- 自动 TAKE / 自动切镜；
- 第二个完整 CS2 渲染实例。

RFC-0001 可以继续研究更丰富的提示聚合、推荐 POV、本地中继等能力，但这些不是基础 Observer Assist 的上线前提。

---

## 决策 4：Program / Assist 在数据和捕获边界上硬隔离

Core 仍只有一份内部 `RuntimeState`。Assist 不成为第二份领域事实，但“一份 RuntimeState”也不能意味着把所有数据混在同一个无边界对象里。

Runtime 内至少需要结构化区分：

```text
RuntimeState
├─ 官方赛事 / 比赛上下文
├─ Program-safe 运行区域
│  ├─ 规范化 Program 遥测
│  ├─ 累计状态 / 身份 / 会话
│  └─ Program 展示控制
├─ Assist-private 运行区域
│  ├─ 有界 Lookahead 证据
│  ├─ 时间轴对齐健康状态
│  └─ 当前 / 已调度 Assist 提示
└─ 运行健康状态 / 异常记录
```

至少区分面向不同使用方的 Projection：

```text
ProgramProjection
  正式节目允许显示的信息
  只从 Program-safe 输入构造

ObserverAssistProjection
  只包含本机 Assist 所需的未来事件提示
  可以同时消费 Program-safe 时间信息与 Assist-private 输入
  不作为 Program 的超集

OperatorProjection
  比赛 / 健康状态 / 场景 / 异常 / 恢复 / OBS / 上行

DebugProjection
  原始 / 规范化诊断 / 时间 / 证据
```

安全原则是**从结构上保证隔离（safety by construction）**：Program 投影器和 #615 producer 不应拿到一个必须靠“记得别读某字段”才能安全使用的万能状态对象。实现可以使用类型收窄、专用 selector 或 schema 边界；具体 TypeScript 符号不由本 ADR 锁死。

规则：

- Lookahead 的未来信息不得进入 `ProgramProjection`；
- Assist 专用字段不得先发给 Program 再靠 CSS 隐藏；
- 官方 OBS Program 预设不得包含 Assist 窗口；
- #615 只从延迟 Program 时间轴生成公开实时快照；
- Assist 以透明置顶窗口实现时，必须在真实 Windows + OBS 验收中证明不会被官方捕获路径误录。

### 澄清（2026-09-15）：Projection、Renderer 与 Host 分层

这一澄清不改变上述 Program / Assist 安全决策，只把此前隐含的展示边界写清楚：

```text
Projection
  决定某类使用方允许看到什么数据
        ↓
Renderer
  决定如何把 Projection 画成 HUD / Radar / 场景 / 提示
        ↓
Host
  决定 Renderer 运行在哪里，以及如何被人或 OBS 使用
```

因此：

```text
ProgramProjection
  → Program renderer
      ├─ 浏览器 / 开发 Host
      ├─ OBS Browser Source host
      └─ 本机透明 / 置顶 / 点击穿透 Program Overlay Host

ObserverAssistProjection
  → Assist renderer
      ├─ 浏览器 / 调试原型（可选）
      └─ 本机透明 / 置顶 / 点击穿透 Assist Overlay Host
```

约束：

- 同一 Program Renderer 可以同时运行多个实例，分别给制作人员和 OBS 使用；这些实例不拥有第二份 `RuntimeState`，也不重新解释 Program 事实；
- Program Overlay 与 Assist Overlay 必须使用独立窗口，不能把未来提示与 Program HUD 混在同一窗口后再依赖 OBS 裁剪或可见性设置隐藏；
- Program / Assist 的安全性由 Projection / schema 保证，OBS 捕获哪个 Host 只是第二道部署级防线；
- OBS Browser Source 是当前首个明确验收的 Program Host，但不是 `ProgramProjection` 的唯一合法承载方式；
- 直接捕获独立 Program Overlay、桌面 WebView 或其它 Host，只有在完成真实 Windows + OBS 验收后才能成为正式部署方式；
- 本 ADR 不冻结 Electron、Tauri、WebView2 或其它桌面承载技术，完整打包与分发继续由后续 ADR / Issue 决定。 

---

## 决策 5：Lookahead 不自动成为 #610 的赛事事实来源

#610 比赛生命周期不依赖 Broadcast / GSI；Broadcast 仍只是可选观测来源。

当前无延迟数据流的明确业务归属是 **Observer Assist**。

虽然未来技术上可以让更早的可信证据参与 `match_started / map_ended` 等 `ReliableObservation`，但本 ADR 不因为“数据已经存在”就自动赋予该数据流官方赛事事实职责。

若未来需要，应在面向 RivalHub 的接口契约中单独决定：

- 哪些观测可以来自 Lookahead；
- 身份、会话和健康状态要求；
- 是否影响官方事实自动确认资格。

这避免把一个简单的切镜辅助功能变成比赛 Runtime 的隐式依赖。

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

## 决策 7：Program 与 Lookahead 各自维护数据源连接连续性

Program GSI、可选 Program 事件数据源和 Lookahead 接入是彼此独立的数据入口，它们可能分别重连、重启或发生延迟。不能把一个全局 `seq`、Companion `producerInstanceId` 或 Match `mapEpoch` 当成两个数据源的连接连续性。

每个遥测数据源至少要能在适配 / 对齐层表达以下等价概念：

```text
sourceRole
  program | lookahead

sourceInstance / sourceGeneration
  当前数据源读取器的连接世代

source-local seq / tick / observedAt
  只在明确作用域内解释

sourceHealth
  connecting / healthy / stale / disconnected / mismatch 等
```

其中：

- `liveSessionId` 仍表示 RivalHub Match ↔ Broadcast producer session；
- `producerInstanceId` 仍表示 Companion Runtime 实例；
- `mapEpoch` 仍表示一次地图执行；
- **Lookahead 读取器重连不能因为只是连接重建就推进 Program `mapEpoch`**；
- 数据源重连或 generation 改变时，现有时间轴对齐立即失效；重新证明同一比赛、同一地图执行和可信 tick 关系后才能恢复提示；
- Runtime / 上行的 `seq` 与数据源本地 sequence 不得混成一个含义模糊的编号。

这样可以把比赛事实连续性、进程连续性、地图执行连续性和各遥测数据源的连接连续性明确分开。

---

## 验证要求

自动验证至少覆盖：

- `ObserverAssistProjection` 的未来字段不出现在 `ProgramProjection`；
- Program 投影器 / #615 producer 的输入边界不依赖“先接收全部未来字段再过滤”才能保证安全；
- 同一 `ProgramProjection` 驱动不同 Program Host 时，不产生 Host 专属的第二份领域事实；
- #615 producer 不读取无延迟未来状态；
- Lookahead 数据流故障时 Program 不受影响；
- Program 数据流故障时不存在 Lookahead → Program 备用切换；
- 比赛不一致、地图不一致或时间轴对齐不健康时，Assist 默认关闭；
- Lookahead 数据源 generation 改变或重连后，旧时间轴对齐立即失效；
- 数据源重连或地图变化后，重新建立时间轴对齐才恢复提示。

真实生产验收分层进行。Program V1 / 制播工作区现场验收至少覆盖：

```text
Windows + CS2 延迟观战 + GSI + OBS
+ 本机 Program Overlay
```

当 Observer Assist / Lookahead 能力进入可交付状态时，再增加：

```text
无延迟 Lookahead 数据源
独立私有 Assist 承载面
```

Lookahead 的专项验收不再阻塞 Program V1 / 制播工作区的生产验收。

并验证：

- 制作人员看到的 Program Overlay 与官方 OBS Program Host 在相同 Projection / 场景下语义一致；
- Program Overlay 的透明、置顶、点击穿透、DPI 与窗口模式满足实际制作；
- Assist 窗口不进入官方 OBS Program 输出；
- 击杀提示的提前量稳定可用；
- CPU、内存和网络开销不影响 CS2 / OBS 稳定性；
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
- 延迟 Program 数据流与机器专用 Lookahead 数据流的不同职责；
- Observer Assist 作为本地私有显示层；
- Lookahead 不能作为 Program 的备用数据源；
- 未来事件提示与 Program / #615 / OBS 的硬隔离；
- Runtime 内 Program-safe 与 Assist-private 数据结构化分区；
- Program / Lookahead 数据源连接连续性与比赛 / producer / 地图连续性分责。

2026-09-15 的澄清进一步明确：Program 与 Assist 的 Projection 安全边界独立于具体浏览器、桌面窗口或 OBS Host；Program 可以有多个 Host 实例，而 Program Overlay 与 Assist Overlay 必须物理独立，并继续保持 Projection 层的硬隔离。