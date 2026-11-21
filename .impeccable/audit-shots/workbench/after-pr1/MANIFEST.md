# 工作台 PR1 · 1080p 对比图

2026-11-21（日本时间）。使用 macOS Chromium（Chrome 158.0.8127.37）和 Playwright，固定视口 1920 × 1080、`deviceScaleFactor: 1`、100% 缩放。每张图保存可见视口。浏览器证据覆盖渲染、布局和交互。Windows 原生窗口、DPI、真实 CS2 和 OBS 仍需实机 RC 验收。 [改造蓝图](../../../WORKBENCH_BLUEPRINT.md)

PR1 的对照基线为 `c66e27fc`。比赛资料沿用 `fixtures/epl-s24/match-document.json`，现场使用 `fixtures/epl-s24/rehearsal.generated.json`。独立 Companion 将 fixture 写入临时目录。浏览器拦截制播写操作并隔离外部资源请求，缺少的 Windows 观察辅助读接口使用禁用态桩。

| 截图 | 路由／操作 | PNG 实测尺寸 | 数据与状态 |
| --- | --- | --- | --- |
| [01-preparation-home.png](01-preparation-home.png) | `/` | 1920 × 1080 | 本地 EPL 名单与赛程。工具在右列纵排。任务 03 的「示例」标识与「已启用」同一行。 |
| [02-picture-gameplay.png](02-picture-gameplay.png) | `/picture` · 比赛中 | 1920 × 1080 | 局内静态样例。预设列表标注「✓ 已启用」；来源标识 y = 291.39px。 |
| [03-picture-waiting.png](03-picture-waiting.png) | `/picture` · 赛前等待 | 1920 × 1080 | 仓库 `?preview=1` 等待样例；来源标识 y = 291.39px。 |
| [04-picture-bp.png](04-picture-bp.png) | `/picture` · BP | 1920 × 1080 | 将 EPL 地图与禁选记录录入隔离本场，使用该场的 BP 投影；来源标识 y = 291.39px。 |
| [05-hud-editor.png](05-hud-editor.png) | `/operator/hud` | 1920 × 1080 | EPL Inferno 实景回放。OBS 读桩模拟正在直播、录制和场景待检查。 |
| [06-workspace.png](06-workspace.png) | `/workspace` | 1920 × 1080 | EPL 第一图局内演练。显示雷达、GoTV 入口和 16:9 OBS 占位。导演读桩固定为自动编排，下一场景为半场。 |
| [07-workspace-dock.png](07-workspace-dock.png) | `/workspace/dock` | 1920 × 1080 | EPL 第一图局内演练。导演读桩固定为自动编排，OBS 未连接。 |

7 张 PNG 均通过尺寸、像素非空与人工画面检查。12 个独立浏览器上下文共记录 0 次 `pageerror`、0 次 `console.error` 和 0 次 HTTP 4xx／5xx。浏览器另记录 24 次 `ERR_ABORTED`，涉及 BP、场景轮询、回放视频和本地诊断事件请求。

`/picture` 额外逐一切换对阵、半场、单图结果、图间、整场结果，验证六个非局内示例均使用 `?preview=1` 并显示「示例数据 · 非本场」。局内样例同样标为非本场。BP 有数据与空态均保留本场来源。所有场景的标识上沿实测 y = 291.39px，位于预览框外。

交互核验覆盖首页工具键盘展开、Demo 深链接与退出后焦点恢复，HUD 编辑器的示例／回放／实时来源以及草稿、保存与启用状态，GoTV 入口在雷达有无数据时直达，左栏菜单打开本图资料，以及底栏退出确认。「恢复自动」仅在 `manual` 和 `blocked` 可见。底栏在本次视口中无溢出。

复核隔离环境中，选中类 EWC 只切换预览，「调整此预设」打开对应编辑器，点击「启用 类 EWC」后才更新启用版本。

评审后重截 01、06、07。比赛卡与任务区均宽 1098px，工具右列宽 366px，四个入口纵排。任务 03 的「示例」与「已启用」同行且在参考图外。Demo 按钮可用键盘打开和关闭，深链接仍有效。组合工作台的下一场景缩略图约 213.33 × 120px，独立底栏在 1920 × 1080 与 1280 × 720 视口分别为 240 × 135px 和 160 × 90px，容器与画框四边重合。底栏按状态显示手动切场提示或编排原因，退出按钮靠右且确认可取消。该轮复核无页面或控制台错误。

Vite 和隔离 Companion 已关闭，端口 4317、4318 已确认无监听。
