# HUD 与节目展示

`@mizar/hud-view` 共享原生 HUD、Pulse 场景与 BP 的 React 展示实现。`ProgramView` 接收已投影的数据、配置与导演状态；订阅、设备控制和比赛事实留在宿主。减少动效由宿主传入。Web 正式播出和预览使用同一入口。

构建输出包含组件及样式。`ProgramView` 的 `resolveAssetUrl` 由宿主映射内置字体、图片和雷达素材的路径；默认保留 Mizar Web 路径。赛事投影中的队标和头像 URL 保持原样。独立导出仍需收集并提供相应素材。

`apps/lhm-export` 是基于该公共入口的 LHM 独立浏览器运行时。构建时预编译共享视图，导出时将当前已启用配置和内置素材装入 ZIP；不将运行时连接、比赛事实或机器路径写入包。支持范围及 HTTP 入口见 [协议](../../docs/reference/protocol.md#独立-lhm-hud-导出)。
