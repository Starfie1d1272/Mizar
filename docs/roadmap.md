# 能力演进路线

本文只描述能力依赖与阶段边界，不记录当前完成度、Issue 编号、负责人或短期排期。

原则：**每个阶段都要产生可独立验证的能力，不通过“先堆大文件、以后再拆”换取进度。**

## A. 可靠运行时基础

目标：建立所有产品线共享且长期稳定的本地基础。

包括：

- GSI 与可选 GameEvent 数据源适配；
- RuntimeState / RuntimeTransition；
- source continuity / generation；
- identity / match binding；
- bounded latest-wins delivery；
- capture / replay / fault injection；
- Program / Assist 数据隔离；
- Local Protocol 与 schema 版本化；
- architecture guard；
- 风险分层 CI。

完成标准：HUD、Radar、Workspace 和 Lookahead 都能在不修改这些基础 ownership 的情况下继续演进。

## B. 独立 Program 产品

目标：即使不连接 RivalHub，也能作为可用的 CS2 本地 HUD / 制播工具运行。这一阶段对应 ADR-0006 的**独立模式**产品方向；校园赛、社区赛和小型赛事是主要适用场景，但不是独立的运行模式名称。

包括：

- 本地比赛上下文；
- 完美平台 V1 的 `延迟直连 GOTV → 真实 CS2 → GSI` 正式运行方案；
- Gameplay HUD；
- Radar Renderer；
- 基础配置；
- Program Browser Source；
- Waiting / Matchup / Gameplay 等最小节目流程；
- 中文操作界面；
- 可重复视觉与浏览器回归。

这一步决定独立模式是否真正成立。

## C. 完整制播工作区

目标：把游戏、雷达、状态和制作控制收敛为更低认知负担的工作环境。

包括：

- Broadcast Workspace；
- CS2 画面为主体的私有工作区；
- 更易读的 Radar；
- Operator 控制；
- BP / Veto playback；
- Halftime / Map Result / Match Result；
- 恢复与诊断；
- Windows / OBS 生产验收。

工作区只改变产品体验，不建立第二套 RuntimeState。

## D. 观察辅助

目标：使用独立 Lookahead 时间轴帮助同一名解说兼 OB 提前准备切镜。该阶段是独立增强研发线，**不阻塞 B 的 Program 产品或 C 的制播工作区**。

当前完美平台环境只有直连 GOTV 地址；HTTP Broadcast 支持不能被视为完美平台无延迟数据的现成接入方式。默认方向是保持单个 Program CS2，并由轻量的无头 Direct CSTV 客户端读取较早地址。

**无头直连 CSTV 客户端后续新建独立仓库研发和维护。** RivalHub-Broadcast 不承担 Direct CSTV 网络协议实现，只保留 Lookahead 接入、时间轴对齐、FutureKillCue 和 Observer Assist。

包括：

- 无延迟直连 CSTV 接入；
- Program ↔ Lookahead 时间轴对齐；
- 数据源重连后重新证明对齐关系；
- FutureKillCue；
- 可配置提前量；
- 私有 Assist Host；
- 真实比赛人因验证。

第一层产品保持低信息密度：countdown + killer → victim；只有真实使用证明需要时才增加聚类、推荐焦点或更复杂 cue。

## E. RivalHub 深度集成

目标：在不牺牲独立模式能力的前提下复用 RivalHub 的完整赛事上下文和数据闭环。

包括：

- Match / Roster / Steam64 / BP / schedule / branding；
- pairing / auth；
- ReliableObservation；
- BroadcastLiveSnapshot；
- 有界可靠投递与恢复；
- 公共 live projection 的跨仓兼容验证。

RivalHub 是更完整的 context provider，不反向成为 Core、Radar 或 Lookahead 的运行依赖。

## F. 分发与运维硬化

目标：让非开发者可以稳定安装、运行、升级和恢复。

包括：

- Windows packaging / launcher；
- 配置迁移；
- 日志与诊断导出；
- production preset；
- 长时间 soak；
- 安全与凭据边界；
- 版本兼容与回滚；
- 运维手册。

## 跨阶段约束

所有阶段始终遵守：

- 官方事实与 observation 分权；
- Program / Assist non-leak；
- 高频快照不建立历史 FIFO；
- Raw GSI / third-party parser types 不穿透 adapter；
- 共享能力先复用现有 owner；
- 第二个真实 consumer/provider 出现前不抽象通用插件框架；
- 用户可见文案中文优先；
- 开发者文档保留 canonical engineering terms；
- 真实 Windows + CS2 + OBS evidence 不由 mock 或 CI 代替。

### #35 分发边界

B / M2 的生产收口包含 Web-first 便携 Windows 产品与最小 EXE launcher。F 继续负责最终 installer、updater、migration、signing、rollback 与长期分发硬化。Phase 0 先独立验收 Web 产品壳，不改变 Runtime 或 Gameplay ownership。
