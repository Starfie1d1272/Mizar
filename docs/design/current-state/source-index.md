# 源码与证据索引

本索引与[产品事实](product-facts.md)分开：用于追溯当前实现，不定义未来页面或架构。所有源码、规范及既有测试链接固定在 **`12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b`**，避免后续 main 漂移。链接含行号时定位该提交的入口；无行号时定位整个职责文件。

“规范”证明仓库声明的行为或要求；“实现”证明当前代码的入口与门槛；“既有验证入口”提供进一步复核位置，**不表示本轮运行通过**。关键测试抽查了生命周期、人工接管、配置保存／启用、输出身份和修订拒绝等断言；其余列作相关检索入口。外部服务行为、发布状态与实机效果另行列为未知。

## E01

**产品定位、用户职责与现有范围** · 对应产品事实：P01–P03、R01–R02、I。

可支持结论：文档明确面向校园／社区赛事、角色可兼任、本地与连接两种方式、人工掌控；没有用户访谈或行为频率结论。

- 规范：[docs/guide/product.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/product.md#L15)；[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L180)；[docs/roadmap.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/roadmap.md#L5)。
- 实现：[apps/companion/src/app.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/app.ts#L117)；[apps/web/src/preparation/PreparationPage.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/preparation/PreparationPage.tsx#L81)。
- 证据边界：README 的目标性表述不作为已验证收益；DAK 是相邻产品定位，不证明已连通端到端工作流。

## E02

**比赛模型、本地库、赛程与回收站** · 对应产品事实：P04、P06、F01、F10、U12。

可支持结论：比赛 BO1/3/5、可空赛事／阶段、空名单、结果处置；本地保存、共享队伍／赛事、回收与恢复。普通创建仍生成赛事资料。

- 规范：[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L21)；[docs/reference/architecture.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/architecture.md#L54)。
- 实现：[packages/protocol/src/context.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/protocol/src/context.ts#L101)；[apps/companion/src/match-context/local-tournament-store.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/local-tournament-store.ts#L209)；[apps/companion/src/match-context/local-tournament-routes.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/local-tournament-routes.ts#L24)；[apps/web/src/workspace/LocalTournamentEditor.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/workspace/LocalTournamentEditor.tsx#L7)。
- 既有验证入口：[apps/companion/test/local-tournament-store.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/local-tournament-store.test.ts)；[apps/companion/test/local-tournament-routes.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/local-tournament-routes.test.ts)；[tests/acceptance/local-tournament.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/local-tournament.spec.ts)。
- 证据边界：回收站上限当前为 256；满时拒绝，未发现永久删除产品入口。导入支持不等于创建表单支持相同范围。

## E03

**首发捕获、当前比赛删除资格与确认有效性** · 对应产品事实：F03、F10、R09–R10。

可支持结论：候选来自可信服务端观测；当前比赛的退出资格绑定实际制作／输入状态，旧确认不复用。

- 规范：[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L144)；[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L43)。
- 实现：[apps/companion/src/match-context/roster-capture.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/roster-capture.ts#L10)；[apps/companion/src/match-context/local-match-exit.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/local-match-exit.ts#L28)；[apps/companion/src/match-context/local-tournament-routes.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/local-tournament-routes.ts#L251)；[apps/desktop/src-tauri/src/production_exit.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/production_exit.rs#L412)。
- 既有验证入口：[apps/companion/test/local-tournament-routes.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/local-tournament-routes.test.ts)。
- 证据边界：候选确认不是客户端自行提交任意玩家列表；数据过期、窗口隐藏和进程关闭是不同证据。

## E04

**平台授权、资料选择、刷新及缓存** · 对应产品事实：P05、F02、P08、R07。

可支持结论：同场刷新保留有效事实，异场切换不能沿用旧场；兼容资料与 BP 冲突候选分开；本场认领与主动停止独立。

- 规范：[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L47)；[docs/reference/architecture.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/architecture.md#L60)。
- 实现：[apps/companion/src/match-context/controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/controller.ts#L141)；[apps/companion/src/match-context/rivalhub-connection.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/rivalhub-connection.ts#L187)；[apps/companion/src/match-context/rivalhub-routes.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/rivalhub-routes.ts#L9)；[apps/companion/src/match-context/lkg-store.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/lkg-store.ts#L16)；[apps/companion/src/match-context/schedule-window-controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/schedule-window-controller.ts#L23)。
- 既有验证入口：[apps/companion/test/rivalhub-connection.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/rivalhub-connection.test.ts)；[apps/companion/test/match-context-lkg.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/match-context-lkg.test.ts)；[apps/companion/test/online-manifest-source.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/online-manifest-source.test.ts)。
- 证据边界：RivalHub 服务端行为在本仓库契约中有描述；本轮没有读取其生产数据库或实测服务。

## E05

**BP 规则、编写、候选、播放及演示** · 对应产品事实：P04、P06、F04、P07。

可支持结论：本地／在线叠加编辑范围不同；BO3 规则继承；修订号拒绝旧写入；BP 演示不持久化为正式比赛。

- 规范：[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L160)；[docs/design/program-direction-v1.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/design/program-direction-v1.md#L38)。
- 实现：[apps/companion/src/bp/local-draft.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/bp/local-draft.ts#L138)；[apps/companion/src/bp/workspace-controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/bp/workspace-controller.ts#L27)；[apps/companion/src/bp/controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/bp/controller.ts#L7)；[apps/companion/src/bp/demo-controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/bp/demo-controller.ts#L7)；[packages/protocol/src/bp.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/protocol/src/bp.ts#L6)。
- 既有验证入口：[tests/acceptance/bp-presentation.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/bp-presentation.spec.ts#L93)。
- 证据边界：演示内存会话与编辑器样例、真实 Demo 试播不是同一流程；文件字段及精确序列以协议和编译器为准。

## E06

**GSI、身份、名单与单图统计** · 对应产品事实：P05–P08、F03、R03–R04。

可支持结论：当前帧语义、名单保留、Steam64 身份与阵营分离、昵称显示及完整回合 ADR。

- 规范：[docs/reference/telemetry.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/telemetry.md#L16)；[docs/reference/telemetry.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/telemetry.md#L65)。
- 实现：[packages/core/src/identity/active-lineup.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/src/identity/active-lineup.ts#L8)；[packages/core/src/identity/resolve.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/src/identity/resolve.ts#L232)；[packages/core/src/runtime/player-stats.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/src/runtime/player-stats.ts#L6)；[packages/core/src/projection/player-display-name.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/src/projection/player-display-name.ts#L2)；[apps/companion/src/telemetry/gsi-ingress.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/telemetry/gsi-ingress.ts#L16)。
- 既有验证入口：[packages/core/test/player-stats.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/test/player-stats.test.ts)；[packages/core/test/projection.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/test/projection.test.ts)；[apps/companion/test/gsi-ingress.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/gsi-ingress.test.ts)。
- 证据边界：规范不允许通用跨帧合并；本轮没有重新测量真实 CS2 版本的字段覆盖或统计精度。

## E07

**系列进展、地图绑定、终局结果与检查点** · 对应产品事实：P04–P08、F03、R03–R04、R07。

可支持结论：计划／执行分离、人工绑定门槛、观察结束与正式赛果分离、兼容检查点、结果冲突保留。

- 规范：[docs/reference/architecture.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/architecture.md#L75)；[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L25)。
- 实现：[packages/core/src/series-progress/types.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/src/series-progress/types.ts#L8)；[packages/core/src/series-progress/reducer.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/src/series-progress/reducer.ts#L679)；[packages/protocol/src/match-result.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/protocol/src/match-result.ts#L11)；[apps/companion/src/operator/controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/operator/controller.ts#L11)；[apps/companion/src/runtime/program-runtime.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/runtime/program-runtime.ts#L39)；[apps/companion/src/series-progress/checkpoint-store.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/series-progress/checkpoint-store.ts#L12)。
- 既有验证入口：[packages/core/test/series-progress.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/test/series-progress.test.ts)；[packages/core/test/runtime-same-map-restart.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/test/runtime-same-map-restart.test.ts)；[apps/companion/test/series-progress-runtime.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/series-progress-runtime.test.ts)；[tests/acceptance/workspace-scenes.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/workspace-scenes.spec.ts#L124)。
- 证据边界：手动场景选择不写结果；上游总比分不能反填成未经观察的地图。测试存在不等于当前跨平台现场已验证。

## E08

**雷达、目标计时与 C4 估算** · 对应产品事实：P06–P07、R03–R04、U11。

可支持结论：已校准坐标、缺失不可用；爆炸与拆弹计时分离；估算资格、地图范围、失效隐藏。

- 规范：[docs/guide/data-source-capabilities.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/data-source-capabilities.md#L20)；[docs/reference/telemetry.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/telemetry.md#L43)；[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L63)。
- 实现：[packages/core/src/runtime/objective-timing.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/src/runtime/objective-timing.ts#L5)；[packages/core/src/projection/bomb-damage.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/src/projection/bomb-damage.ts#L9)；[packages/radar/src/index.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/radar/src/index.ts)；[packages/radar-view/src/index.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/radar-view/src/index.ts)；[apps/companion/src/projections/bomb-damage-worker-client.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/projections/bomb-damage-worker-client.ts#L6)。
- 既有验证入口：[packages/core/test/objective-timing.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/test/objective-timing.test.ts)；[packages/radar/test/public-projection.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/radar/test/public-projection.test.ts)；[apps/companion/test/bomb-damage-worker.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/bomb-damage-worker.test.ts)。
- 证据边界：计时独立精度需 docs/validation/objective-timing.md 的实机证据；资源图池与赛事图池不同；平滑不是生成新事实。

## E09

**精确事件、CSTV 与私有辅助边界** · 对应产品事实：P05–P06、R01、R08、U07。

可支持结论：可选正式事件增强；较早时间轴不进入公开节目，重连不继承旧对齐。

- 规范：[docs/reference/telemetry.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/telemetry.md#L85)；[docs/reference/architecture.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/architecture.md#L107)；[docs/roadmap.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/roadmap.md#L29)。
- 实现：[apps/companion/src/telemetry/cstv-source-manager.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/telemetry/cstv-source-manager.ts#L13)；[apps/companion/src/projections/program-cue-coordinator.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/projections/program-cue-coordinator.ts#L15)；[packages/core/src/projection/observer-assist.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/core/src/projection/observer-assist.ts)；[packages/protocol/src/assist.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/protocol/src/assist.ts)。
- 既有验证入口：[apps/companion/test/structured-output.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/structured-output.test.ts#L322)。
- 证据边界：辅助通道当前表达可用性和游标；源码存在不证明完整 Lookahead、自动切人或电影式运镜已交付。

## E10

**制作生命周期、准备门禁与安全收尾** · 对应产品事实：F01、F10、P07–P08、R09。

可支持结论：准备／现场／隐藏分开；退出先等待场景和释放数据源，Host 再关受管游戏及恢复。

- 规范：[docs/reference/architecture.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/architecture.md#L133)；[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L157)。
- 实现：[apps/companion/src/program-scenes/production.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/program-scenes/production.ts#L8)；[apps/companion/src/program-scenes/readiness.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/program-scenes/readiness.ts#L6)；[apps/web/src/preparation/SpectatorWorkflow.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/preparation/SpectatorWorkflow.tsx#L5)；[apps/desktop/src-tauri/src/production_exit.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/production_exit.rs#L101)。
- 既有验证入口：[apps/companion/test/production-lifecycle.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/production-lifecycle.test.ts#L43)；[tests/acceptance/workspace-controls.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/workspace-controls.spec.ts#L71)。
- 证据边界：服务端制作命令的上下文门槛与桌面／Web 启动入口的 OBS/GSI 准备检查分层存在；不能把某个测试命令成功当成所有准备条件均已满足。

## E11

**节目场景、自动编排、手动保持及摘要** · 对应产品事实：F05、P06–P07、R05。

可支持结论：八类场景、预告与实际 Take 分离、人工打断、OBS 确认后提交、统计和结果摘要边界。

- 规范：[docs/design/program-direction-v1.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/design/program-direction-v1.md#L5)；[docs/design/program-direction-v1.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/design/program-direction-v1.md#L29)。
- 实现：[packages/protocol/src/program-scenes.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/protocol/src/program-scenes.ts#L6)；[apps/companion/src/program-scenes/director.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/program-scenes/director.ts#L28)；[apps/companion/src/program-scenes/controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/program-scenes/controller.ts#L76)；[apps/companion/src/program-scenes/presentation.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/program-scenes/presentation.ts#L14)。
- 证据边界：时长与转场是现有选择；手动打开半场／结果和确认赛果不同。普通自动恢复、重连不补演过期 cue。

## E12

**桌面宿主、受管 CS2、焦点与配置恢复** · 对应产品事实：P02、F01、F10、R09、U06。

可支持结论：安装发现、受管进程、视频／帧率／观战设置备份恢复；窗口共享、焦点、隐藏及本机覆盖。

- 规范：[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L80)；[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L180)；[docs/reference/architecture.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/architecture.md#L149)。
- 实现：[apps/desktop/src-tauri/src/managed_cs2.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/managed_cs2.rs#L732)；[apps/desktop/src-tauri/src/cs2_video.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/cs2_video.rs)；[apps/desktop/src-tauri/src/cs2_frame_rate.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/cs2_frame_rate.rs)；[apps/desktop/src-tauri/src/cs2_spectator.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/cs2_spectator.rs)；[apps/desktop/src-tauri/src/workspace_focus.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/workspace_focus.rs)；[apps/desktop/src-tauri/src/workspace_group.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/workspace_group.rs)；[apps/desktop/src-tauri/src/startup_recovery.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/startup_recovery.rs)；[apps/companion/src/program-scenes/desktop-overlay.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/program-scenes/desktop-overlay.ts#L8)。
- 既有验证入口：[tests/acceptance/preparation-review.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/preparation-review.spec.ts)；[tests/acceptance/workspace-controls.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/workspace-controls.spec.ts)。
- 证据边界：浏览器测试不证明 Win32 进程身份、数字键、DPI 或捕获表现。共享工作区不要求双屏、独立 GOTV 或局域网可写。

## E13

**OBS 配置、画面证据、输出控制和平台状态** · 对应产品事实：F01、F07、P07、U03。

可支持结论：场景修复、默认音频显式添加、工作台人工输出启停及确认；OBS 配置实例不自动关闭；B 站状态有限。

- 规范：[docs/guide/product.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/product.md#L33)；[docs/guide/data-source-capabilities.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/data-source-capabilities.md#L31)；[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L201)。
- 实现：[apps/companion/src/obs/outputs.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/obs/outputs.ts#L281)；[apps/companion/src/obs/reconcile.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/obs/reconcile.ts#L10)；[apps/companion/src/obs/audio.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/obs/audio.ts#L16)；[apps/companion/src/obs/program-evidence.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/obs/program-evidence.ts#L5)；[apps/web/src/workspace/ObsOutputControls.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/workspace/ObsOutputControls.tsx#L21)；[apps/desktop/src-tauri/src/obs_configuration.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/obs_configuration.rs)；[apps/companion/src/platform/bilibili.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/platform/bilibili.ts)。
- 既有验证入口：[apps/companion/test/obs-outputs.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/obs-outputs.test.ts)；[apps/companion/test/obs-reconcile.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/obs-reconcile.test.ts)；[tests/acceptance/workspace-controls.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/workspace-controls.spec.ts#L5)。
- 证据边界：来源启用／尺寸／活动、周期缩略图、实际游戏帧和声音分别举证；手册的“在 OBS 启停”不是唯一入口，见 U03。

## E14

**公开输出、授权、名单差异例外及可靠投递** · 对应产品事实：F02–F03、P05、P07–P08、R07–R08。

可支持结论：当前 LIVE 等待同授权／执行的开局确认；过期帧不排队；只有名单差异的展示例外不形成正式结果；可靠队列持久与隔离。

- 规范：[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L55)；[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L216)；[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L226)。
- 实现：[packages/protocol/src/output.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/protocol/src/output.ts)；[apps/companion/src/output/projector.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/output/projector.ts#L59)；[apps/companion/src/output/lineup-mismatch.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/output/lineup-mismatch.ts#L9)；[apps/companion/src/output/reliable-outbox.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/output/reliable-outbox.ts#L9)；[apps/companion/src/output/service.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/output/service.ts#L19)；[apps/companion/src/match-context/rivalhub-connection.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/rivalhub-connection.ts#L187)。
- 既有验证入口：[apps/companion/test/structured-output.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/structured-output.test.ts#L447)；[apps/companion/test/rivalhub-connection.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/rivalhub-connection.test.ts#L121)；[apps/companion/test/reliable-outbox.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/reliable-outbox.test.ts)。
- 证据边界：公开输出没有局域网远程控制含义；两端协同语义和真实服务接收需单独实测，ACK 不能由 HTTP 成功笼统替代。

## E15

**HUD 配置、编辑、启用及文件分享** · 对应产品事实：F06、P06–P08、R06、U04。

可支持结论：内置只读、副本、保存不启用、激活冻结配置、版本冲突、预设包新副本与受控外观范围。

- 规范：[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L146)；[docs/design/hud-broadcast-presets.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/design/hud-broadcast-presets.md#L5)；[docs/design/ui-system.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/design/ui-system.md#L80)。
- 实现：[apps/companion/src/hud-config/store.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/hud-config/store.ts#L197)；[apps/companion/src/hud-config/store.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/hud-config/store.ts#L270)；[apps/companion/src/hud-config/controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/hud-config/controller.ts#L61)；[apps/web/src/operator/HudConsolePage.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/operator/HudConsolePage.tsx#L85)；[packages/hud-config/src/index.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/hud-config/src/index.ts)。
- 既有验证入口：[apps/companion/test/hud-config-store.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/hud-config-store.test.ts)；[tests/acceptance/hud-customization.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/hud-customization.spec.ts#L52)。
- 证据边界：当前 WORKSPACES 只含 preset/layout；数据模型和内部代码有 theme 不等于完整外观工作区开放。

## E16

**节目预览、编辑器样例及同步回放** · 对应产品事实：F04、F06、P06、R06。

可支持结论：普通预览只读；BP 标签复用真实会话；EPL 来源及视频／数据游标、静态降级和样例隔离。

- 规范：[docs/design/program-direction-v1.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/design/program-direction-v1.md#L38)；[docs/development/development-validation.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/development/development-validation.md#L141)。
- 实现：[apps/web/src/preparation/ProgramPreview.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/preparation/ProgramPreview.tsx#L11)；[apps/web/src/operator/replay-fixture.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/operator/replay-fixture.ts)；[apps/web/src/operator/ReplayVideoBackground.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/operator/ReplayVideoBackground.tsx)；[packages/replay/src/index.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/replay/src/index.ts)；[apps/companion/src/replay/production-replay-composition.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/replay/production-replay-composition.ts)。
- 既有验证入口：[tests/acceptance/hud-replay.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/hud-replay.spec.ts)；[tests/acceptance/hud-video-replay.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/hud-video-replay.spec.ts)；[apps/companion/test/fixture-durable-isolation.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/fixture-durable-isolation.test.ts)。
- 证据边界：recorded-projections 的视频素材按已录投影定位，不称为每次在浏览器重跑原始输入；截图不是实机验收。

## E17

**本地 Demo 试播及隔离恢复** · 对应产品事实：F09、P06–P08、R09。

可支持结论：临时 BO1、原生文件选择、试播记录、正式输出／持久状态隔离、失败和重启恢复。

- 规范：[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L96)；[apps/companion/src/demo-test/README.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/demo-test/README.md)。
- 实现：[apps/companion/src/demo-test/controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/demo-test/controller.ts#L156)；[apps/companion/src/demo-test/controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/demo-test/controller.ts#L293)；[apps/desktop/src-tauri/src/demo_test.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/demo_test.rs)；[apps/web/src/preparation/DemoTestPanel.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/preparation/DemoTestPanel.tsx)。
- 既有验证入口：[tests/acceptance/preparation-review.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/preparation-review.spec.ts)。
- 证据边界：playing 是 Host 确认的启动阶段；dataReady 是有效观测，不证明选定文件已加载。拖动后统计和完整正式流程不受本轮保证。

## E18

**本机节目音乐** · 对应产品事实：F08、P06–P08、R05。

可支持结论：七组、音频／ZIP、独立音乐保持、两层自有 OBS 媒体、一次性开场和断连核对。

- 规范：[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L70)；[docs/reference/music.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/music.md#L35)。
- 实现：[apps/companion/src/music/director.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/music/director.ts#L28)；[apps/companion/src/music/cues.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/music/cues.ts)；[apps/companion/src/music/obs-provider.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/music/obs-provider.ts)；[apps/companion/src/music/store.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/music/store.ts)；[apps/companion/src/music/archive.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/music/archive.ts)；[packages/protocol/src/music.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/protocol/src/music.ts)。
- 证据边界：WAV/MP3/OGG/FLAC/M4A，单首 32 MiB；实际解码和输出音轨由 OBS 实测。音乐权利不由软件授予。

## E19

**本机图片、Steam 头像与媒体边界** · 对应产品事实：P04、P06、F06。

可支持结论：本机 PNG/JPEG/WebP 图片，按 Steam64 取可选头像、缓存／密钥设置与清除；不改比赛身份。

- 规范：[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L51)；[THIRD-PARTY-NOTICES.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/THIRD-PARTY-NOTICES.md)。
- 实现：[apps/companion/src/match-context/local-assets.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/match-context/local-assets.ts#L9)；[apps/companion/src/media/steam-avatars.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/media/steam-avatars.ts#L43)；[apps/web/src/preparation/SteamAvatarSettings.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/preparation/SteamAvatarSettings.tsx)。
- 既有验证入口：[apps/companion/test/local-tournament-routes.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/local-tournament-routes.test.ts)。
- 证据边界：本机图片上限当前 512000 字节；素材许可按第三方说明，不从有文件推断有任意再分发授权；此处测试入口不证明 Steam 在线服务可用。

## E20

**本机诊断、完整导出、性能窗口及采集** · 对应产品事实：F11、P07–P08、R11、U05、U11。

可支持结论：操作关联、完整日志／压缩分卷、缺口、问题标记、异常前后输入窗口、失败暂存及重启恢复；采集与支持包分开。

- 规范：[docs/reference/architecture.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/architecture.md#L169)；[docs/reference/diagnostics-delivery.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/diagnostics-delivery.md#L47)；[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L157)。
- 实现：[apps/companion/src/support/session-journal.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/support/session-journal.ts)；[apps/companion/src/support/routes.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/support/routes.ts)；[apps/companion/src/support/archive.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/support/archive.ts)；[apps/companion/src/support/business-history.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/support/business-history.ts)；[apps/companion/src/support/native-source.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/support/native-source.ts)；[apps/companion/src/support/performance-window.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/support/performance-window.ts)；[apps/companion/src/support/performance-spool.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/support/performance-spool.ts)；[apps/companion/src/telemetry/capture-recorder.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/telemetry/capture-recorder.ts)；[apps/desktop/src-tauri/src/support_export.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/support_export.rs)。
- 既有验证入口：[apps/companion/test/support-export.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/support-export.test.ts)；[apps/companion/test/performance-window.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/performance-window.test.ts)；[apps/companion/test/native-source.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/native-source.test.ts)；[tests/acceptance/support-export.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/support-export.spec.ts)。
- 证据边界：日志有保留期和预算，断电未落盘／持续 I/O 错误仍可能缺失；旧版本未记录的信息无法补回，不承诺零损失或自动复现。

## E21

**可选诊断回传、同意及撤回** · 对应产品事实：F11、P07、R11、U05。

可支持结论：默认无端点、无同意；已实现本地队列、暂停、重试、撤回及远端删除确认；排除聊天与同意前记录。

- 规范：[docs/reference/diagnostics-delivery.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/diagnostics-delivery.md#L5)；[docs/reference/diagnostics-delivery.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/diagnostics-delivery.md#L9)；[docs/reference/diagnostics-delivery.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/diagnostics-delivery.md#L65)。
- 实现：[apps/companion/src/support/delivery.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/support/delivery.ts#L140)；[apps/companion/src/support/delivery-routes.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/support/delivery-routes.ts#L6)；[apps/companion/src/server.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/server.ts#L301)；[apps/web/src/debug/DiagnosticDeliverySettings.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/debug/DiagnosticDeliverySettings.tsx)。
- 既有验证入口：[apps/companion/test/diagnostic-delivery.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/diagnostic-delivery.test.ts)；[apps/companion/test/diagnostic-delivery-routes.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/diagnostic-delivery-routes.test.ts)。
- 证据边界：契约明确云接收端尚未配置。七天正文保留是待接入方契约，不能称为已运行的云清理；本轮未部署、连接或创建凭据。

## E22

**安装、应用更新、默认检查与恢复** · 对应产品事实：F11、P07、R10、U02。

可支持结论：可信版本、用户主动安装、制作保护、失败回滚、安装版／便携版区别；当前默认检查实际为开启及六小时。

- 规范：[docs/reference/updates.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/updates.md#L17)；[docs/reference/updates.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/updates.md#L31)；[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L11)。
- 实现：[apps/companion/src/updates/manager.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/updates/manager.ts#L28)；[apps/companion/src/updates/manager.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/updates/manager.ts#L30)；[apps/companion/src/updates/source.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/updates/source.ts)；[apps/companion/src/updates/routes.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/updates/routes.ts)；[apps/desktop/src-tauri/src/updates.rs](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/src/updates.rs)；[apps/web/src/preparation/UpdateNotification.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/preparation/UpdateNotification.tsx)。
- 既有验证入口：[apps/companion/test/updates-manager.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/updates-manager.test.ts)；[apps/companion/test/updates-source.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/updates-source.test.ts)；[tests/acceptance/updates.spec.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/tests/acceptance/updates.spec.ts)。
- 证据边界：U02 为明确冲突，不调和成两种都对的默认值；已保存 false 不改。本轮未核验发布资产或实际升级。

## E23

**官方示例素材 Store、激活和回退** · 对应产品事实：F11、P06–P07、R10。

可支持结论：单一持久缓存、验证／准备／活动版本分开、制作互斥、失败保留与 Full 回退、只读产品入口。

- 规范：[apps/companion/src/resource-store/README.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/resource-store/README.md#L19)；[docs/guide/quick-start.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/guide/quick-start.md#L173)。
- 实现：[apps/companion/src/resource-store/store.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/resource-store/store.ts)；[apps/companion/src/resource-store/routes.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/resource-store/routes.ts)；[apps/companion/src/resource-store/runtime-adapter.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/resource-store/runtime-adapter.ts)；[apps/web/src/preparation/ResourceSettings.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/preparation/ResourceSettings.tsx)。
- 既有验证入口：[apps/companion/test/resource-store/store.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/resource-store/store.test.ts)；[apps/companion/test/resource-store/app-integration.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/resource-store/app-integration.test.ts)。
- 证据边界：Store 有下载／修复能力不等于 renderer 有对应按钮；当前设置只有查询。签名测试反例不证明正式发行正例通过。

## E24

**本地访问、公开数据与模块边界** · 对应产品事实：R04、R08、I、U06。

可支持结论：Companion 组装、Core 事实与独立投影、正式公开输出隔离、LAN 只读与 Host 私有能力。

- 规范：[docs/reference/architecture.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/architecture.md#L29)；[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L100)；[docs/reference/protocol.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/reference/protocol.md#L186)。
- 实现：[apps/companion/src/local-web/origin-policy.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/local-web/origin-policy.ts#L57)；[apps/companion/src/local-web/websocket-transport.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/local-web/websocket-transport.ts)；[apps/companion/src/local-protocol/program-wire.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/local-protocol/program-wire.ts)；[apps/companion/src/local-protocol/operator-wire.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/local-protocol/operator-wire.ts)；[apps/desktop/src-tauri/capabilities/workspace.json](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/desktop/src-tauri/capabilities/workspace.json)。
- 既有验证入口：[apps/companion/test/local-websocket-transport.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/local-websocket-transport.test.ts)；[apps/companion/test/local-web-host.integration.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/local-web-host.integration.test.ts)。
- 证据边界：这些是现系统契约和安全实现；独立重设计不自动继承技术栈和文件结构。没有推出独立多用户账号权限体系。

## E25

**当前视觉、中文与无障碍规则** · 对应产品事实：R02、R12、I。

可支持结论：三类表面、当前视觉、术语、键盘／焦点、减少动效及拖动替代；原布局只作现状。

- 规范：[docs/design/ui-system.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/design/ui-system.md#L72)；[docs/design/mizar-pulse.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/design/mizar-pulse.md)；[docs/design/product-language.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/design/product-language.md)；[docs/development/terminology.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/development/terminology.md)。
- 实现：[apps/web/src/ui/primitives.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/ui/primitives.tsx)；[apps/web/src/ui/primitives.stories.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/ui/primitives.stories.tsx)；[apps/web/src/operator/HudCanvasPreview.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/operator/HudCanvasPreview.tsx)。
- 证据边界：规范要求不等于全产品可用性已获验证；本轮无 UI／视觉修改，不执行 design:check 或宣称视觉审查通过。

## E26

**样例、测试、生产接线和验证证据边界** · 对应产品事实：U08–U11、R12、覆盖核对。

可支持结论：开发样例／排练与正式模式区分；真实链路、单元／浏览器／实机有不同证明范围。

- 规范：[docs/development/development-validation.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/development/development-validation.md#L49)；[docs/development/development-validation.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/development/development-validation.md#L112)；[docs/screenshots/README.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/screenshots/README.md)；[docs/validation/objective-timing.md](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/docs/validation/objective-timing.md)。
- 实现：[apps/companion/src/app.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/app.ts#L49)；[apps/web/src/App.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/App.tsx#L608)；[apps/companion/src/qualification/controller.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/src/qualification/controller.ts)；[packages/testkit/src/index.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/packages/testkit/src/index.ts)。
- 既有验证入口：[apps/companion/test/fixture-durable-isolation.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/fixture-durable-isolation.test.ts)；[apps/companion/test/program-fixtures/replay-acceptance.test.ts](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/companion/test/program-fixtures/replay-acceptance.test.ts)。
- 证据边界：仅阅读既有测试及断言，不把测试数量当覆盖率。本轮执行的是文档引用／覆盖／差异检查，结果在 coverage.md。

## 当前入口与模块定位

本节是维护／复核索引，不是未来信息架构要求。实际路由以 [apps/web/src/App.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/App.tsx#L608) 和 [apps/web/src/preparation/PreparationPage.tsx](https://github.com/Starfie1d1272/Mizar/blob/12d785a8b2cba7dc72cb7f15bc1f1def02a0d31b/apps/web/src/preparation/PreparationPage.tsx#L33) 为准；不要只读取旧的 surfaceDefinitions 摘要判断产品入口。

| 当前入口 | 现状职责 | 对应证据 |
| --- | --- | --- |
| `/`、兼容 `/operator` | 准备中心及制作启动／恢复 | E10、E12 |
| `/matches` | 比赛资料、名单、地图与 BP；含选择与管理入口 | E02–E05 |
| `/picture` | 节目、HUD、本机覆盖入口 | E11、E15–E16 |
| `/settings` | CS2/GSI、OBS、音乐、RivalHub、高级（更新、诊断、资源等） | E12–E13、E18–E23 |
| `/preview`；`?scene=bp` | 普通节目预览；BP 标签使用真实会话并有播出副作用 | E05、E16 |
| `/operator/hud` | HUD 编辑器；导航当前仅预设与布局 | E15 |
| `/operator/bp` | 重定向至 BP 预览工作台 | E05 |
| `/workspace`、`/workspace/left`、`/workspace/dock` | 浏览器预览／桌面面板；真实游戏由桌面宿主独立管理 | E10、E12 |
| `/program`、`/program/bp` 及其它注册场景地址 | 正式 HUD、BP、等待／对阵／半场／结果等输出 | E11 |
| `/debug` | 本地技术状态和支持导出 | E20 |
| `/qualification`、`/__visual/*`、排练接口 | 验收／开发条件入口，普通模式不代表已开启实机验收 | E26 |

| 代码区域 | 当前负责 | 复核关联 |
| --- | --- | --- |
| `apps/companion/src/app.ts`、`server.ts` | 实际服务组装、持久化及特性接线 | E01、E21、E26 |
| `match-context/`、`bp/`、`operator/` | 资料、授权、赛程、BP 与人工命令 | E02–E07 |
| `runtime/`、`projections/`、`series-progress/` | 唯一运行时组合、不同消费面与恢复 | E06–E09 |
| `program-scenes/`、`obs/`、`music/`、`platform/` | 制作生命周期、编排、OBS、音乐和 B 站查询 | E10–E13、E18 |
| `output/`、`local-protocol/`、`local-web/` | 公开输出、可靠队列、本地传输与来源限制 | E14、E24 |
| `hud-config/`、`media/`、`replay/`、`demo-test/` | 配置、媒体、回放及试播隔离 | E15–E19 |
| `support/`、`telemetry/`、`updates/`、`resource-store/` | 日志／采集、诊断回传、更新及资源缓存 | E06、E20–E23 |
| `apps/desktop/src-tauri/src/` | 原生启动、进程／窗口、游戏配置、恢复、工具窗口及更新执行 | E10、E12–E13、E17、E22 |
| `apps/web/src/` | 交互、节目及投影消费，不另推比赛事实 | E02–E26 按任务定位 |
| `packages/core`、`protocol`、`telemetry-*`、`rivalhub` | 领域事实、契约与数据适配 | E02、E04、E06–E09、E14 |
| `packages/radar`、`radar-view`、`hud-config`、`cs2-assets`、`design-tokens` | 雷达几何／展示、可编辑配置、资源及视觉变量 | E08、E15、E19、E25 |
| `packages/replay`、`testkit`、`resource-pack-contract`；`scripts/` | 回放调度、验证工具、资源信任契约、分发／安装／资格工具 | E16、E22–E23、E26 |

精确字段、默认值、传输预算与错误码继续由各负责模块维护。本文只提供查找路径，不再复制一份接口字典或发布工具说明。
