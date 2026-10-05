# 设计系统

这里维护当前视觉、界面与文案规则。产品目标见[产品定位](../product.md)，历史取舍见[设计审查归档](../archive/design/README.md)。

| 文档 | 唯一负责的内容 |
| --- | --- |
| [品牌](brand.md) | Mizar / Alcor、标志与赛事身份 |
| [界面规则](ui-system.md) | 三类界面、设计变量、组件、颜色与无障碍 |
| [Mizar Pulse](mizar-pulse.md) | 默认节目与 HUD 的视觉语言 |
| [HUD 风格](hud-broadcast-presets.md) | 四套其他 HUD 的风格差异与展示规则 |
| [节目编排与展示](program-direction-v1.md) | 场景衔接、统计范围、预览语义 |
| [产品文案](product-language.md) | 用户可见名称、操作与状态表达 |

中文写作见[术语规范](../terminology.md)，验证方法见[开发验证](../development-validation.md)。精确视觉值以设计变量和组件源码为准，不在多篇文档重复维护数值表。

## 修改流程

1. 确认属于产品、播出还是诊断界面，查找已有规则和组件。
2. 复用设计变量 → `apps/web/src/ui/` → `apps/web/src/patterns/` → 功能页面。页面负责布局与组合，基础组件不读取业务状态。
3. 变量改源 JSON，执行 `pnpm design:tokens:generate`，不手改生成 CSS；新共享组件增加 Storybook 样例。
4. 更新唯一负责该规则的文档，删除旧样式及对应迁移清单项，不增加旧样式额度。
5. 执行 `pnpm design:check` 和改动所需的其他验证；附实际画面与来源说明。

## 界面 PR 审查项

- 目标界面与已有变量、组件是否匹配？新增值或组件为何必要？
- 是否让页面、视觉或动画重新推导比赛事实？
- 动态颜色是否仍由既有赛事、阵营或状态来源管理？
- 是否检查键盘、焦点、减少动效、禁用、加载、错误、长文本和缺失媒体？
- 是否需要 Windows / OBS 实机证据，当前图像实际证明了什么？

视觉调整不改变产品语义时无需新增 ADR；品牌归属、状态职责或架构变化按[决策规则](../decisions/README.md)处理。禁止为单页建立新主题、复制共享组件或为了截图改变正确的比赛语义。

## 组件目录与参考

`pnpm design:catalog` 启动共享组件目录，`pnpm design:catalog:build` 构建；它只加载基础/组合组件样例，不进入产品包。来源与验证遵循开发验证文档。

采用 [DTCG](https://www.designtokens.org/tr/2025.10/format/) 管理变量，以 [WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) 和组件交互测试检查可用性。参考标准提供方法，具体美术以本目录为准。
