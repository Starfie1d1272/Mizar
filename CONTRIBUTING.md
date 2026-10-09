# 参与开发

先阅读[产品定位](docs/guide/product.md)，再按任务查[架构](docs/reference/architecture.md)、[接口](docs/reference/protocol.md)、[数据语义](docs/reference/telemetry.md)或[设计系统](docs/design/README.md)。按需查阅与任务相关的决策背景。

## 工作范围

实现任务应写明目标、范围、既定约束、验收标准与文档影响。缺少关键产品判断时先讨论；局部实现选择在既有边界内完成。范围外问题另行记录，不顺手扩张。

改变产品边界先更新产品文档；改变职责、安全、恢复或协议决策按 [决策维护规则](docs/decisions/README.md)记录。新增功能先复用既有模块，不建立第二份比赛状态、通用事件总线或没有真实需求的插件框架。

任务的性质、领域、优先级和投入顺序通过 GitHub Issue 标签管理；只有具体发布范围明确的任务才关联 Release Milestone。产品远期目标在[路线图](docs/roadmap.md)维护，不将每次任务进度同步到长期文档。

## 开发与提交

1. 按[依赖维护](docs/development/dependency-maintenance.md)准备环境，使用冻结安装。
2. 实现并执行[改动面对应验证](docs/development/development-validation.md)，架构改动运行 `pnpm architecture:check`，设计变更遵循设计系统检查。
3. 同步唯一负责该规则的文档，移除旧表述；写作和归属规则见[文档索引](docs/README.md#写作与维护)。
4. PR 说明具体变化、实际验证、影响范围和未完成的必要验收。重大取舍提供理由，小修改不套长篇模板。

代码交付和实机验收分开记录。需要实机证据的任务在证据缺失时保持待验收，不虚构结果；先完成可执行的实现与自动化，再按[版本发布流程](docs/development/release-readiness.md)移交。

## 完成标准

- 范围内行为实现，必要回归可复现，适用检查通过。
- 文档、示例与实现一致，无过时入口和重复规则。
- 涉及公开接口、依赖或资源时，版本与来源说明完整。
- PR 记录已验证与待验证内容；正式发布另按实际变更风险和资格验收门槛判定。

代理工具的仓库工作约定见 [AGENTS.md](AGENTS.md)。
