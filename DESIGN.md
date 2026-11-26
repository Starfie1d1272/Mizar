---
name: "Mizar · 导播工作台与准备中心"
description: "Graphite Instrument，以冷石墨界面承托准备与现场制播操作。"
colors:
  primary: "rgb(38 114 223 / 1)"
  primary-hover: "rgb(35 104 209 / 1)"
  bg-selected: "rgb(29 45 67 / 1)"
  fg-link: "rgb(167 201 255 / 1)"
  focus-ring: "rgb(167 201 255 / 1)"
  bg-canvas: "rgb(11 16 24 / 1)"
  bg-surface: "rgb(17 23 32 / 1)"
  bg-raised: "rgb(22 28 38 / 1)"
  bg-hover: "rgb(27 35 48 / 1)"
  fg-primary: "rgb(241 245 249 / 1)"
  fg-secondary: "rgb(195 206 218 / 1)"
  fg-muted: "rgb(148 163 184 / 1)"
  fg-on-accent: "rgb(255 255 255 / 1)"
  border-default: "rgb(38 49 65 / 1)"
  border-strong: "rgb(130 144 161 / 1)"
  status-info: "rgb(167 201 255 / 1)"
  status-success: "rgb(52 211 153 / 1)"
  status-warning: "rgb(251 191 36 / 1)"
  status-danger: "rgb(252 165 165 / 1)"
  action-danger: "rgb(185 28 28 / 1)"
  action-danger-hover: "rgb(153 27 27 / 1)"
typography:
  headline:
    fontFamily: "'Inter', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "'Inter', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif"
    fontSize: "20px"
    fontWeight: 600
  title-card:
    fontFamily: "'Inter', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif"
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: "'Inter', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-strong:
    fontFamily: "'Inter', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontFamily: "'Inter', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  raw:
    fontFamily: "'SFMono-Regular', 'Consolas', monospace"
rounded:
  control: "4px"
  panel: "6px"
  preview: "8px"
spacing:
  base-step: "4px"
  compact: "8px"
  gap: "12px"
  padding: "16px"
  target: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.fg-on-accent}"
    rounded: "{rounded.control}"
    typography: "{typography.body-strong}"
    padding: "6px 12px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.fg-primary}"
    rounded: "{rounded.control}"
    typography: "{typography.body-strong}"
    padding: "6px 12px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.bg-hover}"
  button-danger-workspace:
    backgroundColor: "{colors.action-danger}"
    textColor: "{colors.fg-on-accent}"
    rounded: "{rounded.control}"
    typography: "{typography.body-strong}"
    padding: "2px 8px"
    height: "{spacing.target}"
  button-danger-workspace-hover:
    backgroundColor: "{colors.action-danger-hover}"
  field:
    backgroundColor: "{colors.bg-canvas}"
    textColor: "{colors.fg-primary}"
    rounded: "{rounded.control}"
    typography: "{typography.body}"
    padding: "{spacing.compact}"
    height: "40px"
  select:
    backgroundColor: "{colors.bg-canvas}"
    textColor: "{colors.fg-primary}"
    rounded: "{rounded.control}"
    typography: "{typography.body}"
    padding: "{spacing.compact}"
    height: "40px"
  checkbox:
    height: "{spacing.target}"
  panel:
    backgroundColor: "{colors.bg-surface}"
    rounded: "{rounded.panel}"
    padding: "{spacing.padding}"
  status-pill-info:
    textColor: "{colors.status-info}"
    typography: "{typography.label}"
  status-pill-success:
    textColor: "{colors.status-success}"
    typography: "{typography.label}"
  status-pill-warning:
    textColor: "{colors.status-warning}"
    typography: "{typography.label}"
  status-pill-danger:
    textColor: "{colors.status-danger}"
    typography: "{typography.label}"
  status-banner:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.fg-secondary}"
    rounded: "{rounded.control}"
    typography: "{typography.body}"
    padding: "12px 16px"
  nav-item:
    textColor: "{colors.fg-secondary}"
    rounded: "{rounded.control}"
    typography: "{typography.body-strong}"
    padding: "8px 12px"
    height: "44px"
  nav-item-hover:
    backgroundColor: "{colors.bg-hover}"
  nav-item-current:
    backgroundColor: "{colors.bg-selected}"
    textColor: "{colors.fg-link}"
    rounded: "{rounded.control}"
  dialog:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.fg-primary}"
    rounded: "{rounded.preview}"
    padding: "{spacing.padding}"
  preview-frame:
    backgroundColor: "{colors.bg-canvas}"
    rounded: "{rounded.preview}"
---

# Design System: Mizar · 导播工作台与准备中心

## Overview

**Creative North Star: "Graphite Instrument"**

冷静、简洁、以现场操作为先。冷石墨底承托内容，细边界区分功能区，Mizar Blue 指向当前选择和主要操作。产品入口使用仓库中的正式标志，沿用原有比例、颜色与留白。 [产品定义](PRODUCT.md) · [品牌规范](docs/design/brand.md)

开播前能扫清待办，现场能一眼找到常驻控制和需要处理的异常。正常等待、自动成功和低频细节保持安静。需要核对时，界面保留各自的状态含义，并给出当下可做的操作。 [产品文案](docs/design/product-language.md)

**Key Characteristics:**

- 冷石墨色阶与细边框，主要操作使用 Mizar Blue。
- 紧凑、熟悉、状态明确的原生控件。
- 现场控制保持位置稳定，异常详情按需展开。

适用范围为表面 A 的准备中心、现场工作台与独立操作工具，包括诊断子面及编辑器的操作外壳。内嵌预览在本文件中只涉及外框、状态提示和操作区。

Frontmatter 收录现有工作台令牌，运行时取值由 DTCG 源和生成 CSS 管理。修改令牌时从源文件生成 CSS，并同步本文件与 `.impeccable/design.json`。侧车文件中的 OKLCH 色阶仅用于预览面板。 [令牌源](packages/design-tokens/src/) · [生成 CSS](packages/design-tokens/generated/tokens.css) · [界面规范](docs/design/ui-system.md)

## Colors

### Primary

- **Mizar Blue**（`primary`、`primary-hover`）用于主按钮，以 `fg-on-accent` 白字呈现。浅蓝 `fg-link` 用于链接，`focus-ring` 用于可见焦点，`bg-selected` 用于当前项底色。对应 `accent.primary`、`accent.hover`、`fg.link`、`focus.ring` 和 `bg.selected`。

### Neutral

- **冷石墨底**（`bg-canvas`）用于窗口底面和输入区域。`bg-surface` 承载普通面板，`bg-raised` 承载按钮和浮层，`bg-hover` 反馈中性控件悬停。
- `fg-primary` 用于主要内容，`fg-secondary` 用于字段标签和说明，`fg-muted` 用于辅助元数据。`border-default` 划分区域，`border-strong` 用于强化边界与控件悬停。

### Semantic states

- `status-info`、`status-success`、`status-warning`、`status-danger` 用于有名称的事实反馈。`action-danger` 和 `action-danger-hover` 是危险操作的按钮底色，搭配 `fg-on-accent`。
- 赛事与队伍资料中的身份色沿用既有来源，在所属元素内使用。 [颜色职责](docs/design/ui-system.md#颜色职责)

**The 颜色按职责使用 Rule.** 交互、状态和赛事身份各按现有用途取色。状态须同时提供文字，必要时补充辅助阅读语义。

## Typography

产品正文采用 Inter，中文依次回退到 Microsoft YaHei UI、Microsoft YaHei、PingFang SC 和 Noto Sans CJK SC。保持 `font-synthesis: none`，验收环境使用真实常规与粗体字重。中文标题保持自然字距。

| 层级 | 用途 |
| --- | --- |
| `headline` | 准备中心页标题（28px），沿用产品壳层的标题行高。 |
| `title` | 主要分区、对话框与空状态标题（20px）。 |
| `title-card` | 准备卡片小标题与需要清楚读出的内容（16px）。 |
| `body` / `body-strong` | 正文、输入内容与按钮（14px）。按钮使用强调字重，尺寸由共享控件定义。 |
| `label` | 字段标签、状态标签与辅助信息（12px）。 |
| `raw` | 诊断标识符、协议值与原始数字的等宽字体栈。 |

比分、计时与并排数字使用等宽数字排版。诊断正文沿用产品字体，以紧凑键值结构组织细节。 [字体规范](docs/design/ui-system.md#视觉基础)

## Layout

以 4px 为基础节奏。常用组合使用 `layout.compact`（8px）、`layout.gap`（12px）和 `layout.padding`（16px）。产品组合沿用 `product.density.gap`，诊断组合沿用 `technical.density.gap`。容器尺寸与控件内距由各自作用域负责。

- **准备中心**采用左侧制作导航和原生 CSS 视口填充，主内容区独立滚动并保留 `scrollbar-gutter: stable`，使用原生 1:1 CSS 像素，DPI 交由系统/WebView 处理；阅读/配置页居中限宽，工作区/编辑器页铺满窗口。最大化、标题栏、任务栏与还原由 Windows 宿主负责。
- **现场工作台**围绕受管 CS2 窗口平铺。左栏按可用 CSS 像素组织雷达、摘要和 OBS 核对缩略图。独立原生底栏以 1280 × 240 作为最小逻辑预算（空间充足时原生铺满，不足时向下缩放并撑满两个维度），固定场景、观战、输出与单行异常／退出区的空间。八个场景入口同时可见，底栏与各分区全量可见且不滚动，长内容通过详情打开。
- **独立工具与窄容器**复用 `ToolShell`，采用视口填充布局与原生 1:1 CSS 像素。组合工作台的预览与检查区按各自断点切到单列。BP 操作表单按实际容器宽度重排。比赛库长名称允许换行，长列表和详情在各自内容区滚动，底部操作保持可见。

**The 常驻控制完整可见 Rule.** 共享控件以 32px 为逻辑点击目标基线，现场底栏在标准 1080p@150% 预算基线下缩放后实际点击高度至少 24px。Windows 验收覆盖 1080p、1440p 的 100%、125%、150% 缩放，核对边界、遮挡与溢出。 [缩放画布](apps/web/src/patterns/ScaledCanvas.tsx) · [现场布局规范](docs/design/ui-system.md#播出视觉与工作台)

## Elevation & Depth

普通面板平铺，浮层用色阶与遮罩分隔。底面、面板和抬升面的石墨色阶配合细边框表达归属。模态对话框使用抬升面、增强边框和原生遮罩。

**The 动效反馈操作 Rule.** 交互状态使用已有短过渡。系统请求减少动效时，停止非必要过渡和加载旋转，保留文字反馈、可用操作和事实时序。 [共享控件样式](apps/web/src/ui/ui.css)

## Shapes

- 共享按钮、选择框和输入框用 `shape.control`（4px）；普通面板用 `shape.panel`（6px）；预览外框与共享对话框用 `shape.preview`（8px）。
- 静态轮廓通常为 `line.border`（1px）。共享控件以 `line.focus`（2px）画可见焦点。分隔线组织同一任务内的内容，状态圆点辅助扫描。

## Components

紧凑、熟悉、状态明确。采用设计令牌、`ui/`、`patterns/`、功能页面的复用顺序。UI 基础组件处理视觉与交互，组合组件接收展示内容，功能页面传入已有投影与操作。 [基础组件](apps/web/src/ui/primitives.tsx) · [组合组件](apps/web/src/patterns/) · [组件目录](docs/design/README.md#组件目录与参考)

| 组件 | 现有用法 |
| --- | --- |
| `Button` / `IconButton` | 默认次要按钮用抬升面和细边框，主要按钮用蓝底白字。共享按钮显示焦点，加载期间显示「处理中…」并提供 `aria-busy`，禁用时给出视觉反馈。图标按钮提供无障碍名称。现场底栏的「结束本次制作」使用红字描边，确认框内的结束操作使用深红实底。基础 `Button` 提供 `primary` 与 `secondary` 两种变体。 |
| `Field` / `Select` / `Checkbox` | 输入和选择用冷石墨底，保留标签、可见焦点及关联说明。字段错误在输入附近显示。布尔项用带可点标签的共享复选框。 |
| `Panel` / `Divider` / `EmptyState` | 面板和分隔线组织同一任务。空状态交代缺少什么，在存在有效操作时给出该入口。 |
| `StatusPill` / `StatusBanner` | 简短状态用圆点加文字，需要处理的情况用带侧边状态线的横幅。异常说明包括事实和一个主要动作，详细证据按需打开。 |
| `SourceBadge` | 以文字和图形区分示例／回放与本场资料。预览标识置于画框上沿外侧，准备任务的风格参考标识置于图外，与「已启用」同一行。BP 预览标明本场来源，缺少 BP 时保留本场空态。 |
| `Dialog` / `useConfirmation` | 阻断交互时用原生模态。动作放在底部统一区域，窄窗口可换行。危险确认默认聚焦取消，Esc 取消，关闭后焦点回到触发处。可就地修复的问题保留就地入口。 |
| `OperatorShell` / `ToolShell` | 准备中心使用单色线性导航图标、`aria-current` 和选中底色。HUD 独立工具用单行上下文条保留返回入口及 OBS 连接、直播与录像状态。 |
| `Workbench` / `PreviewFrame` / `Inspector` / `LibraryWorkspace` | 工具复用预览加检查区。比赛库复用列表、详情和底部操作区，浏览候选与切换本场使用不同操作。 |

保持草稿、已保存资源与当前启用状态可辨。编辑区提供保存，正式启用在独立位置。在直播、重连或录像期间启用 HUD 前须确认。停止直播、停止录像和结束本次制作分别说明影响并确认。「返回设置」保留制作会话。 [产品约束](PRODUCT.md#capabilities-and-constraints) · [确认组件](apps/web/src/ui/useConfirmation.tsx)

现场左栏直接提供「GoTV 连接」，本场与本图资料从「本场」展开。底栏输出区统一呈现 OBS 连接、直播与录像。节目区保留完整 16:9 的「下一场景」缩略图。仅人工接管或自动暂停时显示「恢复自动」。底栏在常态提示手动切场的后果。 [界面规范](docs/design/ui-system.md#播出视觉与工作台)

## Do's and Don'ts

### Do

- **Do** 在准备中心突出下一步，在工作台保持常驻控制的位置和完整点击区。
- **Do** 用贴近操作的中文说明异常。游戏输入、名单、OBS 连接与输出、网站同步等各自保留状态含义。
- **Do** 检查键盘、可见焦点、减少动效、禁用、加载、失败、长文本和缺失媒体。窗口贴边、焦点与 DPI 需要 Windows 实机证据。

### Don't

- **Don't** 将常态成功徽章堆满页面，或用重复标题、编号和说明抢占主要操作。
- **Don't** 用通用「已就绪」吞掉独立状态。缺失或待确认的事实保留其实际含义。
- **Don't** 从历史迁移白名单复制旧视觉值、组件配方或变量命名空间。新增操作界面沿用共享令牌和组件。

### 历史迁移例外

下列是当前操作面在架构守卫中的精确迁移例外。守卫按文件、声明和出现次数匹配，后续迁移应收缩条目。下列值和样式均不进入 frontmatter 或组件样例。

| 位置 | 已有例外 |
| --- | --- |
| [旧产品壳层](apps/web/src/product-shell.css) | 旧自定义变量与命名空间、直接色值、顶栏与输出链接的字体／圆角／阴影配方。 |
| [操作壳层](apps/web/src/operator/operator-shell.css) | 旧 `.operator-panel` 的 10px 圆角，以及跳转链接 `.product-skip` 的 6px 字面圆角。 |

诊断子面沿用共享令牌和技术信息密度。Companion 独立资格检查页的旧变量与色值、测试样例的字面值各在原清单内管理。 [精确迁移清单](scripts/architecture/design-legacy.json) · [架构守卫](scripts/architecture/design.mjs) · [迁移议题 #917](https://github.com/Starfie1d1272/Mizar/issues/917)
