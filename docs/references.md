# 参考项目与复用边界

Mizar 借鉴开源社区的 HUD、雷达和制播经验。研究参考不等于源码或素材已被使用；实际依赖、资源和许可统一见[第三方说明](../THIRD-PARTY-NOTICES.md)。

| 项目 | 学习方向 | 边界 |
| --- | --- | --- |
| HOT / HLAE Observer Tools | 观察者工作台、较早时间轴提示 | 不要求注入；观察提示不是 Mizar 首创 |
| cs-hud | 本地 GSI → HUD / 雷达 → OBS | 不继承旧应用结构 |
| Eon | 等待/中场/结果、控制台、模拟与测试 | 不复制单体状态模型 |
| Zhenhai HUD Manager | 道具、楼层、监听器生命周期 | 许可需单独核实，不复制应用代码 |
| Boltobserv、Lexogrine Obserview | 观察者雷达与交互 | 仅作产品对照；复用前核对许可 |
| Lexogrine HUD Manager、CS2 React HUD | HUD 管理与组件组织 | 管理器与开源 HUD 许可不同，外部契约不成为 Mizar 领域模型 |
| JTs-Hud、M3MONs/CS2-HUD | 安装、画布、雷达与预览 | 不引入另一套比赛数据库或后端 |
| SHUD、MulNX | 制作外壳与高级摄像机 | 公开资料或注入能力不能当作基础前提 |
| Excel2OBS | BP 图卡展示 | 不增加 Excel 中间数据源 |
| MatchZy / CounterStrikeSharp | 服务器事件 | 基础 HUD 不要求服务器插件 |
| ValveResourceFormat | Source 2 资源处理 | 开发期提取，运行时不带完整工具 |

## 复用原则

优先使用许可清晰、职责明确的小型库。真正引入代码、资产或依赖前核对许可、来源与维护状态；第三方解析器类型在适配器内结束。已有模块负责的事实不再建立第二份。

研究依赖特定版本时，在对应 Issue / PR 保留版本和证据；长期文档只留下仍有效的结论。当前产品能力以[产品定位](product.md)为准，不因参考项目具备某功能就宣传 Mizar 已实现。
