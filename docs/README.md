# Mizar 文档

## 使用 Mizar

| 需要 | 入口 |
| --- | --- |
| 了解产品与正式版本 | [产品介绍](guide/product.md) · [GitHub Releases](https://github.com/Starfie1d1272/Mizar/releases) |
| 安装与制作第一场比赛 | [快速开始与操作手册](guide/quick-start.md) |
| 查看画面和 HUD 风格 | [产品图集](screenshots/README.md) |
| 了解适用范围 | [数据源能力](guide/data-source-capabilities.md) |
| 了解长期方向或反馈问题 | [产品路线图](roadmap.md) · [GitHub Issues](https://github.com/Starfie1d1272/Mizar/issues) |

## 开发与维护

| 需要 | 入口 |
| --- | --- |
| 参与开发 | [贡献指南](../CONTRIBUTING.md) · [开发验证](development/development-validation.md) |
| 理解实现与接入 | [架构](reference/architecture.md) · [协议](reference/protocol.md) · [游戏数据语义](reference/telemetry.md) |
| 修改视觉与文案 | [设计系统](design/README.md) · [中文与术语](development/terminology.md) |
| 维护依赖与发布版本 | [依赖维护](development/dependency-maintenance.md) · [发布流程](development/release-readiness.md) |
| 查阅来源与决策 | [参考项目](reference/references.md) · [第三方说明](../THIRD-PARTY-NOTICES.md) · [决策维护](decisions/README.md) |

## 内容归属

`guide/` 服务使用者，`reference/` 维护技术契约，`design/` 维护视觉与交互，`development/` 维护开发和发布方法，`releases/` 保存面向用户的版本说明，`screenshots/` 提供精选产品画面及来源。

每条规则维护一个权威出处，其他入口用摘要和链接引导阅读。**长期文档描述稳定能力、行为约束与设计原则，不逐项转抄近期 Issue、候选版本清单、PR 状态或本次发布数据。**精确字段、默认值与资源清单由代码维护。具体任务、进度与研究提案集中在 Issue / PR；已确定的版本交付由 Milestone 管理，已交付事实由 GitHub Releases 记录。历史原件通过 Git 提交与已发布资产追溯。生产素材、许可和回归样例继续随代码维护。

## 写作与维护

1. 使用自然中文，以读者的任务组织内容，保留必要的专名、命令和标识符。
2. 优先说明产品能做什么、操作如何进行，以及需要满足的条件。
3. 行为变化时直接更新对应章节，同步目录、链接和工具引用。
4. 用户页面展示产品体验；版本来源和验证方法放在对应技术材料中。
5. 修改长期决定时，在 Issue / PR 记录理由和替代范围，同时更新当前规范。
6. 精简时保留完成任务所需的操作、恢复方法、接口语义和来源信息。
7. 新任务、优先级、版本安排和单次排查结果优先更新 GitHub 元数据，不为同步进度反复修改长期文档。
