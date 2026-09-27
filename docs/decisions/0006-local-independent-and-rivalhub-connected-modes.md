# ADR-0006：独立模式与 RivalHub 连接模式

- 状态：**Accepted**
- 日期：2026-09-17
- 关联：ADR-0001、ADR-0005、Issue #38

## 背景

ADR-0001 冻结了 RivalHub 与 Mizar 的 authority 边界，ADR-0005 又明确了三条产品能力线和第一方集成的可移植性要求。随后 Issue #38 的产品调研进一步形成了一项新的长期产品判断：Mizar 不应只在连接 RivalHub 时才成立，它本身应能够发展成一个可独立安装和使用的本地 CS2 赛事制播工具；连接 RivalHub 后，再获得更完整的赛事上下文与第一方数据闭环。

这项判断不是要求当前版本已经具备完整的独立模式配置、安装、引导和全部节目流程，也不是要建立两套 Runtime。它定义的是长期产品边界和依赖方向。

同时，Issue #38 曾使用 `Standalone / Community mode` 作为讨论 shorthand。进一步收敛后需要区分两个不同维度：

- **独立模式**描述“如何运行”：不依赖 RivalHub 也能运行本地制播能力；
- **校园赛、社区赛、小型赛事组织者**描述“谁可能使用”：它们是适用场景，不是第三种运行模式，也不应与独立模式画等号。

## 决策

### 1. 产品只定义两种运行方式

Mizar 的长期产品目标包含两种运行方式：

```text
Mizar
├─ 独立模式
│  ├─ 本地比赛上下文
│  ├─ HUD / Radar / Program
│  └─ 制播工作区 / 观察辅助（按能力逐步完善）
│
└─ RivalHub 连接模式
   └─ 通过版本化契约读取 RivalHub 的完整赛事上下文
```

正式中文文档不使用“社区模式”作为运行模式名。校园赛、社区赛和小型赛事只是独立模式的重要适用场景；它们同样可以选择连接 RivalHub。

### 2. RivalHub 是第一方、最完整的赛事上下文提供方，但不是运行前置条件

RivalHub 连接模式优先消费 RivalHub 已维护的：

```text
Match / Roster / Steam64 / BP / Schedule / Branding / official result
```

Mizar 不因此把 RivalHub Web、Supabase 表或内部 domain 类型变成 Core、Radar、Program 或 Lookahead 的运行依赖。

如果 RivalHub 不可用或赛事本身不使用 RivalHub，独立模式仍应能够通过 Mizar-owned 的本地比赛上下文运行基础制播能力。

### 3. 两种模式共享同一套 Runtime 和领域模型

禁止为了独立模式建立第二套：

```text
RuntimeState
identity model
Radar domain
Program projection
Local Protocol
Lookahead alignment / cue model
```

两种模式只在“赛事上下文从哪里来”这一适配边界上不同。

概念上：

```text
本地比赛配置 ─────────────┐
                          ├─→ MatchContext / shared Runtime
RivalHub adapter ─────────┘
```

产品和实现应优先复用同一 owner，而不是把独立模式做成一个简化版分叉。

### 4. 独立模式中的本地比赛上下文不是第二套 RivalHub 数据库

独立模式只需要维护当前赛事制播所需的最小本地上下文，例如：

- 比赛和 BO 信息；
- 双方队伍与选手显示信息；
- Steam64 等运行时身份键；
- BP / veto 与必要品牌信息；
- 当前节目所需的本地配置。

它不意味着在 Mizar 内复制 RivalHub 的完整赛事管理、报名、长期 Team / Player 数据库或后台业务流程。

### 5. Authority 边界保持不变

在 RivalHub 连接模式下：

```text
RivalHub
= official / canonical tournament facts

Mizar
= local realtime observation / presentation runtime
```

在独立模式下，本地人工配置是当前本地节目上下文的来源；GSI/CSTV/Runtime 仍然只产生实时 observation、projection 和派生状态，不应因为没有 RivalHub 就把实时观测自动改写成新的长期赛事数据库。

这不改变 ADR-0001 已冻结的“赛事事实与实时观测分权”原则。

### 6. 产品方向与当前实现状态必须分开描述

本 ADR 冻结的是**产品方向**，不是“当前已经完整实现”的声明。

长期文档可以写：

> Mizar 的产品目标支持独立模式和 RivalHub 连接模式；RivalHub 不作为本地 HUD、Radar、Program 或观察辅助的运行前置条件。

但如果本地比赛配置、安装引导、独立 BP 或其它必要能力尚未落地，文档不得把它们描述成当前已完成事实。

具体功能是否已经可用，以当前代码、产品页面和对应 milestone 的验收结果为准。

## 与既有 ADR 的关系

### ADR-0001

ADR-0001 的以下内容保持不变：

- Mizar 是独立仓库和本地制播 Runtime；
- Mizar 不建立第二套官方赛事数据库；
- RivalHub 与 Mizar 通过版本化 contract 集成；
- observation 与 official fact 分离。

本 ADR 对 ADR-0001 中产品定位做后续澄清：它表示 **RivalHub-first / 第一方深度集成**，不表示“必须连接 RivalHub 才能运行 Mizar”。

### ADR-0005

ADR-0005 关于 Shared Runtime Foundation、三条能力线、依赖方向和不提前泛化的决定保持不变。

本 ADR 取代 ADR-0005 中“独立使用能力是否应成为明确产品方向仍待未来需求验证”的部分：Issue #38 已经形成产品判断，独立模式本身应作为正式长期方向；但具体 packaging、配置 UX 和完成度仍按真实实现逐步验收。

## 后果

正面：

- HUD / Radar / Program 不会因为第一方后台尚未接通而失去独立产品价值；
- RivalHub 仍能提供最完整的赛事上下文和数据闭环；
- 校园赛、社区赛和小型赛事可以按自身条件选择是否使用 RivalHub；
- 两种运行方式共享同一套 Runtime，不引入重复架构；
- 文档可以明确区分“长期产品方向”和“当前实现完成度”。

代价：

- 后续需要真正补齐本地比赛上下文、配置和分发体验，不能只依赖 RivalHub adapter；
- 独立模式和 RivalHub 连接模式都需要接受相同的 Runtime / Program / Radar correctness 约束；
- 产品文案必须避免把“社区赛事”误写成技术运行模式。

## 本 ADR 没有决定

- 独立模式第一版具体配置 UI；
- 是否使用文件、表单或其它方式录入本地比赛上下文；
- 独立发行的 packaging / launcher 形式；
- 制播工作区的最终布局；
- 桌面 Host 技术；
- Lookahead 的具体提前量或提示布局；
- 商业模式、托管服务或插件市场。

这些事项仍由对应产品调研、ADR 或实现 Issue 单独决定。
