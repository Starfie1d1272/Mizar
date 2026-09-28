# Mizar 贡献指南

本仓库采用 Issue-driven、agent-assisted 的开发方式。任何实现都必须先理解产品、架构和 ownership，再修改代码。

## 必读顺序

1. `README.md`
2. `docs/product.md`
3. `docs/architecture.md`
4. `docs/protocol.md` / `docs/telemetry.md`（按任务）
5. `docs/development-validation.md`
6. `docs/decisions/`
7. `AGENTS.md`
8. 当前工作单直接引用的专题文档

## 文档与界面语言

仓库一手文档、GitHub 协作表面和产品界面默认使用中文。详细规则见 [`docs/terminology.md`](docs/terminology.md)。

必须遵守：

- 面向赛事工作人员的标题、按钮、状态、提示、错误说明和辅助文本使用清晰中文；
- 用户界面不直接展示内部状态枚举、组件名或架构术语；
- 代码符号、环境变量、协议字段、精确协议字符串和第三方专名保持原文；
- HTTP、WebSocket、OBS、GSI、CSTV 等标准专名可以保留；
- 开发者文档以中文句子为主，但 `RuntimeState`、`Projection → Renderer → Host`、`mapEpoch`、`Capture V1`、`Local Protocol` 等已经承担代码/架构索引作用的 canonical term 应保留；
- `host`、`renderer`、`baseline`、`allowlist`、`loopback`、`qualification` 等词只有在作为普通自然语言、且不会损失精确指代时才优先使用稳定中文表达；不得机械全局替换；
- Debug 页可以展示原始 JSON，但其标题、解释和操作提示必须中文化；开发者诊断与维护型 CLI 可以保留必要机器状态和 canonical term，并提供中文解释。

## 工作单

可直接交给 coding agent 的实现任务至少应明确：

- 目标；
- 背景与约束；
- 已冻结决策；
- 范围；
- 非目标；
- ownership 与依赖方向；
- 实施步骤；
- 必要测试；
- 验收标准；
- 自动化验证；
- 真实环境验收要求；
- 依赖关系；
- 文档影响；
- 交接要求。

如果实现需要改变 authority、Runtime invariant、package ownership、安全、恢复或协议语义，应先回到设计层，不在代码中自行扩张。

## Agent-ready

`agent-ready` 表示主要产品与架构判断已经完成。Agent 可以在既定边界内选择局部实现细节，但不能未经批准：

- 更换 Runtime / framework / transport 基线；
- 新增 canonical state owner；
- 直连 RivalHub / Supabase 内部表；
- 让 Raw GSI 越过 telemetry adapter；
- 把 snapshot 改成可靠 FIFO；
- 建设没有真实 consumer 的插件框架；
- 顺手重构任务范围外的大块代码。

## 开发、自动化与真实验收

必须区分：

```text
开发环境
自动化验证
真实环境验收
```

GitHub-hosted Windows runner 只能证明自动化在该 runner 上通过，不能替代真实 Windows + CS2 / OBS 验收。

真实环境暂时不可用时：

1. 完成所有可执行的实现和自动化验证；
2. 不伪造真实环境结果；
3. 在 PR 明确标记 pending evidence；
4. 如果真实 evidence 是 closing gate，不声称任务完全验收。

详细规则见 [`docs/development-validation.md`](docs/development-validation.md)。

## PR 交付标准

PR 必须说明：

1. 完成了什么；
2. 没有完成什么；
3. 是否偏离已冻结决策；
4. 关键 ownership / contract 变化；
5. 实际执行过的验证命令；
6. 自动化和真实环境验证状态；
7. replay / visual / soak 等专项证据；
8. 剩余风险；
9. 文档影响。

文档不是实现流水账。长期文档只记录当前有效事实和规则，不写“某 Issue 已实现”“下一步由某 PR 完成”等短期状态。

如果代码改变：

- authority / ownership；
- public 或 cross-package contract；
- Runtime invariant；
- security / recovery；
- source semantics；
- 用户可见运行方式；
- 验收模型；

同一 PR 必须同步更新对应长期文档。

## Architecture contract

提交前运行：

```text
pnpm architecture:check
```

它检查：

- workspace dependency；
- package exports；
- runtime cycle；
- TypeScript `paths`；
- forbidden dependency；
- ownership boundary。

架构检查失败应通过修正真实依赖或更新决策解决，不能新增 known-violation、全局 ignore 或绕过 package boundary。

## 测试原则

实时链路改动至少考虑：

- normal replay；
- slow consumer / backpressure；
- reconnect；
- duplicate / out-of-order；
- source generation；
- session / map epoch；
- wrong match / roster mismatch；
- stale context；
- Program / Assist non-leak；
- queue / memory growth。

浏览器 reconnect 默认获取 current baseline，不补发全部离线 snapshot。

## 完成定义

任务只有在以下条件满足时才算完成：

- 范围已实现；
- 验收标准可复现；
- 必要测试已加入；
- architecture / typecheck / lint / build 等相关检查通过；
- planner 要求的自动化验证通过；
- closing gate 所需真实环境 evidence 已完成；
- 受影响长期文档同步；
- PR 记录实际验证和剩余风险。

## 设计系统

界面变更先读取 [`docs/design/README.md`](docs/design/README.md)，回答其中的 PR 检查项。品牌、三类界面、设计变量、共享组件、动态颜色与用户文案以该入口为准。复用 `packages/design-tokens` → `apps/web/src/ui/` → `apps/web/src/patterns/`；页面只负责布局与组合，不新增局部主题或旧命名空间。新增共享组件需提供组件样例，并检查键盘操作、可见焦点、减少动效、状态和无障碍。运行 `pnpm design:check`；页面重构时同步删除旧 CSS 和迁移清单项，不增加旧样式额度。
