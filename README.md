# Mizar

**让校园赛事，也有职业赛场的转播呈现。**

Mizar 是面向校园与社区 CS2 赛事的开源制播系统。结合游戏实时数据与赛事资料，自动组织从赛前到赛后的节目画面，将 HUD、雷达、OBS 控制与直播状态集中在一个制播工作台。

[开始使用](docs/quick-start.md) · [画面预览](docs/screenshots/README.md) · [文档](docs/README.md) · [参与开发](CONTRIBUTING.md)

![Mizar 默认节目包装的半场数据页](docs/screenshots/halftime.png)

*当前浏览器示例画面；截图来源与 Windows 实机待补范围见[画面预览](docs/screenshots/README.md)。*

## 比赛进行到哪里，节目就呈现到哪里

从赛前等待、BP 和对阵开场，到比赛 HUD、半场数据、单图结果、图间与整场结果，Mizar 根据比赛进程自动编排节目并切换 OBS 场景。需要接管时手动切场，确认后再恢复自动。

GSI 提供游戏实时数据，本地资料或赛事平台提供队伍、赛程和 BP。画面、比分与节目流程共用这些信息，减少现场重复填写和常规切场操作。

## 游戏、全局与播出，一处掌握

Windows 制播工作台围绕真实 CS2 画面展开：大雷达帮助解说和观察者理解局势，比赛资料与制作提示给出下一步，OBS 画面确认、推流状态和 B 站开播状态帮助检查播出情况。

## 一套完整包装，多种 HUD 风格

Mizar Pulse 默认包装贯穿赛前、局内和赛后；另有类 EWC、类 IEM、类 Perfect World、类 ESL 四套 HUD 风格。支持组件设置、布局调整和预设文件分享，预览满意后再启用。

更多画面见[预览图集](docs/screenshots/README.md)。

## 独立办赛，也能连接赛事网站

本机创建比赛即可使用，无需 RivalHub 在线服务。接入 RivalHub 后可复用已有赛事资料，并向网站提供局内实时状态与雷达；其他平台可基于公开接口适配。

RivalHub 负责赛事运营，Mizar 负责现场制播，[DAK](https://github.com/Starfie1d1272/cs2-demo-analysis-kit) 面向赛后分析。已有接口、适用限制与后续方向分别见[产品说明](docs/product.md)、[数据源能力](docs/data-source-capabilities.md)和[路线图](docs/roadmap.md)。

## 为持续制播而设计

借鉴开源社区的 HUD、雷达与制播经验，Mizar 用统一的数据链路支撑节目：高频状态只保留最新值，慢页面不积压无限旧帧；重连恢复当前状态，缺少数据时明确降级。设计与验证依据见[架构](docs/architecture.md)和[开发验证](docs/development-validation.md)。

当前处于 1.0 候选版本准备阶段。**先构建 RC，再用该包完成 Windows + CS2 + OBS 实机验收**；最终发布状态见 [Release Closure #90](https://github.com/Starfie1d1272/Mizar/issues/90)。使用入口与系统要求见[快速开始](docs/quick-start.md)。

## 开源与致谢

使用 [AGPL-3.0-only](LICENSE)。感谢开源社区提供的实践与工具，CS2 资源处理使用 [ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat)。依赖、字体和素材权利见[第三方说明](THIRD-PARTY-NOTICES.md)，研究来源见[参考项目](docs/references.md)。
