# Mizar Agent 工作约定

在既有产品与架构边界内完成可验证的工作。先读 [产品定位](docs/guide/product.md)、[架构](docs/reference/architecture.md)与 [贡献指南](CONTRIBUTING.md)，再按任务读取接口、数据语义、设计规范和相关决策。

## 权威入口

| 任务 | 必须遵循 |
| --- | --- |
| 文档或用户文本 | [内容归属与维护](docs/README.md)、[中文与术语](docs/development/terminology.md) |
| 运行时、身份、恢复、数据隔离 | [架构](docs/reference/architecture.md)及相关 [ADR](docs/decisions/README.md) |
| GSI / CSTV / 游戏计时 | [游戏数据语义](docs/reference/telemetry.md) |
| 接口、控制面、数据输出 | [协议](docs/reference/protocol.md) |
| 任何界面或视觉变更 | [设计系统](docs/design/README.md)，回答其审查项 |
| 安装或更新依赖 | [依赖维护](docs/development/dependency-maintenance.md) |
| 检查与交付 | [开发验证](docs/development/development-validation.md)、[RC 与发布](docs/development/release-readiness.md) |

这些入口维护唯一规则，本文件不复制架构约束与测试清单。代码变更同一 PR 更新受影响当前文档；决策变化在 Issue / PR 记录理由与替代范围，并同步当前规范。

## 环境与执行

云环境如有 `/workspace/.onboarding/activate.sh`，每个执行仓库命令的 shell 先 source，以使用可写缓存与 项目清单指定的包管理器。

新增需求先复用现有模块。不要更换技术基线、建立重复状态来源、放宽公开数据边界或绕过架构检查来完成局部任务。范围外问题记录为后续工作。

界面复用设计变量、基础组件与组合组件；新增共享组件提供样例并检查键盘、焦点、减少动效和错误状态。按设计系统运行 `pnpm design:check`。

区分实现、自动化与实机证据。缺少 Windows / CS2 / OBS 环境时不宣称生产通过；先生成指定版本 RC，再交给实机验证者，按实际结果更新发布材料。

## 测试约束

按[测试职责与独立判定](docs/development/development-validation.md#测试职责与独立判定)执行：不默认新增测试；真实行为、契约或缺陷优先扩展既有负责测试。同一规则只在唯一负责层维护完整矩阵，跨层只验证独立交互或故障模式。断言使用独立预期，不镜像生产实现，不锁定无需求依据的源码、组件身份、DOM、CSS 选择器或像素常量；客观安全边界除外。自动化、实机与视觉判断分别举证，截图本身不是断言。不以测试数量或覆盖率交付，不新增 skip/retry 或弱化发布、恢复门禁。
