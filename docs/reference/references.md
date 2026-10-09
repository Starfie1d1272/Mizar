# 参考项目与复用边界

Mizar 借鉴开源社区的 HUD、雷达和制播经验。以下列出设计与技术参考；实际依赖、资源和许可统一见[第三方说明](../../THIRD-PARTY-NOTICES.md)。

| 项目 | 学习方向 | 边界 |
| --- | --- | --- |
| [HOT / HLAE Observer Tools](https://github.com/papesgit/hot) | 观察者工作台、较早时间轴提示 | 观察辅助按独立数据源与隔离规则设计 |
| [cs-hud](https://github.com/drweissbrot/cs-hud) | 本地 GSI → HUD / 雷达 → OBS | 运行结构由 Mizar 当前架构维护 |
| [Eon](https://github.com/mortenlein/eon) | 等待/中场/结果、控制台、模拟与测试 | 采用 Mizar 的领域状态与独立投影 |
| [Zhenhai HUD Manager](https://github.com/nsnsay/Zhenhai-HUD-Manager) | 道具、楼层、监听器生命周期 | 研究前核对公开资料与许可 |
| [Boltobserv](https://github.com/boltgolt/boltobserv)、[Lexogrine Obserview](https://github.com/lexogrine/obserview) | 观察者雷达与交互 | 仅作产品对照；复用前核对许可 |
| [Lexogrine HUD Manager](https://github.com/lexogrine/hud-manager)、[CS2 React HUD](https://github.com/lexogrine/cs2-react-hud) | HUD 管理与组件组织 | 分别核对管理器与开源 HUD 许可，通过适配器衔接外部契约 |
| [JTs-Hud](https://github.com/JohnTimmermann/JTs-Hud)、[M3MONs/CS2-HUD](https://github.com/M3MONs/CS2-HUD) | 安装、画布、雷达与预览 | 复用既有比赛信息与本地服务 |
| [SHUD](https://github.com/fyflo/SHUD)、[MulNX](https://github.com/Co1Swet/MulNX_CS2) | 制作外壳与高级摄像机 | 基础能力使用公开观战数据，增强能力按接入条件评估 |
| [Excel2OBS](https://github.com/loseisbest/Excel2OBS) | BP 图卡展示 | BP 资料由统一比赛文档提供 |
| [MatchZy](https://github.com/shobhit-pathak/MatchZy) / [CounterStrikeSharp](https://github.com/roflmuffin/CounterStrikeSharp) | 服务器事件 | 服务器事件可作为基础 GSI 的补充 |
| [CS2 Insight Agent](https://github.com/DrEAmSs59/CS2-insight-agent) | 启动前持久备份、异常恢复、读回核验与设置入口 | 针对在线观战独立实现有限配置备份与恢复 |
| [ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat) | Source 2 资源处理 | 在开发期提取并记录素材来源 |

## 复用原则

优先使用许可清晰、职责明确的小型库。真正引入代码、资产或依赖前核对许可、来源与维护状态；第三方解析器类型在适配器内结束。比赛事实由既有模块统一维护。

研究依赖特定版本时，在对应 Issue / PR 保留版本和证据；长期文档只留下仍有效的结论。当前产品能力以[产品定位](../guide/product.md)为准，对外介绍以已交付能力为依据。
