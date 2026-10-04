# Mizar

Mizar 是一套 **本地优先、开源、中文优先的 CS2 赛事制播工具**，面向校园赛、社区赛和小型赛事的解说、OB 与制作人员。它把比赛资料、HUD、雷达、节目场景和 OBS 控制放进同一套本地工作流。

## 为什么使用 Mizar

- **为长时间直播稳定性设计。** HUD 和雷达优先消费当前状态，避免积压旧帧后越来越慢半拍；实际稳定性与性能仍需用具体版本的真实赛事环境验证。
- **从准备到播出，一处完成。** 创建或选择比赛，检查 CS2 / GSI / OBS，预览画面后进入现场；比赛资料可以保存在本机并复用。
- **减少比赛中的手动切节目。** 现场默认自动编排赛前等待、对阵、BP、比赛中、半场、单图结果、图间和整场结果；需要接管时手动切换，确认后再恢复自动。
- **让身份与比分跟随比赛连续变化。** 共用运行时维护阵容、换边、地图与系列赛进度；缺少证据时提示或安全隐藏，不靠昵称猜身份或补造赛果。
- **选择适合赛事的画面。** 默认、类 EWC、类 IEM、类 Perfect World、类ESL HUD 可预览、另存和启用；支持受控的布局与组件设置，以及预设文件分享。
- **为现场刷新、断线和重启设计。** 保留比赛资料与已启用预设，重连取得当前状态；遇到故障可以检查配置、修复 OBS 场景并导出诊断摘要。

## 开始使用

Windows 用户将完整便携包解压到可写目录，双击 `Mizar.exe`，从「总览 / 比赛 / 画面 / 设置」开始准备。包内带 Node；桌面需要 Microsoft Edge WebView2 Evergreen Runtime。

按 [快速开始与故障排查](docs/quick-start.md) 完成 GSI、OBS、比赛与 HUD 配置。进入现场后，私有 Workspace 围绕真实 CS2 画面展开；正式节目由 OBS 输出。预览画面不会自行切换 OBS 场景，推流启停由操作者确认。

支持两种运行方式：

- **独立模式**：使用本机比赛资料运行 HUD、雷达和节目流程，不需要 RivalHub 在线服务。
- **RivalHub 连接模式**：通过授权加载赛事平台已有比赛资料；两种模式共享相同的本地制播运行时。在线接管、恢复和云端数据链路有各自的适用验收边界。

Gameplay HUD 还提供可关闭的 **C4 爆炸伤害预测**：内置十张地图资源，按当前位置与站立姿态估算，仅在已下包或拆弹且爆炸倒计时最后十秒内显示。它不改变真实血量，也不保证必死或必活。操作与不显示的原因见 [C4 说明](docs/quick-start.md#c4-爆炸伤害预测)。

当前正在准备 1.0 候选版本。代码、自动化检查与真实 Windows + CS2 + OBS 验收分别记录；尚未据此宣称 1.0 正式发布或实机 PASS。候选版本移交规则见 [RC 与发布检查清单](docs/release-readiness.md)，对外文案初稿见 [发布说明草案](docs/release-notes-draft.md)。

## 后续方向与生态

RivalHub 负责赛事运营和官方上下文，Mizar 负责现场制播，DAK（CS2 Demo Analysis Kit）面向赛后分析。它们可以围绕赛事协作，当前不承诺一键贯通的完整云端闭环。

Lookahead / Observer Assist 是独立的增强研发方向，尚不作为现成的观察辅助能力宣传；未来信息必须保持私有，不能进入正式节目。更多美术方案、可安装视觉包和社区分发按后续需求推进。能力与依赖边界见 [产品文档](docs/product.md) 和 [路线](docs/roadmap.md)。

## 核心边界

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
/preview   节目预览与 BP 工作台
/operator/bp  重定向到 BP 预览工作台
/workspace  私有制播工作区
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

- [`docs/quick-start.md`](docs/quick-start.md)：Windows 首次使用、GSI/OBS、HUD 预设、C4、现场控制与故障恢复。
- [`docs/release-readiness.md`](docs/release-readiness.md)：exact RC 的构建身份、资源与实机验收移交。
- [`docs/release-notes-draft.md`](docs/release-notes-draft.md)：待最终版本和实机证据冻结的发布说明。

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

在准备中心「比赛」配置比赛资料，通过「节目预览」的 BP 工作台核对来源、填写本地 BP、播放与收起；浏览器入口为 `/preview?scene=bp`。BP 全屏输出 `/program/bp` 与 Gameplay `/program` 分开，OBS 的 Mizar 场景由设置页检查和修复。操作步骤见 [快速开始](docs/quick-start.md#节目编排与现场控制)。

### 结构化输出的 HTTP reference adapter

可通过 `MIZAR_LIVE_OUTPUT_URL` / `MIZAR_RELIABLE_OUTPUT_URL` 配置独立 HTTPS POST 目标，并用 `MIZAR_OUTPUT_TOKEN` 提供 scoped Bearer credential。Snapshot 采用 latest-wins；可靠事件采用持久 outbox 与幂等键。响应、超时及恢复语义见 [协议文档](docs/protocol.md#http-outbound-reference)。
