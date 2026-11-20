# Mizar 工作台极简化改造蓝图（表面 A · Operate 模式）

> **定稿基线**：基于 `Mizar-ui-workbench` 仓内源码、[`PRODUCT.md`](../PRODUCT.md)、[`DESIGN.md`](../DESIGN.md)、[`docs/design/ui-system.md`](../docs/design/ui-system.md)、[`scripts/architecture/design.mjs`](../scripts/architecture/design.mjs) 及 1920×1080 审计截图核对定稿。
> **议题核对**：PR1 接力时复核了 [缺陷索引 #906](https://github.com/Starfie1d1272/Mizar/issues/906) 和 [设计系统历史例外 #917](https://github.com/Starfie1d1272/Mizar/issues/917)。PR1 交付工作台去重与预览来源标识，沿用现有令牌和精确迁移清单。

---

## 0. 已锁定的产品拍板与硬边界

### 0.1 七项产品拍板（覆盖初版草案）
1. **「Demo 试播」收起（PR1）**：从本场准备主体卡片移入页头 `工具 ▾` 菜单，保留现有 Demo 弹窗与深链接直达能力。
2. **「GoTV 连接」常驻不收（PR1）**：现场工作台左栏始终直接可见（无论有无实时雷达）；低频「比赛资料」「查看本图资料」收进 `本场 ▾`；「识别服务器首发」改为无比赛/异常时浮出、平时收进 `本场 ▾`。
3. **决策 1A（PR1）**：独立工具 `/operator/hud` 的 `ToolShell` 顶部保留并压缩 `SessionContext` 为紧凑单行上下文条，保留「返回本场 / 返回现场」及 OBS 异常/在播状态（遵守 `ui-system.md:116`）。
4. **决策 2A（PR1）**：侧栏四个复用同一图标的导航项（比赛库、资源管理、HUD 与画面、设置）替换为 4 个语义清晰的克制单色线性图标，并删除侧栏底部 `Mizar · 制播工作台` 页脚。
5. **决策 3A（PR1）**：本场准备任务 03 的 HUD 参考缩略图，其 `SourceBadge` 放在图外标题行旁，不叠加在缩略图画面上（遵守 `ui-system.md:128`）。
6. **决策 4C（留待 PR2）**：OBS 预览不可用时，左栏左下角**继续保留 16:9 占位框与状态/检查连接入口**（保持 `ui-system.md:94` 不变），PR2 仅通过 `max-height` 等弹性高度约束修复 `/workspace/left` 顶部 0px 塌陷。
7. **决策 5A（留待 PR3）**：「结束本次制作」在 PR1 暂保持现行 `action.danger` 深红实底样式；PR3 统一 S0–S3 状态令牌体系时，再将其改为红字描边（确认框内仍保持深红实底）并同步更新 `DESIGN.md` 与 `ui-system.md`。

### 0.2 不可破坏的架构与安全红线
- **零触碰边界**：严禁修改 `apps/companion/`、`apps/desktop/`、`packages/protocol/`、`packages/core/` 及表面 B 播出层（`apps/web/src/program/`、`apps/web/src/bp/BpPage.tsx`、`packages/hud-view/`、`packages/hud-config/`、`packages/radar-view/`）。
- **设计令牌红线**：遵守 `scripts/architecture/design.mjs`，业务与 UI CSS 严禁手写原始色值，一律引用现有 `--mizar-*` 用途/语义令牌；不增加 `design-legacy.json` 白名单额度。
- **状态与安全红线**：
  - 多维状态保持独立，不得合并为模糊的「就绪 / 异常」；
  - 停止 OBS 直播/录像、「结束本次制作」、放弃/覆盖草稿必须保留显式确认；
  - 草稿、已保存、当前正式启用三态严格分离，保存不隐式启用；
  - 现场工作台底栏八个常驻切场按钮、推流/录像输出状态与退出操作一屏直达，底栏及各分区禁止滚动条。

### 0.3 两类 `DesktopCanvas` 缩放验收口径（已按源码修正）
代码基线（`apps/web/src/patterns/DesktopCanvas.tsx`）：
- **等比画布类**：准备中心（`OperatorShell`）、独立工具（`ToolShell`）与组合工作台（`/workspace`）均采用 `1920×1080` 逻辑画布等比 `zoom`；独立底栏（`/workspace/dock`）采用 `1280×240` 逻辑画布等比 `zoom`。
  - **验收口径**：在逻辑基准（`1920×1080` / `1280×240`）内保证首屏完整、无溢出、共享控件逻辑高 ≥ 32px；并在 1080p / 1440p 的 Windows 100% / 125% / 150% 对应 CSS 视口下核验等比缩放后的边界完整、无裁剪，底栏实测点击高 ≥ 24px。
- **原生平铺类**：独立左栏（`/workspace/left`）采用 `responsive = true`（原生 CSS 像素平铺，不 `zoom`）。
  - **验收口径**：按真实原生窗口 CSS 尺寸（2K 下 `640×1440`、1080p 100% 下 `480×1080`、1080p 150% 下 `320×720`，以及浏览器宽屏 `1920×1080` 兜底）验证弹性布局、无滚动条溢出、雷达高度 ≥ 160px。

---

## 1. 单一信息归属（去重基线）

| 信息或操作 | 唯一归属位置 | 其他位置处理 |
|---|---|---|
| OBS / 直播 / 录像状态 | 准备中心：顶栏右侧 `SessionContext`；现场工作台：底栏输出区（`WorkspaceDockContent` + `ObsOutputControls`） | 删除左栏 `ProductionStatus` 中语义混淆的 `OBS {obsText}`（它实际读 `obsStreamLabel` 却标成 `OBS 待确认`）；保留左下 `ObsConfidence` 画面确认框（决策 4C） |
| 「打开工作台」说明文案 | 仅本场准备（`/`）贴近「打开工作台」按钮 | 从 `/picture`、`/settings`、`/resources`、`/matches` 页头移除 |
| 「返回本场 / 返回现场」 | 独立工具窗口（`/operator/hud` 的 `ToolShell` 紧凑 `SessionContext`，决策 1A） | 从准备中心主窗 `OperatorShell` 顶栏移除（侧栏「本场」已常驻） |
| HUD 启用状态 | `/picture` 预设列表项内标记；`/operator/hud` 头部单一状态条 | 移除 `/picture` 右侧「当前播出配置」独立块与禁用态蓝色「已应用」按钮；合并 `/operator/hud` 头部与属性栏重复徽章 |
| 比赛资料 / 地图与禁选 / HUD 编辑器 / Demo 试播 | 本场准备任务 01 / 02 / 03 + 页头右侧 `工具 ▾`（含运行诊断、Demo 试播） | 删除比赛卡重复「查看比赛资料」与整张「工具与试播」卡片 |
| 场景区编排模式（含 `准备中`） | 底栏场景区模式标签位（`sceneState?.director?.mode` 回退态，非游戏阶段） | 保留在模式位作为 S1 静默态；删除重复的场景标题「比赛中」与最底行教学提示；「恢复自动」仅在 `manual` / `blocked` 显示 |
| 预览来源标识（示例 vs 本场） | 共享组件 `SourceBadge` | 接入 `/picture`（预览框上沿外侧，y < 400，覆盖 `gameplay` 及全部 6 个 `?preview=1` 示例场景；`bp` 保持本场/空态）、`/operator/hud`（消费 `activePreviewSource`）、本场准备任务 03 标题行旁（决策 3A） |

---

## 2. 状态四级显示规范（PR3 统一落盘，PR1 先做去重铺垫）

| 级别 | 语义 | 视觉权重 |
|---|---|---|
| **S0 静默** | 正常、已完成、无需人工干预 | `fg-muted` / `fg-secondary`，无圆点、无彩色底色与边框 |
| **S1 未知 / 等待** | 尚未观测或依赖连接未建立 | 中性次级文字 + 明确原因说明；**不使用 Mizar Blue 实底** |
| **S2 进行中** | 直播中、录像中、手动接管 | 直播/录像用红色实心点 + 计时；手动接管用 Mizar Blue 边界 + 「手动」标签 |
| **S3 需要处理** | 阻断或降级异常 | 状态色提示 + 明确事实与**一个主要操作** |

---

## 3. 三批可验收 PR 切片

### PR1（`/impeccable distill`）：去重降噪 + `SourceBadge`（低风险、高降噪收益）
- **新增共享组件**：`apps/web/src/ui/SourceBadge.tsx`（及 `ui.css`、`SourceBadge.stories.tsx`），纯展示组件，仅用现有 `--mizar-*` 令牌，支持 `sample`（示例数据 · 非本场）与 `live`（本场实时 / 本场资料），非单一色彩传达。
- **壳层与页头**：
  - `OperatorShell.tsx` / `operator-shell.css`：4 导航图标语义化区分、删除底部页脚、移除主窗顶栏「返回本场」（决策 2A）。
  - `SessionContext.tsx` / `session-context.css`：支持 `compact` 模式供独立工具 `ToolShell`（`/operator/hud`）使用，压缩为紧凑单行上下文条并保留返回入口与 OBS 状态（决策 1A）。
  - `PreparationPage.tsx`：开台说明仅留在本场准备（`/`）。
- **本场准备（`/`）**：
  - 移除比赛卡重复「查看比赛资料」与整张「工具与试播」卡片；页头新增 `工具 ▾` 菜单收纳「运行诊断」「Demo 试播」（决策 1）；
  - 清理重复 `BO3`、合并「双方首发齐全」、去重轮次文案、删任务 02 废话；任务 03 标题行旁加入 `SourceBadge`（决策 3A）。
- **播出画面（`/picture`）**：
  - `SourceBadge` 置于预览框上沿外侧（1080p 首屏 `y < 400`），覆盖 `gameplay` 及全部 6 个 `?preview=1` 示例场景；`bp` 保持本场语义/空态；
  - 移除右侧「当前播出配置」独立块与禁用态蓝色「已应用」按钮；非 `gameplay` 场景弱化 HUD 列表并一行说明原因。
- **现场工作台（`/workspace`、左栏、底栏）**：
  - `ProductionStatus.tsx`：删除语义冲突的 `OBS {obsText}` 与冗余「比赛进行中」；
  - `WorkspacePage.tsx`：左栏保持「GoTV 连接」常驻可见，低频「比赛资料」「查看本图资料」收进 `本场 ▾`，「识别服务器首发」仅无比赛/异常时浮出、平时收进 `本场 ▾`（决策 2）；
  - 底栏删除重复「地图资料」、重复场景标题「比赛中」及最底行常驻教学提示；「恢复自动」仅在 `manual` / `blocked` 时显示；保留「下一场景」常驻与「结束本次制作」深红样式及确认流（决策 5A）。
- **HUD 编辑器（`/operator/hud`）**：
  - 接入紧凑 `SessionContext`（决策 1A）与 `SourceBadge`（消费 `activePreviewSource`）；
  - 合并头部与属性栏重复的预设/保存/启用徽章，保持草稿/已保存/已启用三态分离与内置只读禁用逻辑不变。
- **同步文档**：`docs/design/ui-system.md`、`DESIGN.md`。

### PR2（`layout`）：布局重排与独立左栏塌陷修复
- **独立左栏 `/workspace/left` 0px 塌陷修复（决策 4C）**：保留左下 16:9 `ObsConfidence` 占位框与状态/检查连接入口（遵守 `ui-system.md:94`），通过 `max-height` 与容器比例约束防止宽视口下 16:9 占位吃光 `minmax(0, 1fr)` 导致顶部雷达与摘要塌成 0px。
- **本场准备两栏重排**：左侧内容准备（比赛卡 + 紧凑任务列表）、右侧开台面板；说明紧贴主按钮。
- **播出画面预览尺寸自适配**：按可用高度反推 16:9 预览尺寸，确保 1080p 与 1440p 首屏完整无裁切。
- **游戏设置单栏折叠重排**：单栏主路径 + 折叠低频项（下次启动设置、Steam 头像），非 MulNX 禁用复选框旁明确标注原因；「安装位置与维护」下沉至「高级」标签页；非桌面提示去重合并。
- **HUD 编辑器工具条与播放条收敛**：来源与回放来源收拢、低频导出/版本/恢复默认收进 `⋯` 菜单。
- **验收**：按 0.3 两类 `DesktopCanvas` 口径覆盖多分辨率截图与无溢出校验。

### PR3（`polish`）：S0–S3 状态分级与保存/启用视觉统一
- 建立 S0–S3 语义令牌与状态表达；修正底栏 `ObsOutputControls` 未知态蓝色实底按钮问题；
- 落实 **决策 5A**：「结束本次制作」改为红字描边（确认框内仍保持深红实底），并同步更新 `DESIGN.md` 与 `ui-system.md`；
- 统一手动接管视觉、状态变化短脉冲（遵守 `prefers-reduced-motion`）与 HUD 编辑器头部状态就近贴合操作按钮。
