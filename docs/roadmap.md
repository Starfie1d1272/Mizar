# Mizar 版本路线图

Mizar 的第一个正式版 [v1.0.0](https://github.com/Starfie1d1272/Mizar/releases/tag/v1.0.0) 已发布。最新可下载版本以 [GitHub Releases](https://github.com/Starfie1d1272/Mizar/releases) 为准；本页管理**未来方向与候选交付范围**，不是已交付功能说明。现有产品能力见[产品介绍](guide/product.md)。

## 版本策略

应用遵循语义化版本号 `MAJOR.MINOR.PATCH`；内部协议、第三方 Provider API 和插件格式分别管理自身的兼容版本，不因为增加一个事件类型就自动升级整个应用的 Major。

| 类型 | 使用条件 | 示例 |
| --- | --- | --- |
| Patch · `1.0.x` | 不改变已有产品契约的缺陷修复、文案、有限视觉微调或安全修补 | `1.0.1`：播出昵称修复 |
| Minor · `1.x.0` | 保持兼容的功能与明显体验增强，可一次交付多个 Issue | `1.1.0`：安全更新与常用操作；`1.2.0`：更完整的 BP 演播样式 |
| Major · `2.0.0` / `3.0.0` | 明确跨越产品能力边界，且发布前独立说明任何用户数据、Provider、协议或工作流的不兼容变更及迁移方式 | 高级镜头控制；Observer Assist |

上述版本例子是**规划靶点而不是日期或发布承诺**。仍可按风险独立发布 Patch；不再为每次修改连续发布 RC。大型版本使用 `-alpha.N` / `-beta.N` / `-rc.N` 验收，详情见[版本发布规范](development/release-readiness.md)。

## 1.x：成熟、可靠、易用的制播产品

优先服务正常比赛：修复真实缺陷，降低现场操作与升级成本，渐进式完善节目外观。1.x 的开发不受尚未验证的注入工具、无头 GOTV 或 Lookahead 阻塞。

### Now — 近期处理

| 目标 | Issue | 说明 |
| --- | --- | --- |
| `1.0.1` | [#208 播出昵称](https://github.com/Starfie1d1272/Mizar/issues/208) | 去除有证据的队名前缀，保障 HUD 显示本人昵称 |
| `1.0.x` 候选 | [#158 BP 术语](https://github.com/Starfie1d1272/Mizar/issues/158) | 仅收口操作说明，不作为阻断紧急补丁的门槛 |
| 持续 | [#183 测试体系与 CI 减债](https://github.com/Starfie1d1272/Mizar/issues/183) | 以产品契约与独立 oracle 清理低价值测试；保留关键安全及生产验证 |

### Next — 1.1 / 1.2 候选

| 目标 | Issue | 说明 |
| --- | --- | --- |
| `1.1` | [#212 应用内更新](https://github.com/Starfie1d1272/Mizar/issues/212) | 可信 Stable 版本检查、国内镜像原资产、用户确认退出安装；先保证安全 |
| `1.1` | [#213 NSIS 安装器品牌视觉](https://github.com/Starfie1d1272/Mizar/issues/213) | 在既有中文 NSIS 向导上更新品牌，不影响升级、卸载或用户资料 |
| `1.1` | [#132 观战 HUD 一键应用/恢复](https://github.com/Starfie1d1272/Mizar/issues/132) | 显式、受控的 CS2 原生 HUD 配置；失败保留手动路径 |
| `1.1` | [#211 BP 战队辨识度](https://github.com/Starfie1d1272/Mizar/issues/211) | A/B 身份、队标、禁选及 CT/T 信息分层，不改变 BP truth |
| `1.2` | [#145 BP 紧凑底栏](https://github.com/Starfie1d1272/Mizar/issues/145) | 在舞台、访谈或游戏画面底部显示，同一 BP session |
| `1.x` | [#204 产品体验与界面组织](https://github.com/Starfie1d1272/Mizar/issues/204) | 先从真实用户路径识别问题，再拆小规模 PR |

### Later — 具备需求/资源后持续交付

- [#135 节目音乐导演](https://github.com/Starfie1d1272/Mizar/issues/135)：OBS 本地媒体源、暂停/中场/赛后 cue 与恢复。
- [#165 独立在线比赛](https://github.com/Starfie1d1272/Mizar/issues/165)：在已落地的“比赛可以没有赛事归属”模型上补全授权发现及 LIVE。
- [#111 播出数据插页](https://github.com/Starfie1d1272/Mizar/issues/111)：RivalHub 只读统计、地图表现、阵容、选手卡。
- [#142 烟雾动效](https://github.com/Starfie1d1272/Mizar/issues/142)、[#143 C4 动效](https://github.com/Starfie1d1272/Mizar/issues/143)、[#144 选手状态动效](https://github.com/Starfie1d1272/Mizar/issues/144)：依赖真实播出反馈，优先信息正确性。
- [#110 播出视觉包架构](https://github.com/Starfie1d1272/Mizar/issues/110)：长期架构方向，按明确需求拆安全声明式视觉包与专业展示扩展；**不整体作为 2.0 发布门槛**。

仍保留**第三方 HUD 展示层复用**与**更多赛事平台适配**作为未排期候选：只有明确的外部消费者或赛事平台需求及可验证集成路径出现后，才拆分实施 Issue；它们不自动成为任何已命名版本的发布门槛。

## 2.0：高级制播与游戏内镜头控制

目标从“自动包装比赛”扩展为“编排真实游戏内视角与高价值精确事件”。

- [#214 MulNX 可选观战控制和电影式开场运镜](https://github.com/Starfie1d1272/Mizar/issues/214)：先核验官方 API、镜头轨道控制、游戏版本与安全约束；Provider 可缺席，标准 CS2/GSI/OBS 保持可用。MulNX 官方安全文档要求专用启动器及不受信任模式，Mizar 不在用户不知情时注入或改变安全设置。
- [#215 精确游戏事件与事件驱动节目表现](https://github.com/Starfie1d1272/Mizar/issues/215)：从已证实的生产数据源获取精确事件，沿用现有 GameEventObservation / transient cue，提供真实录像验收；不可用时降级为普通 GSI HUD。

2.0 发布前要冻结最终范围与兼容性策略；不可把外部 Provider 的不稳定性变成正常比赛的硬依赖。

## 3.0：Observer Assist / Lookahead（条件性目标）

[#216 双时间轴与数据源可行性研究](https://github.com/Starfie1d1272/Mizar/issues/216) 是 3.0 的 **Go/No-Go 前置**。验证具有赛事使用授权的较早比赛事件源、与正式延迟 Program 的身份和 tick 对齐、提前量及断流安全；若轻量无渲染数据读取不可行，须如实记录结论，而不是承诺上线。

始终保证：较早时间轴信息仅出现在制播人员的私有 Assist 界面，**不能污染正式 Program HUD、OBS 画面或对外 LIVE 数据**。历史原型与 prior art 见 [#38](https://github.com/Starfie1d1272/Mizar/issues/38) 和 [RFC-0001 历史版本](https://github.com/Starfie1d1272/Mizar/blob/3b187e168ad755ede595eb8371bfaf5933c044fa/docs/rfcs/0001-lookahead-observer.md)。

## GitHub Issue 管理规则

新 Issue 不再用 `[Post-1.0]`、旧 `[M1/M2]` 或 `[Mizar Polish]` 指代产品阶段。长期维护以下互不替代的维度：

| 维度 | 标签例子 | 使用原则 |
| --- | --- | --- |
| 类型 | `type:bug` / `type:feature` / `type:polish` / `type:maintenance` / `type:planning` / `type:research` | 描述工作性质 |
| 所属领域 | `area:bp` / `area:hud` / `area:program` / `area:distribution` / `area:desktop` / `area:telemetry` / `area:integration` / `area:observer` | 明确主要 owner，其他领域通过 Issue 链接协同 |
| 优先级 | `priority:p1` / `priority:p2` / `priority:p3` | P1 优先解决实际风险，P2 明确价值，P3 非紧急打磨；P0 留给现场阻断和重大安全风险 |
| 规划视野 | `horizon:now` / `horizon:next` / `horizon:later` / `horizon:research` | 表示投入顺序，不等于发布日期 |
| 目标版本 | `target:v1.0.1` / `target:v1.1` / `target:v1.x` / `target:v2.0` / `target:v3.0-research` | **仅表示可追踪的计划目标**；待实际发布日期确定再使用 GitHub Milestone |

历史内部里程碑“M2 — 本地制播内核”与产品 `2.0` **没有关系**，不再用于活跃规划。Issue 的现行分类以顶部“当前规划”和标签为准；旧 RC/1.0 的决策与验收正文保留以便追溯。已完成并拆出具体任务的 #79 视觉总表作为历史索引归档。

每次发布仍须满足源码、构建产物、安装/卸载/升级与实际受影响功能的对应验证，详见[发布规范](development/release-readiness.md)。