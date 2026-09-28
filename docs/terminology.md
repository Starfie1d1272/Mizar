# 机器与开发者术语

本仓库默认中文优先，但“中文优先”不等于把所有英文技术词机械翻译成中文。需要区分三个不同表面：

1. **用户界面 / 现场操作文案**：优先使用自然、可行动的中文，不直接暴露内部枚举和实现名；
2. **开发者文档 / ADR / 诊断说明**：中文句子为主，但保留能精确对应代码、协议、架构边界和检索入口的 canonical term；
3. **机器契约 / 代码**：协议值、字段名、类型名、路径、环境变量和机器状态保持原值，不因本地化修改。

## 总体原则

1. **先判断读者，再决定是否翻译。** 面向赛事工作人员时优先解释“发生了什么、该做什么”；面向开发者时优先保证精确性、可搜索性和与代码的一一对应。
2. **不把内部枚举直接当用户文案，但也不删除诊断中的 canonical term。** 例如正式页面可以显示“比赛数据已过期”，开发者诊断可以显示“数据已过期（`stale`）”。
3. **协议值和代码符号绝不翻译。** `ProgramProjection`、`schemaVersion`、`mapEpoch`、`runtime-stale`、`PASS` 等保持精确。
4. **标准专名可以直接使用。** HTTP、WebSocket、OBS、GSI、CSTV、React、Vite、Playwright、Steam64 等无需强行翻译。
5. **架构共同语言不为了追求全中文而丢失。** `Projection → Renderer → Host`、`RuntimeState`、`Capture V1`、`Local Protocol` 等如果已经是仓库中的 canonical model，应保留原词并用中文解释，而不是全局替换成另一套中文名。
6. **普通工程词可以自然中文化。** 如果某个英文词既不是代码名、协议名、标准专名，也不承担检索/架构索引作用，中文正文优先使用稳定中文表达。
7. **不改变语义强度。** 本地化不能把“可能没有新数据”翻译成“程序已经退出”，也不能把 observation 翻成 official fact。

## 三层用词

| Canonical term / 代码概念 | 开发者文档 | 用户界面 / 现场文案 |
| --- | --- | --- |
| Program | `Program` / 播出画面 | 播出画面 |
| Operator | `Operator` / 制作控制 | 制作控制 |
| Observer Assist | `Observer Assist` / 观察辅助 | 观察辅助 |
| Mizar Workspace | 制播工作区（Mizar Workspace） | 制播工作区 |
| Runtime / RuntimeState | `Runtime` / `RuntimeState`，必要时中文解释 | 运行状态 / 本地制播服务状态 |
| Projection | `Projection`；类型名保留 `*Projection` | 不直接暴露 |
| Renderer | `Renderer` / 渲染层 | 不直接暴露 |
| Host | `Host` / 承载方式 | 窗口、页面或实际产品名称 |
| Local Protocol | `Local Protocol` / 本地协议 | 不直接暴露版本细节，除非故障诊断需要 |
| Capture V1 / capture | `Capture V1` / capture / 采集记录 | 采集记录 |
| replay | replay / 重放 | 重放 |
| fixture | fixture / 测试样例 | 不直接暴露 |
| qualification | `qualification` 指具体子系统；正文可写“现场验收” | 现场验收 |
| evidence | evidence / 证据 | 验收证据 / 证据 |
| baseline | baseline / 基线，按上下文选择 | 基线 |
| production | production / 生产环境，按上下文选择 | 正式环境 / 生产环境 |
| provider | provider / 数据提供方 | 数据来源 |
| adapter | adapter / 适配器 | 不直接暴露 |
| source | source / 数据源 | 数据来源 |
| latest-wins | latest-wins / 只保留最新值 | 只显示最新状态 |
| backpressure | backpressure / 背压 | 不直接暴露 |
| outbox | outbox / 可靠投递队列 | 不直接暴露 |
| MatchDocument V1 | Mizar 自有比赛文档 | 比赛资料 |
| ScheduleWindow V1 | Mizar 自有有序赛程窗口 | 比赛顺序 / 上一场 / 下一场 |
| LiveSnapshot V1 | 当前公开实时快照 | 当前比赛数据 |
| ReliableEvent V1 | 有证据的可靠边沿事件 | 不直接暴露 |
| fail closed | fail closed / 默认拒绝 | 为安全起见已停止 / 无法继续自动处理 |
| marker | marker / 场景标记；协议值保留原文 | 场景标记 |

## 状态词的语义边界

以下状态不能因为中文化被合并成同一个含义：

| 机器 / 内部状态 | 开发者说明 | 用户文案建议 |
| --- | --- | --- |
| `fresh` | 当前数据仍在 freshness window 内 | 数据正常 / 正在接收 |
| `stale` | 一段时间未收到可接受的新数据，当前 runtime observation 已过 freshness deadline | 数据已过期 / 暂未收到新数据 |
| GSI `silent` | 当前没有新的 GSI 输入 | 当前没有新的比赛数据 |
| `runtime-stale` marker | 已记录 runtime 进入 `stale` 的验收证据 | 已记录数据过期状态 |
| `cs2-closed` marker | 人工/流程确认 CS2 已退出 | 已确认 CS2 退出 |
| `PASS` | 机器验收结果 | 通过（`PASS`）或仅“通过” |
| `FAIL` | 机器验收结果 | 失败（`FAIL`）或仅“失败” |
| `INCONCLUSIVE` | 机器证据不足，不能判定通过或失败 | 证据不足（`INCONCLUSIVE`）或仅“证据不足” |

尤其禁止把 `stale` 直接等价成“CS2 已退出”或“比赛数据已经停止”。`stale` 只证明数据不再新鲜；是否已经退出 CS2 由独立证据确认。

## 产品运行模式用词

正式产品文档使用：

- **独立模式**：不依赖 RivalHub，也能运行本地制播能力；
- **RivalHub 连接模式**：通过版本化契约读取 RivalHub 的完整赛事上下文。

“校园赛”“社区赛”“小型赛事”是适用场景，不是技术运行模式。历史讨论中的 `Standalone / Community mode` 不应继续作为正式中文产品术语。

首次需要与历史 Issue、外部材料或代码检索对应时，可以写“独立模式（standalone）”；后续直接使用“独立模式”。

## #94 桌面制作术语

- **准备中心**：默认桌面入口，承载总览、比赛、画面和设置。
- **进入现场 / 隐藏现场 / 恢复现场 / 结束制作**：桌面展示生命周期操作；隐藏保留当前制作上下文，结束释放现场 source，但不删除比赛资料。
- **本机覆盖**：CS2 上方的 Mizar HUD overlay；其 widget visibility 是 host preference，不表示 OBS 节目画面也隐藏。
- **OBS 画面确认**：对当前 Program Scene 的低频缩略图，不称“实时预览”或“监看”。
- **从当前服务器识别首发**：仅指 current, fresh, stable Steam64 5v5 ActiveLineup observation；不是昵称匹配，也不把 observation 变成官方赛事名单。

## 用户可见文本

用户界面的字段、提示、状态、错误和操作文案规范见 [design/product-language.md](design/product-language.md)。本文只维护术语与状态证据边界；以下说明各类工具的读者边界。

GitHub 协作模板、现场验收与运行手册面向人的内容使用中文。Debug 的原始值保持精确；其周围的用户文案遵循 product-language。

命令行工具需要根据受众区分：

- 面向现场赛事工作人员的主提示使用中文；
- 面向开发者/维护者的诊断行可以保留 `mapEpoch`、`stale`、`Capture V1` 等 canonical term，并在需要时提供中文解释；
- 不为了“看起来全中文”删除故障排查所需的字段名或状态名。

## 代码与协议

以下内容不应因本地化而修改：

- TypeScript 类型、函数、类、包名；
- JSON / WebSocket / HTTP 协议字段和值；
- HTTP 路径、WebSocket 子协议、环境变量；
- marker、reason code、schema version；
- GitHub Actions job id、脚本参数、CLI option；
- 第三方 API、项目名、许可证标识。

新增文案时，应先判断它属于用户界面、开发者文档还是机器契约，再决定中文化程度；不要对三个表面使用同一套机械替换规则。
