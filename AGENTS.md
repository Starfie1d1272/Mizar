# Mizar Agent 工作约定

Agent 的首要职责是在既有产品与架构边界内完成可验证实现，而不是重新发明 ownership。

## 必读

1. `README.md`
2. `docs/product.md`
3. `docs/architecture.md`
4. 与任务相关的 `docs/protocol.md` / `docs/telemetry.md`
5. `docs/development-validation.md`
6. `docs/decisions/`
7. `CONTRIBUTING.md`
8. 当前任务规格

## 语言

一手文档和用户可见界面默认中文。用户界面优先自然中文；开发者文档可以保留能精确对应代码、协议和架构的 canonical term。代码符号、协议字段、环境变量和标准专名保持原文。具体规则见 `docs/terminology.md`。

## 不可破坏的架构边界

- 官方赛事事实与 Mizar observation 分权。
- 独立模式与 RivalHub 连接模式共享同一 Runtime；RivalHub 不是 Core / Radar / Lookahead 的运行前置条件。
- Mizar 不建立第二套官方赛事数据库，不直连 RivalHub / Supabase 内部表。
- Raw GSI 只存在于 telemetry adapter / capture 边界。
- GSI frame 按 current source observation 解释；禁止通用 retain-on-omit deep merge。
- 第三方 CSTV parser 类型不得穿透 `packages/telemetry-cstv`。
- `packages/core` 不依赖 React、HTTP/WebSocket 实现、OBS、RivalHub client 或具体 parser。
- Core 只有一份 `RuntimeState`；Program / Radar / Operator / Assist / Debug 通过独立 projection 读取。
- Program-safe 与 Assist-private 数据结构化隔离；future 字段不得先进入 Program 再过滤。
- Program 与 Lookahead 是独立 source；Lookahead 不具备 Program fallback 资格。
- source reconnect / generation change 后，旧 Lookahead alignment 立即失效。
- Identity 至少区分 `unbound / resolving / matched / degraded / mismatch`。
- Steam64 是稳定运行时玩家身份键；昵称和 observer slot 不作为 fallback identity。
- 高频 snapshot 必须 latest-wins / bounded；禁止无界历史队列。
- `RuntimeTransition`、`OperatorCommand`、`ReliableObservation`、`Incident` 语义分离。
- `ReliableObservation` 由 transition-time context 派生，不是 current-state projection。
- 高影响 canonical command 不离线排队后静默执行。
- production capture recorder 属于 Companion；`packages/testkit` 只消费 capture 做 replay / simulation。
- Replay 经过 production adapter，不直接伪造最终 RuntimeState。
- duration / timeout 使用 monotonic clock；跨机器时间使用 UTC wall clock。
- Radar domain 与 Web renderer 分离。
- Program / Assist 安全由 projection/schema 保证，OBS capture 只是第二道防线。
- 用户界面不能伪造 telemetry 没有提供的精度或状态。

## 本地协议

Mizar-owned Local Protocol 使用独立 channel：

```text
program
radar
operator
assist
```

各 channel 有自己的 schema version。不要为了方便广播一个包含全部字段的万能 payload。

当前精确版本以 `packages/protocol/src/version.ts` 为代码来源。

## 变更原则

- 先复用已有 owner，不建立重复基础设施。
- 新产品需求先更新 `docs/product.md`。
- ownership / security / recovery / protocol 变化先更新相应 ADR。
- provider-specific 地址、固定延迟和发现规则只放 adapter/config，不进入 Core。
- 第二个真实 consumer/provider 出现前，不建设通用 plugin framework。
- 任务范围外问题记录为后续工作，不顺手扩张。

## 平台与验证

Agent 必须区分：

```text
Implementation environment
Automated validation
Real-environment acceptance
```

PR 使用 changed-surface CI planner；未知、工具链、workflow 和 planner 变更默认 full CI。

没有真实 Windows/CS2/OBS 环境时，不虚构生产验收。需要真实 evidence 的任务使用 exact-revision artifact 交给 platform validator。

## 测试重点

实时链路至少考虑：

- replay；
- slow consumer；
- reconnect；
- duplicate / out-of-order；
- source generation；
- wrong match；
- stale context；
- map execution reset；
- Program / Assist non-leak；
- Lookahead down / Program healthy；
- Program down 时不存在 Lookahead fallback；
- queue / memory growth。

浏览器重连只获取当前 baseline。
