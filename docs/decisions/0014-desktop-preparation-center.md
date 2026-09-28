# ADR-0014：Mizar Desktop 准备中心与现场生命周期

状态：Accepted（Issue #94 FINAL）

## 背景

Issue #84 交付了 Tauri workspace Host，但默认入口仍把操作者直接送入现场工作区；比赛创建、设置和工具窗口也没有统一的桌面准备路径。#94 定稿要求把准备、现场展示和既有比赛事实清楚分开，同时保持 Companion 为运行 owner。

## 决策

- Tauri Main 默认打开准备中心，一级入口固定为总览、比赛、画面、设置。Qualification 仍是独立的验收模式，不作为普通制作导航。
- 当前比赛展示统一读取 MatchContextController 的 `MatchDocumentV1` envelope；LocalTournamentStore 只承接本地库、赛程与 mutation。Local 可编辑，RivalHub/cache 完整展示相同资料、队标、名单与 BP，但保持只读。队伍复用显式选择稳定 teamId；服务器快捷创建也提供精确命中已有队伍的选择，不按同名静默合并。
- clean 5v5 首发识别只消费 ProjectionCoordinator 暴露的 ActiveLineup 与当前 source observation。Companion 产生候选并校验 context revision、source generation、map epoch；Browser 不能声明原始 Steam64 身份。侧别可由规范 roster 或精确队名证明时自动映射，否则请求一次人工确认。
- `preparation | live | hidden` 是 Companion 控制的桌面 presentation lifecycle。enter 只要求比赛上下文；hide 保持当前 session；resume 回到同一 Workspace。finish 先选择安全 waiting scene，再释放活跃 source，全部成功后才返回 preparation，并保留赛事资料。等待场景切换失败时不释放 source；release 失败时保持 live/hidden 与 waiting，允许重试同一 cleanup。CAS revision 拒绝基于旧 UI state 的操作。
- Tauri 继续只管理本机窗口、几何和焦点。Main、workspace、HUD/BP/diagnostics/preview 工具、Program Overlay 各自有独立关闭语义。ToolShell 不承载 Main 导航；重复打开工具先恢复 canonical URL，再显示与聚焦。独立节目预览只渲染场景，不执行 OBS scene switch。
- HUD 本机可见性单独存成 widget policy，key 限定当前 HUD registry；各组件默认沿用当前 preset，Radar 覆盖明确默认隐藏。该 host preference 不复制或改写 HUD preset/layout/theme，也不改变 OBS Program。
- OBS 画面确认使用真实当前 Program composition 的有界低频缩略图，不建设高帧率 monitor。Companion 验证截图限额，并在响应前确认 scene 未变。
- Sidecar 贯穿显示器 work area 左侧；managed CS2 位于右侧，最大尺寸限制在 work area 的 75% 宽 × 75% 高并保持 16:9；Dock 只占 CS2 下方区域。
- 进入现场先重新发现 CS2，再按其当前显示器选择 work area；窗口或显示器变化时重新选择并布置，未发现 CS2 才使用主显示器。
- OBS readiness 同时要求连接成功、当前 scene 对齐且配置 findings 为空。未知检查结果不宣称就绪；总览的恢复项只聚合需要下一步操作的问题。
- Local HTTP mutating routes 使用已有 loopback + Origin policy；凭据保留在 Companion/本机安全存储，credential 不进入 renderer。

## 后果

准备状态只能呈现各 owner 的 readiness 与恢复链接，不能成为业务资格判定的新 owner。Roster capture 无新遥测、source generation 改变、map execution 改变或上下文改变时 fail closed。桌面 window placement 的 Windows、CS2、OBS 实机行为仍由 #35 在 exact artifact 上验收；自动化 UI 和 mock OBS 不能替代该验收。

## 验收边界

自动化检查覆盖 HTTP owner/CAS、host visibility policy、候选连续性与数据保留、工作区几何、工具路由和前端交互。只有 Windows + CS2 + OBS 实机证据可关闭 #35 的现场验收。
