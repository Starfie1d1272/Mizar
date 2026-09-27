# 参考项目与复用边界

参考项目用于验证产品形态、算法、性能和运维实践，不自动成为代码来源或架构 authority。任何代码、资产或运行时依赖真正进入仓库前，都必须重新核对许可证、维护状态和当前版本。

| 项目 | 主要学习点 | 不直接继承 |
| --- | --- | --- |
| `papesgit/hot` / HLAE Observer Tools（核验基线：v0.4.0） | Observer Desk、Delayed Observer Cues、Radar / Viewport cue、游戏画面嵌入工作区 | HLAE injection 不是 Mizar 基础前提；不复制具体布局或把第二个完整 renderer 变成要求 |
| `drweissbrot/cs-hud` | 最小 GSI → 本地服务 → HUD / Radar → OBS，本地优先 | 老旧技术结构和有限产品模型 |
| `mortenlein/eon` | Waiting / Intermission / Result、Operator、Simulator、Radar、确定性测试纪律 | 不继承单体状态结构，不从 Raw GSI 构造展示测试真相 |
| `nsnsay/Zhenhai-HUD-Manager` | TypeScript workspace、手雷/烟火、上下层 Radar、监听器生命周期 | 顶层许可证边界不清；不复制应用代码或建立第二套 Team / Match 数据库 |
| Boltobserv | 专业观察者 Radar、上下层、道具、自动缩放、观察者体验 | GPL-3.0；不作为旁路 runtime，也不复制代码或资产 |
| Lexogrine Obserview | 独立 Radar、头像、画笔、跨设备绘制 | 许可证元数据存在冲突；澄清前不做代码级复用 |
| Lexogrine HUD Manager | 成熟 HUD 管理、面板、BP、摄像机与回放工作流 | Manager 为专有软件，只做产品对照 |
| `lexogrine/cs2-react-hud` | 选手卡、比分条、观察目标高亮等组件拆分 | 不把 LHM contract 变成 RuntimeState 或 Local Protocol |
| JTs-Hud | BYOH、GSI 安装、观察者工具、LHM 兼容 | GPL Manager 不作为底座；不继承本地赛事数据库 |
| `M3MONs/CS2-HUD` | 固定 1920×1080 逻辑画布、离线预览、Radar 高频路径 | 不继承布局编辑器或另一套后端/状态 authority |
| SHUD | OBS、场景、摄像机生产外壳 | 公开源码不足以作为完整实现底座 |
| MulNX | 高级摄像机、电影化能力、localhost API | injection/hook/`-insecure` 属于不同安全域，只作为可选集成研究 |
| Excel2OBS | BP 图卡的逐步展示体验 | 不引入 Excel / OBS source mutation 中间层 |
| MatchZy / CounterStrikeSharp | 可靠服务器事件 | 不要求比赛服务器安装插件，因此不能成为基础 HUD 前提 |
| ValveResourceFormat | Source 2 资源解析、地图数据工具 | 不把完整 Viewer / .NET 应用塞入 Mizar runtime |

## HOT 与 Lookahead

HOT **v0.4.0** 的 Delayed Observer Cues 已经证明“较早时间轴 → 延迟 observer cue”有公开 prior art。Mizar 不宣称这一概念首创。后续如果 HOT 行为发生变化，应重新核对版本，不把这里的 v0.4.0 结论自动外推到未来版本。

Mizar 的差异在于把以下边界组合为同一产品：

```text
headless / no-delay source
+ explicit timeline alignment
+ Program / Assist projection isolation
+ single Program renderer workflow
+ independent local-first mode
+ optional RivalHub canonical context
```

因此 Lookahead 是招牌能力，不是整个产品的唯一定位。

## Radar 参考边界

Radar 拆成三层：

```text
地图几何 / calibration
        ↓
MapGeometryProvider
        ↓
Radar domain
  world→radar / floor / marker / utility
        ↓
Web Radar Renderer
  React / SVG / Canvas / rAF
  temporal interpolation / smoothing / autozoom presentation
```

第三方项目可以帮助验证产品体验或算法，但不能把其状态模型、地图 package shape 或应用 runtime 变成 Mizar 的公共 contract。

## 复用原则

1. 优先复用许可证清晰、职责窄的小型库，不复制整个应用。
2. 产品体验和架构参考不等于源码复用。
3. GPL / AGPL 项目如果仅作研究参考，保持净室实现；代码级复用必须单独评估许可证后果。
4. 专有软件只做产品对照。
5. 第三方内部类型不得成为 Mizar 公共协议或 Core domain 的 authority。
6. 已存在明确 owner 的共享基础设施优先通过 adapter/provider 接入，不再维护第二份真相。
7. 研究结论如果依赖具体版本行为，应在相关 Issue / PR 中保留版本证据；长期文档只保留仍有效的设计结论和必要 provenance。

实际安装的直接第三方依赖和许可证只记录在根目录 [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)。
