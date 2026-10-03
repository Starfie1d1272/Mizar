# 界面与视觉规则

## 三类界面

| 类别 | 冻结方向与现有参考 | 规则 |
| --- | --- | --- |
| 产品界面（Product UI） | Graphite Instrument；BP 工作台 | 中性石墨色背景、Mizar Blue 交互色、低饱和度、细边框、克制层次、紧凑的制作工具布局 |
| 播出画面（Broadcast Graphics） | 赛事优先；BP 全屏播出画面 | 赛事、队伍和比赛为主角；允许更强的层级、图像、动效与画面编排 |
| 诊断界面（Technical UI） | 共享产品界面基础，提高诊断信息密度 | 更密的间距、表格/键值信息、明确分隔、按需展开原始诊断值 |

产品界面主要使用 4/6/8px 圆角。普通面板不依赖浓重阴影或发光；玻璃、霓虹与大型悬浮卡片不作为默认样式。诊断界面共享石墨色、蓝色和状态颜色，技术感来自信息密度与结构；等宽字体只用于原始标识符、协议值和数值诊断，不另建绿色/青色主题。“预览 + 控制/检查面板”是重要的共享工作台组合。

## 设计变量

符合 DTCG 格式的 JSON 位于 `packages/design-tokens/src/`。工具支持本仓库使用的 DTCG 结构：分组与类型继承、`$type/$value/$description/$extensions/$deprecated`、完整变量的 `{path}` 引用，以及 srgb 颜色、px/rem 尺寸、ms/s 时长、字体、数字字重、数值和贝塞尔曲线。暂未使用的复合类型、分组扩展和 JSON Pointer 会明确拒绝；采用新结构时同步扩展校验和测试。

| 层级 | 用途与例子 | 依赖规则 |
| --- | --- | --- |
| 原始值（Base） | `color.gray/blue/amber/...`、`space`、`radius`、`font.size/weight/family`、`motion.duration` | 只表示数值，页面不直接使用 |
| 用途（Semantic） | `bg.canvas/surface/raised`、`fg.primary/secondary/muted`、`border.default/strong`、`accent.primary`、`status.*`、`focus.ring` | 引用原始值或同层变量，不直接写原始数值 |
| 界面差异（Surface） | `product.*`、`broadcast.*`、`technical.*` | 引用用途层或同一界面变量，不另建调色板 |
| 组件与组合 | 稳定复用后才添加专用变量 | 不提前为每个页面建立变量 |

间距、形状、字体和动效的用途入口分别是 `layout`、`shape`、`type`、`transition/easing`。CSS 名称由 `--mizar-` 加变量路径生成，`.` 转成 `-`；声明只来自设计变量包。

校验覆盖结构、类型、名称、重复 JSON 键、CSS 名称冲突、缺失/循环引用、引用类型与层级、生成 CSS 漂移，以及源码中已删除变量的引用。新增组件变量需要实际复用依据、规范、样例和对应层级检查。

## 视觉基础

- **颜色**：共享石墨色中性色、文字、边框、交互和状态变量；新视觉值只进入统一源文件。
- **间距**：以 4px 为基础节奏；产品界面使用紧凑控件与共享间距，诊断界面通过更密间距和信息结构表达技术感。
- **圆角、边框、层次**：主要为 4/6/8px、细边框，普通面板不使用浓重阴影；浮层通过较浅的石墨色、边框与原生对话框遮罩区分。
- **字体与数字**：产品界面沿用 Inter 和中文系统字体回退；紧凑控件 14px、辅助文字 12px、分区标题 20px；准备中心、工作区与编辑器使用 16px 可读字号和 28px 页面标题，均由用途变量提供。数字使用等宽数字排版；原始值使用 `type.family.raw`。播出展示字体保持开放，必须实际比较。
- **动效**：短且有明确目的，使用共享时长与曲线；“减少动效”停止旋转和非必要过渡，不隐藏事实或改变运行时节奏。
- **图标**：尺寸和视觉形式保持一致，提供明确的无障碍名称；CS2 图标只经官方资产管理模块。图标不替代状态文字，装饰符号不参与辅助阅读。

## 颜色职责

| 语义 | 来源 |
| --- | --- |
| 产品交互、选择、焦点、主要操作 | Mizar Blue；`accent.* / focus.ring` |
| 赛事身份、播出画面的轻微视觉处理 | `--mizar-event-accent` |
| 对阵和 BP 的双方配色 | `--mizar-entrant-a` / `--mizar-entrant-b` |
| 游戏阵营 | `--mizar-side-ct` / `--mizar-side-t` |
| 成功、警告、危险、信息 | `status.success/warning/danger/info` |

参赛方 A 不等于 CT，参赛方 B 不等于 T。赛事强调色不表示成功或警告，Mizar Blue 不表示比赛进行中或错误状态。

动态颜色由既有的赛事来源、配置或呈现模块提供并校验，只设置在消费它的局部元素树上，不从颜色反推业务状态。页面不得新增动态颜色通道。旧 BP 变量列入精确迁移清单，迁移后删除。Gameplay 的旧 `rh-hud` 语义变量已迁移。

## 共享组件与页面

`apps/web/src/ui/` 负责基础控件的样式和交互，使用用途或组件变量，不导入比赛、运行时、RivalHub、HTTP/实时客户端或页面逻辑。当前基础组件是 `Button`、`IconButton`、`Field`、`Checkbox`、`Select`、`Panel`、`Divider`、`StatusPill`、`StatusBanner`、`EmptyState`、`Dialog`。

对话框使用原生模态能力，保留键盘焦点、Escape、背景禁用与关闭后焦点恢复；边界 Tab 操作保证焦点留在对话框内。输入框关联字段名称、说明与错误状态；加载按钮禁用并提供 `aria-busy`；图标按钮必须提供名称。状态用文字与辅助阅读语义表达，颜色只作补充。

`apps/web/src/patterns/` 放组合组件。`ToolShell` 承载 HUD/BP/诊断/独立预览工具，只显示工具标题与品牌，不包含 Main 导航。`Workbench`、`PreviewFrame`、`Inspector` 接收展示内容，不获取数据、不推导就绪状态、不维护业务事实。功能页面注入已有的安全投影和命令处理，只负责布局与组合，不重新声明调色板、全局字体、通用圆角/边框/状态或按钮/输入框样式。功能专用几何可以保留，视觉基础引用设计变量。

## 播出渲染例外

Program、Gameplay、Radar 可以拥有固定几何与特定画面风格，但中性色、文字、动效和状态语义仍来自共享变量；赛事、队伍与阵营颜色来自批准的动态通道。

现有 BP 全屏画面的网格纹理、双侧视觉处理、地图卡构图和展示字体属于现有参考。通用 Program 和 Gameplay 的旧主题列入迁移清单，不作为新功能的组件样式来源。

架构检查对 `apps/web/src/program/` 不采用产品界面的原始几何/颜色禁令，但仍检查变量声明来源、旧命名空间、删除变量引用和原始值层引用。其它源码中的旧值按精确声明数量保留。新增一次性播出样式必须记录具体渲染器、视觉目的、颜色职责和可复核画面，并更新精确例外测试，不能用整目录忽略代替。Gameplay 始终遵守 [ADR-0007](../decisions/0007-gameplay-hud-presentation-invariants.md)。

## 无障碍与状态验证

WCAG 2.2 基线包括：可见键盘焦点、不被浮层遮挡、键盘操作、至少 24×24 CSS px 的点击区域或合规间距/等效方式、拖动替代操作，以及颜色不是唯一状态信息。共享控件当前最小点击区域为 32px；小尺寸不能牺牲焦点或操作区域。

对话框和浮层保留可见关闭入口与焦点恢复。加载或禁用时不执行命令；错误提供事实与恢复办法；状态播报不反复朗读高频比赛数据。HUD 编辑器保留 X/Y、键盘和直接控制等拖动替代操作。

每个共享组件覆盖默认状态，以及适用的悬停、可见焦点、禁用、加载、错误/警告/成功、键盘与减少动效状态。Storybook 组件样例在真实 Chromium 中运行，axe 检查名称、角色、对比度和点击区域等；交互断言补充焦点、对话框键盘与减少动效检查。真实产品的可用性仍需人工审查。

### Gameplay resolved Theme 变量

ADR-0013 允许既有 `HudResolvedPreset.theme.semantic` 通过局部变量消费冻结值：`--mizar-hud-text-primary/muted`、`--mizar-hud-state-danger/warning/success/unknown`、`--mizar-hud-objective-bomb/defuse`、`--mizar-hud-surface-primary/strong/opacity`、`--mizar-hud-border-opacity`、`--mizar-hud-radius-sm/md/lg`、`--mizar-hud-font-family`。它们由 strict schema 验证并仅在 `GameplayHud` 根设置，不进入全局 token JSON，不开放给 Widget Settings。赛事色与 CT/T 继续使用已有通道。共同字体回退、动效时长使用 canonical `type.family.body`、`transition.fast/normal`；组件几何和剩余一次性画面美术留在 renderer。当前不开放外观工作区，圆角等未全面消费的字段仍不能宣称为用户可用 capability。

### 默认节目包与桌面工作台（Issue #107 视觉复查）

- 单图结果保留大比分为主角。Barlow Condensed Bold 随包加载，消除系统 Impact 字体缺失时的宽体回退差异；数字使用 `type.family.display`，固定 1920×1080 构图。背景只使用已导入的本图地图缩略图，并弱化细节。
- 队徽使用固定容器；宽标按自然宽高比适当加宽，方标保持相同光学高度。无素材显示队名缩写；不补造队徽。对阵开场继续透明叠加于真实游戏，预览背景仅供演示。
- 半场、图间和整场数据页保留十人镜像表格。头像使用固定 120px 单元格和 96px 裁切，缺图时保留单元格；中间留出 K/D 轴，数字列保持稳定。高对比选图标签和中性隔行底色提高可读性。
- 赛前等待以赛事、双队身份、开赛时间、前后场赛程构成四级信息，不根据计划时间生成倒计时。
- 准备中心按资料密度设置宽度；预览和 HUD 编辑器扩大画布，属性面板保持固定宽度。工作区保留游戏区域，现场播出控制优先，连接详情和维护操作按需展开。工作区雷达默认完整地图，四周保留内边距；HUD 雷达默认也为完整地图，自动聚焦由用户显式选择。
- 原有 Gameplay HUD 的组件、配色、信息量、布局与 Radar 均不在本轮重绘范围。

本轮字体、媒体单元格与结果底图属于 `ProgramScenePage` 的播出呈现；不新增 runtime 颜色或数据通道。复核见 `tests/acceptance/program-direction.spec.ts` 的长名称、缺失素材、多赛制、比分边界和动效交接检查。产品交互继续复用 Button / Panel / Select 和原生 details，状态来源与命令不变。
