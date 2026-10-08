# 文档

按需要阅读，无需从头读完。

| 我要做什么 | 入口 |
| --- | --- |
| 了解产品与适用范围 | [产品定位](product.md) · [数据源能力与限制](data-source-capabilities.md) |
| 安装、准备比赛、现场制播、处理故障 | [快速开始与操作手册](quick-start.md) |
| 看当前画面 | [预览图集](screenshots/README.md) |
| 参与开发 | [贡献指南](../CONTRIBUTING.md) · [开发与验证](development-validation.md) |
| 理解系统 | [架构](architecture.md) · [接口协议](protocol.md) · [游戏数据语义](telemetry.md) |
| 修改视觉或文案 | [设计系统](design/README.md) · [中文与术语](terminology.md) |
| 准备 RC、实机验收与发布 | [发布流程](release-readiness.md) · [发布说明草案](release-notes-draft.md) |
| 查看未来方向和决策理由 | [路线图](roadmap.md) · [架构决策](decisions/README.md) · [研究提案](rfcs/README.md) |
| 核对来源与维护依赖 | [参考项目](references.md) · [第三方说明](../THIRD-PARTY-NOTICES.md) · [依赖维护](dependency-maintenance.md) |

## 内容归属

一条规则只有一个当前权威出处。其他文档写必要摘要并链接，不复制完整步骤、字段表或限制清单。

- 产品文档维护用户、价值与能力边界；操作手册维护使用步骤。
- 架构维护职责与依赖；协议维护交互契约；遥测文档维护输入解释。
- 设计系统维护视觉与文案；代码维护精确版本、默认值、字段和资源清单。
- 开发验证维护验证方法；发布流程维护 RC 到正式发布的顺序；具体执行状态与报告放 Issue / PR。
- ADR 保存决策理由与演变。当前文档给出有效规则，历史 ADR 通过替代关系解释旧规则。
- [历史设计审查](archive/design/README.md)和[历史证据](evidence/)用于追溯，不作为当前规范。末局统计的[最小复现与校验](evidence/rc21-windows-handoff/README.md)保留在主线；已结束的原生诊断与探针见[固定提交的完整历史](https://github.com/Starfie1d1272/Mizar/tree/ab787f93837c424e5cf2447696d906db28b758db/docs/evidence)。

## 写作与维护

1. 中文优先，具体边界见[术语规范](terminology.md)。
2. 每篇文档服务明确读者，章节按任务或概念组织，不以工作单编号命名。
3. 修改行为时更新原章节，删除旧说法，不在末尾追加同一功能的补丁说明。
4. 当前说明用现在时；未来计划进路线图，单次实施经过留在 Issue / PR。
5. 精确值优先引用代码来源；需要可复制示例时只保留一份，并检查与解析器一致。
6. 改变已接受决策时新增 ADR 说明替代范围；非语义勘误显式记录，不抹去历史理由。
7. 改名、移动或删文档时同步内部链接、工具引用与索引。新增文档先说明现有入口为何无法承载。

精简的标准是读者能更快完成任务，必要的操作、恢复办法、接口语义和来源信息不能丢失。
