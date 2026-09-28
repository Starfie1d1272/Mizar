# ADR-0013：HUD 受控组件定制

- 状态：Accepted
- 日期：2026-09-28
- 决策来源：Issue #100；1.0 发布前不保留旧版本兼容的用户决定
- 延续：ADR-0007、ADR-0012

## 背景

Radar 设置已有 schema，但编辑器手写特例，其余组件缺少受控字段与默认值。新增字段应由现有组件 registry 扩展，不建立第二套配置或比赛数据 owner。

## 决策

四层职责固定如下：Layout 只负责显隐、锚点、偏移与受控尺寸；Widget Settings 只负责内容选择和组件行为；Theme / Design Tokens 负责共同视觉语义；Program / Radar 负责比赛事实。左右选手栏共用语义实现，只镜像物理布局。

`HudWidgetDescriptor` 是扩展入口：source owner、renderer availability、variants、默认 variant、resize policy、placement、每个 variant 的 strict settings schema/default 与 framework-neutral `editorControls` 一起声明。当前只使用 boolean/select，控件声明路径、中文名称、适用 variant 和合法选项；没有真实有界数值需求时不提前增加 number 类型。descriptor 构建时检查 schema/default/control 一致性。

通用 Inspector 复用产品基础控件，先验证再更新 preset draft。Variant 切换从目标 variant 的声明默认值开始，不携带不兼容字段。当前观察选手提供标准/精简信息方案；精简结构隐藏 media 与统计，仅开放备用弹药开关且默认关闭，保持核心生命、护甲、当前物品和固定 envelope。方案改变信息密度，不冻结另一套最终美术。其余组件保持默认 variant；Radar 仍是唯一 square resize。

保存与启用继续走 Companion 的 revision compare-and-swap。Authoring 的已声明字段可由当前 schema 默认值补齐；未知字段/variant/类型拒绝。Resolved snapshot 必须完整，不能加载时补齐当前默认值或重新计算 Theme recipe。新 resolved 格式显式使用 v2，1.0 前不提供旧版本迁移或读取兼容；当前版本的已启用内容仍在保存与重载后保持冻结。

Gameplay 共同颜色通过 schema 校验过的 resolved Theme 传入局部 `--mizar-hud-*` 变量；赛事强调色与 CT/T 使用既有 `--mizar-event-accent`、`--mizar-side-ct/t`。这些变量只在 Gameplay 子树设置，具体白名单见设计系统规范。共同字体回退与动效消费 canonical tokens。Renderer 保留固定几何、图标组合、地图美术与组件网格，不新增通用颜色、字体或 CSS 编辑器。

## 验证与后果

配置、控件、Renderer、Companion 保存/重载/启用与浏览器语义测试保护扩展链路。设置不修改安全投影或重新计算事实；隐藏附加信息保留预留位置。后续美术主要修改 renderer / variant / CSS，无需重建 Runtime、Program、Radar、Replay 或持久化生命周期。真实 Windows + CS2 + OBS 验收与自动化证据继续分开。
