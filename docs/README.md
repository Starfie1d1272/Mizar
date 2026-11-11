# Mizar 文档

## 使用 Mizar

| 需要 | 入口 |
| --- | --- |
| 了解产品与正式版本 | [产品介绍](guide/product.md) · [GitHub Releases](https://github.com/Starfie1d1272/Mizar/releases) |
| 安装与制作第一场比赛 | [快速开始与操作手册](guide/quick-start.md) |
| 制作音乐和运镜内容 | [音乐包制作](reference/music.md#内容制作与交付) · [运镜预设制作](reference/orchestration.md#内容制作与交付) |
| 查看画面和 HUD 风格 | [产品图集](screenshots/README.md) |
| 了解适用范围 | [数据源能力](guide/data-source-capabilities.md) |
| 了解长期方向或反馈问题 | [产品路线图](roadmap.md) · [GitHub Issues](https://github.com/Starfie1d1272/Mizar/issues) |

## 开发与维护

| 需要 | 入口 |
| --- | --- |
| 参与开发 | [贡献指南](../CONTRIBUTING.md) · [开发验证](development/development-validation.md) |
| 理解实现与接入 | [架构](reference/architecture.md) · [协议](reference/protocol.md) · [游戏数据语义](reference/telemetry.md) · [应用内更新](reference/updates.md) |
| 修改视觉与文案 | [设计系统](design/README.md) · [中文与术语](development/terminology.md) |
| 为独立重设计了解现状 | [产品现状基线](design/current-state/README.md)（固定提交的产品事实、源码索引与覆盖核对，不是新版方案） |
| 维护依赖与发布版本 | [依赖维护](development/dependency-maintenance.md) · [发布流程](development/release-readiness.md) |
| 审查诊断接收器部署 | [回传契约](reference/diagnostics-delivery.md) · [资源与权限清单](development/diagnostics-cloud-deployment.md) |
| 查阅来源与决策 | [参考项目](reference/references.md) · [第三方说明](../THIRD-PARTY-NOTICES.md) · [决策维护](decisions/README.md) |

## 内容归属

每条规则只有一个权威出处，其余页面用摘要与链接引用。

| 文档 | 回答的问题 | 不收录 |
| --- | --- | --- |
| `guide/` | 使用者如何安装、操作、核对和恢复？ | 内部调用顺序与故障修复经过 |
| `reference/architecture.md` | 谁拥有事实、状态和副作用，失败在哪里隔离？ | 逐次补丁、字段全集与调试记录 |
| 其他 `reference/` | 接口、数据、音乐、运镜、更新等稳定契约是什么？ | 与架构和操作手册重复的完整流程 |
| `development/` | 如何开发、验证、准备候选和发布？ | 单轮耗时、PR 进度与一次性调查 |
| `design/` | 视觉、交互和文案遵循什么规则？ | 未经确认的实现承诺 |
| [CHANGELOG](../CHANGELOG.md) / [Releases](https://github.com/Starfie1d1272/Mizar/releases) | 已交付版本变了什么，如何升级？ | 当前开发任务清单 |

精确字段、默认值、容量和资源清单以代码为准；只在用户操作或接入必须知道时写进文档，并链接负责实现。`screenshots/` 保存精选画面及来源，生产素材、许可和回归样例继续随代码维护。固定提交的产品现状基线用于设计研究，不随当前实现改写。

## 写作与维护

1. 按读者任务组织内容，使用[自然中文与统一术语](development/terminology.md)。先说职责或操作，再说必要条件与失败后的下一步。
2. 行为变化时重写其所属段落，删除被替代的说法；不要在文末追加一段修复经过。多个例外重复同一原则时合并原则，确有不同契约才保留独立分支。
3. 同步目录、相对链接和被引用标题。拆分页面必须有独立读者任务，不能仅把长段落搬到新文件。
4. 决定的理由、替代方案、单次排查与验证证据放 Issue / PR，确定的版本范围放 Milestone，远期方向放[路线图](roadmap.md)。历史通过 Git 和已发布资产追溯。
5. 精简后仍须能完成原任务：安装与使用步骤、恢复门槛、接口语义、来源/许可和发布要求不能仅为减字删除。未验证或尚未合并的行为不能写成已交付能力。
6. 审查时对照当前源码，检查“内容是否只归一处、旧表述是否移除、操作是否仍可执行、链接是否有效”。文档仅变化时执行内容与链接核对，不把未运行的产品测试记为通过。
