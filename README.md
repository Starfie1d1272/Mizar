# Mizar

Mizar 是一套 **本地优先、开源、中文优先的 CS2 赛事制播工具**，面向校园赛、社区赛和小型赛事的解说、OB 与制作人员。它把比赛准备、HUD、雷达、BP、节目画面和 OBS 控制组织在同一个现场工作区中。

## 为什么用 Mizar

| 现场需要解决的问题 | 当前能力与演进方向 |
| --- | --- |
| **长时间直播也不应该越来越慢半拍** | 高频画面数据只保留当前状态，慢页面不会让旧状态无限积压；浏览器重连直接获取当前画面数据。真实 Windows + CS2 + OBS 的长时间稳定性与性能仍需现场验收。 |
| **减少一直盯着按钮切场景的负担** | 当前支持制作人员手动切换节目场景。1.0 目标是由比赛状态自动推进正常节目流程，手动接管后保留控制权；自动推进尚未完成。 |
| **换边、半场、换图后，队伍与比分仍然正确** | 队伍身份与 CT/T 阵营分开维护，系列赛比分与已结束地图结果保持独立；地图计划与实况冲突时提示确认，不猜测结果。 |
| **比赛资料尽量只维护一次** | 独立模式只填双方队名与 BO 即可创建比赛，再补名单、图片、地图池和 BP；连接 RivalHub 可复用已有赛事资料。 |
| **从赛前准备到赛后结果，一套工具完成** | 准备中心、现场工作区、HUD、雷达、BP、节目场景与 OBS 已共用同一套比赛资料；完整自动节目编排继续按 1.0 路线图完善。 |
| **断线、刷新、重启后还能继续工作** | 本地比赛资料和兼容的已完成回合、地图结果可恢复；页面重连获取当前状态。断流或身份冲突会明确降级，缺失数据不会被当作新的比赛事实。 |

长时间直播后 HUD 逐渐延迟、拖滞是项目的真实出发点之一，但当时没有证明唯一根因。Mizar 为长时间直播稳定性设计；实际效果以[真实环境验收](docs/development-validation.md)为准。

赛事播出以赛事自己的名称、队伍和视觉为主。当前可配置 HUD 预设、布局与外观；完整赛事视觉包属于后续方向，见[路线图](docs/roadmap.md)。

## 开始使用

从 [Windows 快速开始](docs/quick-start.md)完成启动、CS2 数据接入、OBS 配置和故障恢复。桌面默认打开准备中心，在「比赛」创建本地比赛或选择已连接的 RivalHub 赛程，确认后进入现场工作区。

**独立使用不需要 RivalHub。** 本地赛事资料、HUD、雷达和基础节目流程均在本机运行；RivalHub 连接模式为已有赛事提供第一方资料集成。两种模式共用同一套制播能力。

## 产品形态

```text
Mizar
├─ 独立模式
│  ├─ 本地比赛上下文
│  ├─ HUD / Radar / OBS
│  └─ 制播工作区 / 观察辅助（按能力逐步完善）
│
└─ RivalHub 连接模式
   └─ 通过版本化契约读取 RivalHub 的完整赛事上下文
```

校园赛、社区赛和小型赛事是重要适用场景，不是第三种运行模式；它们既可以独立使用 Mizar，也可以选择连接 RivalHub。

共享运行时、HUD、雷达和观察辅助不依赖 RivalHub 内部数据库或页面实现。两种运行方式共享同一套 Runtime 和领域模型，只在赛事上下文来源上不同。完整产品边界见 ADR-0006。

产品可以从四个层次理解：

- **制播工作区（Mizar Workspace）**：制作人员实际使用的统一工作环境；CS2 画面保持视觉主体，雷达、状态、控制和辅助信息围绕它组织。

Windows 正式桌面入口使用 Tauri 2 Host，默认打开 Main 准备中心（`/`），在“总览 / 比赛 / 画面 / 设置”完成制作准备；首次进入现场时才创建左栏、底部 Workspace 和本机 Program Overlay。Companion 继续管理 OBS。浏览器可在 `/workspace` 检查同一套现场界面；Program Scene 清单由 `packages/protocol` 统一提供。启动失败会保留本机诊断日志并显示原生错误提示；真实 CS2/OBS 的现场验收边界见 [`docs/development-validation.md`](docs/development-validation.md)。
- **Lookahead 观察辅助**：利用较早的比赛时间轴，为延迟播出画面生成低干扰的确定性提示。
- **运行时基础**：负责数据源连续性、身份、状态、Projection、本地协议、replay 和有界投递。
- **中文、开源、本地优先**：降低校园赛与社区赛的部署门槛，并让赛事方长期掌控自己的制播工具。

## 未来生态：RivalHub · Mizar · DAK

三个项目承担互补职责：

| 阶段 | 项目与职责 |
| --- | --- |
| 赛前与赛事运营 | [RivalHub](https://github.com/Starfie1d1272/RivalHub)：报名、队伍、赛程、BP 与官方赛事事实。 |
| 现场与直播 | Mizar：实时比赛数据、HUD、雷达、节目画面、OBS 与制播工作区。 |
| 赛后与分析 | [DAK](https://github.com/Starfie1d1272/DAK)：Demo、赛后证据、统计与分析。 |

这是长期互补方向。当前已有的 RivalHub 集成不代表整套平台已能供任何赛事方一键部署；Mizar 的独立使用始终保留，DAK 的赛后分析也不成为现场播出的前置条件。

## 为什么可靠：核心边界

Mizar 不建立第二套官方赛事数据库，也不把实时观测直接当成官方事实。

```text
赛事上下文提供方
        ↓
   MatchContext
        ↓
CS2 数据源 → RuntimeState
                ├─ ProgramProjection
                ├─ RadarFrame
                ├─ OperatorProjection
                ├─ ObserverAssistProjection
                └─ DebugProjection
```

关键约束：

- 官方赛事事实与本地实时观测分权；
- Core 只有一份 `RuntimeState`，不同消费面通过独立 Projection 读取所需数据；
- 播出画面只消费 Program-safe 数据；
- Lookahead 的未来信息只进入观察辅助，不进入播出画面、OBS 正式输出或公开实时状态；
- 高频 snapshot 采用 latest-wins 的有界投递，不积压旧状态；
- 数据源重连、进程重启、地图执行和比赛会话使用不同的连续性标识；
- Raw GSI 和第三方 CSTV parser 类型都被限制在各自 adapter 内；
- Renderer 不直接读取 Raw GSI、RivalHub API 或整个 `RuntimeState`。

详细边界见 [`docs/architecture.md`](docs/architecture.md)。

## 本地界面

生产构建由 Companion 同时提供静态网页与本地 WebSocket：

```text
/          制作准备中心
/program   播出画面
/program/bp  BP 全屏播出画面
/operator/bp  BP 控制与预览
/operator  制作控制
/operator/hud  Gameplay HUD 控制台
/debug     运行诊断
```

默认监听：

```text
http://127.0.0.1:3000
```

开发环境的 Web 页面默认运行在：

```text
http://127.0.0.1:4173
```

非本机回环访问必须显式开启 `LOCAL_WEB_LAN_MODE=1`，并通过 `LOCAL_WEB_ALLOWED_ORIGINS` 提供精确 Origin allowlist。

播出画面使用 Local Protocol V1。当前 channel schema 版本以 [`packages/protocol/src/version.ts`](packages/protocol/src/version.ts) 为唯一代码来源；协议语义见 [`docs/protocol.md`](docs/protocol.md)。

## 仓库结构

```text
apps/
  companion/            本地服务、组合根、GSI/CSTV 接入、网页与协议承载
  web/                  播出画面、制作控制、运行诊断

packages/
  cs2-assets/           CS2 official presentation assets、semantic catalog 与 provenance
  design-tokens/        统一的 DTCG 设计变量与生成 CSS
  core/                 RuntimeState、连续性、身份、transition、Projection
  hud-config/           HUD preset、layout、theme、组件 registry 与逻辑几何
  protocol/             Mizar 自有的 Local Protocol
  radar/                与前端框架无关的 Radar domain
  radar-view/           可独立安装的共享 React Canvas 雷达、样式和地图资源
  replay/               framework-neutral discrete replay cursor 与 scheduler
  rivalhub/             RivalHub 赛事上下文 adapter
  telemetry-gsi/        Raw GSI 解析与标准化
  telemetry-cstv/       CSTV GameEvent adapter
  testkit/              capture 读取、replay、模拟和故障注入

docs/                   产品、架构、协议、验证和决策文档
fixtures/               可复现测试数据
scripts/                架构检查、CI、现场验收和维护工具
```

## 文档

- [`docs/quick-start.md`](docs/quick-start.md)：Windows 首次使用、GSI/OBS、进入/退出现场、诊断导出与故障恢复。

- [`docs/design/README.md`](docs/design/README.md)：唯一设计系统入口、三类界面、设计变量、共享组件与文案。
- [`docs/product.md`](docs/product.md)：产品定义与需求。
- [`docs/architecture.md`](docs/architecture.md)：当前架构与 ownership。
- [`docs/protocol.md`](docs/protocol.md)：RivalHub 只读契约与 Local Protocol。
- [`docs/telemetry.md`](docs/telemetry.md)：GSI / CSTV 数据语义。
- [`docs/development-validation.md`](docs/development-validation.md)：开发、CI 与真实环境验收模型。
- [`docs/roadmap.md`](docs/roadmap.md)：能力依赖与演进顺序。
- [`docs/references.md`](docs/references.md)：参考项目与复用边界。
- [`docs/terminology.md`](docs/terminology.md)：机器格式与开发者术语；用户文案见设计系统。
- [`docs/decisions/`](docs/decisions/)：架构决策记录。
- [`docs/rfcs/`](docs/rfcs/)：尚未完全冻结的专项设计。

文档默认使用中文。用户界面优先使用自然中文；开发者文档保留能精确对应代码、协议和架构边界的 canonical term。代码标识符、协议字段、标准专名和第三方项目名保持原文。具体规则见 [`docs/terminology.md`](docs/terminology.md)。

## 开发与验证

常用命令：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm architecture:check
pnpm acceptance:test
pnpm local-web:production-smoke
```

1.0.0 前的 HUD 视觉迭代通过本地 fixture / 真实回放人工验收；CI 不维护或比较 screenshot baseline。

CI 根据改动面选择必要的验证 lane；未知路径、工具链、workflow 和 CI planner 变更会 fail closed 到完整验证。真实 Windows + CS2 + OBS 验收与普通自动化验证分开管理，详见 [`docs/development-validation.md`](docs/development-validation.md)。

## 许可证

Mizar 使用 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**。

直接第三方依赖及其许可证见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。研究参考项目不等于本仓库包含其代码或资产，相关边界见 [`docs/references.md`](docs/references.md)。

## 致谢与第三方说明

- Counter-Strike 2 官方矢量资产与元数据管道基于开源工具 [ValveResourceFormat / Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat) 提取并反编译生成。详细许可证与版权信息参见 `THIRD-PARTY-NOTICES.md`。

## BP 播放

在准备中心（`/`）的「比赛」页可先只填双方队名与 BO 创建本地比赛，再逐步补齐赛事、赛程、名单、图片与地图池；BP 不是创建前置条件。在 `/operator/bp` 工作台确认来源与 BP 后，可播放/收起并在同一页面预览。RivalHub 比赛复用已绑定的比赛上下文；独立模式的比赛资料保存到 Mizar 本机赛事库，BP 继续由现有 consumer 读取兼容视图，不会反写 RivalHub。系统每 1.6 秒逐项揭示，最终完整 BP 保持显示。OBS 添加 `http://127.0.0.1:3000/program/bp`，宽 1920、高 1080，作为独立不透明的全屏赛前场景装载；它与 `/program` Gameplay 分开。服务重启后恢复当前比赛上下文，播放会话保持收起。

### 结构化输出的 HTTP reference adapter

可通过 `MIZAR_LIVE_OUTPUT_URL` / `MIZAR_RELIABLE_OUTPUT_URL` 配置独立 HTTPS POST 目标，并用 `MIZAR_OUTPUT_TOKEN` 提供 scoped Bearer credential。Snapshot 采用 latest-wins；可靠事件采用持久 outbox 与幂等键。响应、超时及恢复语义见 [协议文档](docs/protocol.md#http-outbound-reference)。
