# Mizar 设计系统

本目录是 Mizar 视觉规范与界面文案的唯一入口。设计规则在这里维护，页面 CSS、Issue 和聊天不另立规范。产品界面、播出画面和诊断界面共享同一套设计基础。产品边界见 [产品文档](../product.md)，源码职责见 [架构文档](../architecture.md) 与 [ADR-0012](../decisions/0012-design-system-governance.md)。

| 文档 | 维护内容 |
| --- | --- |
| [brand.md](brand.md) | Mizar / Alcor 品牌、标志、图标、品牌动效，以及桌面入口与播出画面的品牌归属 |
| [ui-system.md](ui-system.md) | 三类界面、视觉基础、颜色语义、共享组件、无障碍要求 |
| [product-language.md](product-language.md) | 用户能看到的标题、字段、提示、状态、错误与操作文案 |
| [术语文档](../terminology.md) | 机器契约与开发者术语、字段和状态的准确含义 |
| [验证文档](../development-validation.md) | 自动检查、视觉审查与真实环境验收 |

## 源码职责

```text
packages/design-tokens/src/*.tokens.json
  原始值（Base）→ 用途（Semantic）→ 界面差异（Surface）→ 稳定复用的组件与组合
                         ↓
packages/design-tokens/generated/tokens.css → dist/tokens.css
                         ↓
apps/web/src/ui/ → apps/web/src/patterns/ → 功能页面
                                           ↑
                                        业务数据
```

设计变量由 `packages/design-tokens` 统一定义。原始值不直接供页面使用；用途层表达背景、文字、交互和状态等语义；界面层只表达真正存在的差异。组件专用变量在稳定复用后才增加，当前共享组件直接使用已有用途变量。ToolShell 工具窗口壳层复用产品基础，只组织工具标题与内容，不获取业务状态或提供 Main 导航。

`ui/` 放基础组件，`patterns/` 放多个页面共用的组合。基础组件不导入比赛、运行时、RivalHub 或功能页面逻辑；组合组件只组织界面，不维护业务事实。设计变量包只输出静态 CSS，没有运行时依赖。

## 组件目录

Storybook 是共享组件的预览与测试工具。本仓库把其中的 story 称为“组件样例”：一个样例展示一种组件及其状态，例如按钮的常规、禁用或加载状态。样例只展示基础组件与组合组件，不复制整站，也不定义制播流程。

运行 `pnpm design:catalog` 查看，`pnpm design:catalog:build` 构建。目录只加载 `ui/`、`patterns/` 中的 `*.stories.tsx`，只用于开发和检查，不会进入产品构建。赛事样例使用 RivalHub 生产库中公开可见的 2026 NJU Rivals 记录快照；本仓库副本于 2026-09-24 读取，来源记录在 `packages/rivalhub/src/demo/rivals-bp-records.ts`。决赛队伍、地图、比分和选图已于 2026-09-28 通过只读查询复核。基础控件本身不读取赛事资料。错误、禁用和加载状态用于检查控件行为，不代表真实比赛状态。

## 修改流程

1. 确认页面属于哪类界面，先查已有变量、基础组件和组合组件。
2. 修改 JSON 源文件，运行 `pnpm design:tokens:generate`；生成的 CSS 不手工编辑。
3. 更新对应规范、组件样例与架构/测试规则。
4. 运行 `pnpm design:check`，再执行受影响页面所需的类型、浏览器或真实环境验证。
5. 在 PR 中审查视觉效果、职责边界与状态可用性。

设计变量数值或组件样式调整没有改变语义时，更新 `ui-system.md` 并接受 PR 审查，无需 ADR。新增可复用组合或界面规则时，同步规范、样例和检查。产品级语义改变，例如播出画面的品牌归属、默认明亮界面、独立诊断主题或状态颜色职责，需要新 ADR 或明确产品决策。

Issue #94 桌面准备中心属于产品界面；Tauri 窗口与工作区遵循 ADR-0010 窗口 owner。页面复用 design tokens、`apps/web/src/ui/` 共享基础组件和现有产品变量；新增页面样式只负责布局。现场布局按 CS2 实际 client area 与显示器可用区域适配，不因浏览器截图建立像素基线。桌面全屏布局需同时检查 Sidecar 与 Dock 的键盘焦点、窄窗口滚动、状态提示和减少动效。

## 每个界面 PR 必答

- 属于产品界面、播出画面还是诊断界面？
- 已有设计变量和共享组件是否能表达？
- 新视觉值为何需要进入设计系统？
- 新组件仅服务当前功能，还是可以复用？
- 是否新增比赛运行期间提供的颜色？
- 是否覆盖键盘、可见焦点、减少动效、禁用、加载与错误状态？
- 是否需要实际视觉验收证据？

禁止为单页建立新主题、复制大段 CSS 形成第二份共享组件、用原始颜色表达已有状态、为临时需求增加全局变量，或为了截图检查改变正确的业务与运行时语义。

## 渐进迁移与自动检查

`architecture:check` 检查设计变量的声明来源、已删除变量引用、生成物同步和组件依赖方向。产品与诊断界面不得新增写死的颜色、通用圆角、阴影或字体样式。固定播出几何、地图/美术资产与受控比赛颜色属于明确例外；具体播出样式见 `ui-system.md`，Gameplay HUD 继续遵守 ADR-0007。

`scripts/architecture/design-legacy.json` 是精确到文件、声明和数量的历史迁移清单。旧值不能复制到新选择器或文件。页面重构时删除对应 CSS 和清单项，不增加旧样式额度。新增一次性播出样式例外，必须记录渲染器、用途、规则与视觉证据，并添加精确检查和测试。

| 现有旧样式 | 迁移目标 |
| --- | --- |
| broadcast-shell | 产品界面设计变量 |
| HUD Editor 绿色主题 | 产品界面基础与编辑辅助线语义 |
| Debug 绿色/青色主题 | 诊断界面设计变量 |
| Workspace 青绿色主题 | 产品界面基础与比赛状态呈现 |
| 通用蓝色径向渐变 Program | 赛事优先的播出画面 |
| Gameplay HUD | 已迁移共同语义到 schema 校验的局部变量；剩余组件美术按 ADR-0013 渐进调整 |

迁移随对应页面重构进行，不建立永久并存的两套变量。1.0 视觉定稿前不维护全站截图/像素基线；定稿或 RC 阶段只增加小型标准视觉用例集，详见验证文档。

## 实践依据

- [DTCG Format 2025.10](https://www.designtokens.org/tr/2025.10/format/)：变量结构、类型和引用。
- [Primer Foundations](https://primer.style/product/getting-started/foundations/) 与 [变量命名](https://primer.style/product/primitives/token-names/)：基础、组件和用途命名。
- [Atlassian design tokens](https://atlassian.design/foundations/design-tokens)：跨界面的共同视觉决策。
- [Storybook 测试](https://storybook.js.org/docs/writing-tests)：独立组件状态、交互与无障碍验证。
- [WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)：焦点、键盘、拖动替代操作与点击区域。

这些标准用于管理与验证，不替代 Mizar 的具体美术决策。
