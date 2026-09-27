# ADR-0005：产品能力边界与第一方集成可移植性

- 状态：**Accepted**
- 日期：2026-09-15

## 背景

Mizar 最初定位为面向 RivalHub 深度集成的 local-first CS2 制播 Runtime，主要解决两类现实问题：一是赛事事实已经存在于 RivalHub，不应在本地 HUD/Manager 中重新建立 Team / Player / Match / BP 数据；二是 GSI、HUD、Radar、scene、OBS 等低延迟运行态需要留在本地制播 runtime。

随着 Runtime、Program / Observer Assist 隔离和 Lookahead 设计逐步明确，产品实际已经形成三条彼此不同、但共享同一 Runtime Foundation 的能力线：

1. **赛事与实时数据**：消费赛事上下文、完成 identity/reconciliation，并把可信实时 observation / live snapshot 输出给 RivalHub 及其下游实时页面或数据消费者；
2. **正式节目制播**：Waiting、BP、Gameplay HUD、Radar、Halftime、Map/Match Result、Operator 与 OBS Program 输出；
3. **Observer Assist / Lookahead**：利用独立 Lookahead timeline 生成只供本机制作人员使用的 future cue，不进入正式 Program。

如果继续只用“RivalHub-native HUD/制播软件”描述项目，后续实现容易产生两个问题：

- 把三条能力线错误压成一个 UI 产品，导致赛事数据、Program、Assist 的 ownership 继续耦合；
- 因仓库名称和第一方业务来源，把 RivalHub 内部类型或在线服务误写成 Core / Radar / Lookahead 的运行前提，从而失去本地离线、provider adapter 和未来独立分发能力。

同时，当前没有证据支持现在就拆分仓库、设计通用电竞协议、插件市场或抽象成面向所有游戏/赛事平台的框架。过早泛化会直接增加 M1–M3 的实现成本。

## 决策

### 1. 冻结三条产品能力线

Mizar 的顶层产品结构固定为：

```text
Shared Runtime Foundation
├─ Tournament & Live Data
├─ Program Production
└─ Observer Assist / Lookahead
```

中文文档中的默认称呼分别为：

- **赛事与实时数据**；
- **正式节目制播**；
- **Observer Assist / Lookahead**。

三条能力线是产品与 ownership 边界，不要求对应三个独立进程、package 或仓库。

### 2. Shared Runtime Foundation 是共同底座

以下能力属于共享运行时基础，而不是某一条产品线的私有实现：

- telemetry ingress / normalization；
- source continuity / generation；
- `RuntimeState` / `RuntimeTransition`；
- `liveSessionId / producerInstanceId / mapEpoch / seq`；
- identity / match binding；
- capability / health / incident；
- capture / replay / deterministic test；
- bounded delivery / backpressure；
- consumer-specific projection 基础。

各能力线通过明确 projection、adapter 或 contract 消费该底座，不直接共享一个无边界万能 payload。

### 3. RivalHub 是第一方、默认且最完整的赛事集成

ADR-0001 的 `RivalHub-native` 保持成立，其含义明确为：

- RivalHub 是当前产品的第一方 canonical tournament context；
- 当前 Major 和 V1 优先服务 RivalHub 的真实赛事工作流；
- `BroadcastManifest`、#610 ReliableObservation、#615 BroadcastLiveSnapshot 是当前正式跨仓 contract；
- 不在 Mizar 内重复建立 RivalHub 已拥有的 Team / Player / Match / BP 官方数据库。

但 `RivalHub-native` **不等于**：

- `packages/core`、`packages/radar`、telemetry adapter 或 Lookahead engine 可以 import RivalHub 内部 domain/types；
- Program 本地运行必须持续在线连接 RivalHub；
- Observer Assist 必须依赖 RivalHub 才能解析两条 timeline、建立 alignment 或生成 future cue；
- 每个共享 domain contract 都必须带 RivalHub-specific 字段。

RivalHub-specific 语义通过 `packages/rivalhub` 和 composition root 接入 Mizar-owned domain contract。

### 4. 依赖方向固定为 adapter → Core → consumer projection

概念依赖方向：

```text
RivalHub adapter ───────────────┐
Program GSI / telemetry adapter ├─→ Shared Runtime Foundation
Lookahead source adapter ───────┘            │
                                             ├─→ Tournament / Live Data outputs
                                             ├─→ ProgramProjection / Radar / scenes
                                             └─→ ObserverAssistProjection
```

禁止反向依赖：

- Core 不依赖 RivalHub API client；
- Radar 不依赖 RivalHub package shape；
- Lookahead alignment/cue scheduling 不依赖 RivalHub Web/domain implementation；
- RivalHub uplink 不拥有 Program 或 Assist 的内部 RuntimeState。

如果某项业务需要 RivalHub 提供 display name、avatar、branding、canonical roster 或 lifecycle，它应作为可验证的赛事上下文输入参与 identity/enrichment，而不是成为通用时间轴和 cue 算法的隐式前提。

真实回放 acceptance fixture 中，GSI player identity 与 telemetry 保持原样；display avatar 和 team logo 属于单独的 fixture-local presentation enrichment，以 Steam64 / capture team name 显式关联并记录来源/hash。一次性 Steam Web API 导入只 materialize 本地 fixture，不参与 replay/runtime，也不改写 GSI 昵称或比赛事实。

### 5. 三条能力线的 authority 不相同

#### 赛事与实时数据

负责把 canonical context 与实时 observation 连接起来。

Mizar 仍只产生 observation / live projection；RivalHub 决定 official truth。公开网站、第三方 API/WebSocket/SSE 等云端分发由 RivalHub 或未来明确的数据服务 owner 负责，不把 Mizar Companion 演化成公网数据平台。

#### 正式节目制播

只消费 Program-safe state，负责正式节目输出与 Operator production workflow。

HUD/Radar 是该能力线的重要 surface，但不是整个产品定义。

#### Observer Assist / Lookahead

可以消费 Program-safe timing/context 与 Assist-private evidence，但 future information 永不进入 Program/#615/官方 OBS Program。

Lookahead 的 source acquisition、timeline alignment、future-event evidence、cue scheduling 应保持 provider-adapter-friendly。Perfect dual-GOTV 是当前第一方部署事实，不进入 Core invariant。

### 6. 当前不拆仓库、不建立通用插件框架

M0–M5 期间继续使用当前 monorepo 和共享 Runtime。现在不因为未来可能独立分发 Observer Assist 或数据能力而：

- 新建独立 Lookahead 仓库；
- 设计 generic esports protocol；
- 建立动态 plugin marketplace；
- 为不存在的第二个产品提前建立复杂 SDK；
- 把所有 RivalHub 字段抽象成最低公分母。

只有出现第二个真实 provider / tournament-context integration / 独立发行需求，并且现有边界已经产生实际摩擦时，才评估物理拆分。

### 7. 可移植性的验收方式

“可移植”不是要求当前 V1 对所有环境开箱即用，而是要求 ownership 不制造不必要锁定。

至少应能够通过测试或 fixture 证明：

- Core reducer/replay 不需要 RivalHub 网络连接；
- Program projection 可由与 `BroadcastManifest` 同 shape 的本地 context fixture 驱动；
- Lookahead alignment/future cue 的核心逻辑只依赖 Mizar-owned identity/timeline/event contract；
- provider-specific discovery/configuration 留在 adapter 层；
- RivalHub-specific enrichments 缺失时，系统可以降级到较弱 display/identity capability，而不是污染时间轴正确性。

## 与现有 ADR 的关系

- **ADR-0001 保持 Accepted，不被 supersede。** 本 ADR 澄清其中 `RivalHub-native` 的产品含义，并补充三条能力线与可移植性边界；RivalHub 仍是第一方 canonical integration。
- **ADR-0003 保持不变。** RuntimeState、projection、delivery/backpressure、identity/session 与跨仓 contract invariant 是三条能力共享的 Runtime Foundation。
- **ADR-0004 保持不变。** Program / Observer Assist non-leak 是本 ADR 第三条能力线之间的硬安全边界。

## 后果

正面：

- 文档和实现都能明确区分“赛事数据闭环”“正式节目”“Observer Assist”；
- RivalHub 优先级不变，同时避免把共享 Core 写死为主站内部模块；
- Lookahead 可以先作为 Mizar 的能力落地，又保留未来独立发行或接入其他 CSTV/provider 的路径；
- Program/HUD 继续完整服务当前赛事，不需要为了可移植性降低第一方集成深度；
- Agent 在实现新能力时拥有更明确的 dependency/ownership 判断依据。

代价：

- 需要维护清晰的 Mizar-owned domain contract 与 RivalHub adapter 边界；
- 某些第一方字段不能为了开发方便直接泄漏到 Core；
- standalone capability 仍需要未来真实需求验证，当前不会自动获得独立 packaging/UX。

## 本 ADR 没有决定

- 商业模式或定价；
- 是否、何时拆分独立产品/仓库；
- 是否采用双许可证或其它商业许可证；
- 对外公开数据 API 的具体产品形态；
- 第二个 tournament platform/provider 的具体 adapter；
- Lookahead parser/alignment 的最终实现技术；
- desktop shell / packaging；
- plugin SDK / marketplace。

这些事项只有出现足够真实需求和实现证据后再单独决策。
