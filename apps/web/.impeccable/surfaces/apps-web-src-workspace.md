---
version: 1
slug: "apps-web-src-workspace"
primary_target: "apps/web/src/workspace"
related_targets: ["apps/web/src/workspace/WorkspacePage.tsx","apps/web/src/workspace/GamePictureTool.tsx","apps/web/src/preparation","apps/web/src/preparation/PreparationPage.tsx","apps/web/src/operator","apps/web/src/operator/OperatorShell.tsx","apps/web/src/operator/HudConsolePage.tsx","apps/web/src/ui","apps/web/src/ui/primitives.tsx","apps/web/src/ui/ui.css","apps/web/src/patterns","apps/web/src/patterns/Workbench.tsx","apps/web/src/patterns/DesktopCanvas.tsx","apps/web/src/resource-library","apps/web/src/resource-library/ResourceLibraryPage.tsx","apps/web/src/debug","apps/web/src/debug/DebugPage.tsx","apps/web/src/music","apps/web/src/audio","apps/web/src/orchestration","apps/web/src/bp/BpLocalEditor.tsx","apps/desktop","route:/workspace","route:/workspace/left","route:/workspace/dock","route:/workspace/review","route:/workspace/connection","route:/workspace/game-picture","route:/","route:/operator","route:/matches","route:/resources","route:/packages","route:/picture","route:/settings","route:/operator/hud","route:/debug"]
---

# 表面 A · 导播工作台与准备中心

Mode: Operate

准备中心与现场控制供同一制作团队使用。准备时核对本场、资源和连接，现场持续看见关键控制与需处理的异常。资源管理、BP 编辑、HUD 编辑器的操作外壳和技术诊断沿用此操作面。

- 准备中心：`/`、`/operator`、`/matches`、`/resources`、`/packages`、`/picture`、`/settings`。
- 现场及独立工具：`/workspace`、`/workspace/left`、`/workspace/dock`、`/workspace/review`、`/workspace/connection`、`/workspace/game-picture`、`/operator/hud`、`/debug`。

现场控制保留点击区和固定位置，低频核对进入独立详情，影响外部输出或制作生命周期的操作明确后果。视觉规则见仓库根目录的 `DESIGN.md`。产品边界见 `PRODUCT.md` 的表面 A。

范围排除 `apps/web/src/program/`、`apps/web/src/bp/BpPage.tsx`、`packages/hud-view/`、`packages/hud-config/` 和 `packages/radar-view/`。工作台内的预览只覆盖承载外框、反馈与操作区。
