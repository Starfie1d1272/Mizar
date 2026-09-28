# 文档索引

本目录记录 Mizar 的长期产品、架构、协议、数据语义和验证规则。当前态文档只描述**当前有效的事实与约束**；单次实现过程、短期排期、某个 PR 的完成情况和一次性调试记录留在 Issue / PR / Project。Accepted ADR 例外：它们同时承担历史决策记录，不能为了获得“干净当前态”而静默删除原始 rationale。

仓库一手文档默认使用中文。用户界面、开发者文档与机器契约采用不同的本地化边界，见 [`terminology.md`](terminology.md)。

## 一手文档

| 文档 | 负责回答 |
| --- | --- |
| [`product.md`](product.md) | 产品是什么、服务谁、哪些能力属于产品边界 |
| [`architecture.md`](architecture.md) | 当前系统如何分层、谁拥有什么、哪些依赖方向不可破坏 |
| [`protocol.md`](protocol.md) | RivalHub 只读赛事上下文与 Local Protocol |
| [`telemetry.md`](telemetry.md) | GSI / CSTV 输入如何解释、normalization 和 validation |
| [`development-validation.md`](development-validation.md) | 开发、CI、视觉回归和真实环境验收如何分责 |
| [`roadmap.md`](roadmap.md) | 能力之间的依赖顺序和阶段边界 |
| [`references.md`](references.md) | 参考项目能借鉴什么、哪些实现和许可证不能直接继承 |
| [`design/README.md`](design/README.md) | 唯一设计系统入口、品牌、界面类别、设计变量、用户文案与贡献规则 |
| [`terminology.md`](terminology.md) | 中文优先与开发者术语的使用边界 |

## 决策与研究

- [`decisions/`](decisions/)：已经接受、需要长期约束实现的架构决策及其历史理由。
- [`rfcs/`](rfcs/)：仍存在重要开放问题的专项设计研究。

ADR 负责记录“为什么采用某项决策以及它如何演进”，`architecture.md` 负责给出**当前架构的干净视图**。当二者表达不一致时：

- 如果当前实现/产品方向真正改变了 Accepted 决策，新增 ADR 并明确 supersede 的范围；
- 如果只是非语义澄清，在 ADR 索引或对应 ADR 中显式记录 clarification；
- 如果只是当前态文档漂移，修正 `architecture.md` 等当前态文档，不重写 ADR 历史。

具体 ADR 治理规则见 [`decisions/README.md`](decisions/README.md)。

## 文档权威关系

```text
product.md
  当前产品目标、用户、能力边界
        ↓
architecture.md + Accepted ADR
  当前 ownership / dependency direction
  + 决策历史 / rationale
        ↓
protocol.md / telemetry.md
  具体 contract 与 source semantics
        ↓
development-validation.md
  validation / acceptance rules

roadmap.md
  只描述能力依赖和演进顺序，不承担当前实施状态

Issue / PR / Project
  当前工作规格、短期状态、一次性调查与交付 evidence
```

`references.md` 和 RFC 提供设计 evidence，但不能覆盖 Accepted ADR 或当前一手文档。

## 维护规则

当前态长期文档应满足：

- 使用现在时描述当前有效行为；
- 不写“即将”“随后由某 Issue 完成”“某 PR 已经实现”等执行状态；
- 不把 Issue 编号当成架构或协议名称；
- 不复制已经由代码常量、`package.json` 或 lockfile 精确维护的易变版本信息；
- 协议示例必须与当前 schema 一致；
- 用户或制作人员可见的运行方式发生变化时同步更新；
- 已被实现取代的一次性设计过程从 README / product / architecture / protocol 等当前态文档移除。

Accepted ADR 不适用最后一条“删除历史过程”的规则。ADR 的背景、理由、代价、被否决方案和 supersede 关系属于长期历史记录，按 ADR 治理规则维护。

如果代码改变了本文档描述的长期事实，修改代码的同一 PR 必须同步更新相应当前态文档；如果改变的是 Accepted 决策本身，则同时通过新的 ADR 记录决策演进。
