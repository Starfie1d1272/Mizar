# 中文与术语

正文、标题、协作说明和面向现场人员的工具提示优先自然中文。开发文档同样适用，不能以“工程术语”为由整段混写英文。

## 保留英文的范围

- 常用标准与专名：CS2、HUD、OBS、GSI、CSTV、HTTP、WebSocket、Steam64，以及项目、许可证名称。
- 必须与实现精确对应的类型、字段、状态值、命令、文件路径和环境变量，使用代码格式。
- 新概念首次需要检索对应时写“中文（英文或代码名）”，之后用中文；不为每个普通词加括号。

普通叙述使用“职责归属、验收证据、指定版本构建包、渲染层、数据源、重放、测试样例、允许列表、只保留最新状态”，不混写 ownership、evidence、exact artifact、renderer、source、replay、fixture、allowlist、latest-wins。

## 统一表达

| 叙述用语 | 精确实现对应 |
| --- | --- |
| 播出画面 | `Program` / `ProgramProjection` |
| 制作控制 | `Operator` / `OperatorCommand` |
| 观察辅助 | `Observer Assist` / `ObserverAssistProjection` |
| 制播工作台（现场工作区） | `Workspace`，具体操作名见产品文案 |
| 运行状态 | `RuntimeState` |
| 投影 | `Projection`；消费面需要的只读数据 |
| 本地服务 | `Companion` |
| 本地协议 | `Local Protocol` |
| 采集记录、重放、测试样例 | `Capture`、`replay`、`fixture`，文件与代码名称不变 |
| 正式赛事事实、本地观测 | 官方资料与 `observation`，不可混同 |
| 架构决策记录 | ADR；与伤害统计中的平均每回合伤害 ADR 区分 |

## 状态必须准确

| 原始值 | 含义 |
| --- | --- |
| `fresh` | 当前数据仍有效 |
| `stale` | 数据已过期；不证明 CS2 已退出 |
| GSI `silent` | 当前没有新 GSI 输入 |
| `cs2-closed` | 已另行确认 CS2 退出 |
| `PASS` / `FAIL` / `INCONCLUSIVE` | 通过 / 失败 / 证据不足 |

机器值保持原样，诊断可以显示“数据已过期（`stale`）”。不能为中文化合并原本不同的状态，也不能给未知数据补造确定结果。

## 界面与播出画面

按钮、提示、错误和用户可见名称由[产品文案](design/product-language.md)维护。职业转播惯用的固定英文标签属于有意的画面风格，不扩展为普通操作界面的英文豁免；赛事名称与选手昵称保留来源文本。

历史 ADR 和证据允许保留原文以便追溯。修订其表述时保留决策语义、状态与来源；当前说明遵循本规范。
