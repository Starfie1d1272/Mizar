# RivalHub Broadcast

RivalHub Broadcast 是一套 **本地优先、开源、中文优先的 CS2 赛事制播工具**。它把赛事上下文、CS2 实时数据、HUD、雷达、场景、制作控制和观察辅助放在同一套可靠运行时上，同时保持播出画面与辅助信息严格隔离。

产品方向同时包含**独立模式**和 **RivalHub 连接模式**。RivalHub 是最完整的第一方赛事上下文提供方，但不应成为运行 HUD、雷达、播出画面或观察辅助的前置条件。当前实现优先服务自己的真实赛事，并逐步补齐独立模式所需的本地比赛配置、安装与使用体验。

## 产品形态

```text
RivalHub Broadcast
├─ 独立模式
│  ├─ 本地比赛上下文
│  ├─ HUD / Radar / OBS
│  └─ 制播工作区 / 观察辅助（按能力逐步完善）
│
└─ RivalHub 连接模式
   └─ 通过版本化契约读取 RivalHub 的完整赛事上下文
```

校园赛、社区赛和小型赛事是重要适用场景，不是第三种运行模式；它们既可以独立使用 Broadcast，也可以选择连接 RivalHub。

共享运行时、HUD、雷达和观察辅助不依赖 RivalHub 内部数据库或页面实现。两种运行方式共享同一套 Runtime 和领域模型，只在赛事上下文来源上不同。完整产品边界见 ADR-0006。

产品可以从四个层次理解：

- **制播工作区（Broadcast Workspace）**：制作人员实际使用的统一工作环境；CS2 画面保持视觉主体，雷达、状态、控制和辅助信息围绕它组织。
- **Lookahead 观察辅助**：利用较早的比赛时间轴，为延迟播出画面生成低干扰的确定性提示。
- **运行时基础**：负责数据源连续性、身份、状态、Projection、本地协议、replay 和有界投递。
- **中文、开源、本地优先**：降低校园赛与社区赛的部署门槛，并让赛事方长期掌控自己的制播工具。

## 核心边界

RivalHub Broadcast 不建立第二套官方赛事数据库，也不把实时观测直接当成官方事实。

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
  core/                 RuntimeState、连续性、身份、transition、Projection
  hud-config/           HUD preset、layout、theme、组件 registry 与逻辑几何
  protocol/             Broadcast 自有的 Local Protocol
  radar/                与前端框架无关的 Radar domain
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

- [`docs/product.md`](docs/product.md)：产品定义与需求。
- [`docs/architecture.md`](docs/architecture.md)：当前架构与 ownership。
- [`docs/protocol.md`](docs/protocol.md)：RivalHub 只读契约与 Local Protocol。
- [`docs/telemetry.md`](docs/telemetry.md)：GSI / CSTV 数据语义。
- [`docs/development-validation.md`](docs/development-validation.md)：开发、CI 与真实环境验收模型。
- [`docs/roadmap.md`](docs/roadmap.md)：能力依赖与演进顺序。
- [`docs/references.md`](docs/references.md)：参考项目与复用边界。
- [`docs/terminology.md`](docs/terminology.md)：中文术语与用户可见文案规则。
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

RivalHub Broadcast 使用 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**。

直接第三方依赖及其许可证见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。研究参考项目不等于本仓库包含其代码或资产，相关边界见 [`docs/references.md`](docs/references.md)。

## 致谢与第三方说明

- Counter-Strike 2 官方矢量资产与元数据管道基于开源工具 [ValveResourceFormat / Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat) 提取并反编译生成。详细许可证与版权信息参见 `THIRD-PARTY-NOTICES.md`。

## BP 播放

在 `/operator/bp` 工作台确认来源与 BP 后，可播放/收起并在同一页面预览。RivalHub 比赛复用已绑定的比赛上下文；没有可用 BP 时，可结构化填写本地比赛与 veto。保存会把填写内容转换成标准 Broadcast Manifest 并写入现有本机缓存，不会反写 RivalHub。系统每 1.6 秒逐项揭示，最终完整 BP 保持显示。OBS 添加 `http://127.0.0.1:3000/program/bp`，宽 1920、高 1080，作为独立不透明的全屏赛前场景装载；它与 `/program` Gameplay 分开。服务重启后比赛上下文从同一缓存恢复，播放会话保持收起。
