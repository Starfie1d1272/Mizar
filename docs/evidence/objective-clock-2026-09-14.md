# 目标时钟非资格实证记录：2026-09-14 Windows 采集记录

这份记录固化一次已去敏的真实 Windows 观察端采集记录的测量结果。它是可复核的、不能作为
验收通过依据的证据，不是正式环境验收通过；后续完整现场探针应追加新的采集记录、独立事件
记录和报告，不覆盖这份历史记录。

## 证据来源

- 采集记录：`fixtures/gsi/semantic/bomb/defuse`
- `captureId`：`sanitized-20260914T060149Z-4cda66b7-recovered-match-seq-5522-5544`
- `sourceCaptureId`：`20260914T060149Z-4cda66b7-recovered-match`
- 平台：`win32`；Windows `11 Pro for Workstations`
- Mizar 提交版本：`08c0239ef2ae5fea1286d0163d3b7b3cb423039b`
- 选取的来源序列：`5522..5544`；共 23 帧，记录完整，丢失数据帧 `0`
- 脱敏来源数据帧 SHA-256：`7a2dfed10f28903de6a94e782ca3f0955593fe2f653e7e831e05305d8e99347a`
- 仓库测试样例 `frames.jsonl` SHA-256：`188320f5a2637683e55a5cc4e2cbf9b88ccdd5ceaf7a4be64b62c0306d7ad633`
- 来源证明：`fixtureKind=sanitized-real-capture`、`sanitizerVersion=1`、生命周期覆盖=`partial`

复核命令：

```text
node scripts/qualification/evidence/objective-timing.mjs \
  fixtures/gsi/semantic/bomb/defuse
```

## 实测结果

| 项目 | 结果 |
| --- | --- |
| 活动数据帧间隔 | p50 `249.3 ms`；p95 `255.3 ms`；p99/最大值 `255.8 ms` |
| 倒计时变化与单调时钟 | p95 `1.7 ms`；最大值 `1.7 ms` |
| 同一来源状态到首次匹配倒计时 | p95/最大值 `0 ms`；这不是观察端可见的状态变化误差 |
| 同一来源炸弹/阶段误差 | p95/最大值 `88.0 ms`；这是同一 GSI 来源内部一致性，不是绝对偏差或共同模式证明 |
| 阶段语义 | 已检查活动数据帧 `21`，不一致 `0` |
| `round.bomb` 语义 | 已检查活动数据帧 `21`，不一致 `0` |
| 匹配拆弹器证据 | `true=20`、`false=0`、`unknown=0`、`conflict=0` |
| 重连/序列间隔 | `0` / `0` |
| 终止时刻误差 | 拆弹 p95/最大值 `49.1 ms`；下包/爆炸无样本 |
| 提供方时间戳与接收时间 | p95 `810 ms`；当前提供方时间戳粒度不足以证明绝对偏差 |

这段来源语义是 `planted → defusing → defused → round over`。它证明了该采集记录中
`bomb.countdown` 在 `defusing` 时可作为拆弹动作时钟、`bomb.player` 能关联当前拆弹者、
`hasDefuser=true` 能派生拆弹器时长，并提供了回合结束终止帧的来源交叉核对；Core 对回合结束
残留动作的清理由确定性测试覆盖。它没有覆盖下包中止、爆炸、无拆弹器、拆弹中止/重启或重连。

## 验收结论

本次分析器的数值结论为：

- 数值精度 `0.1 s`：未通过。活动数据 p99 `255.8 ms > 200 ms`，且采集记录使用的
  `buffer=0.1`、`throttle=0.1`、`heartbeat=60` 不匹配规范正式配置的
  `buffer=0`、`throttle=0`、`heartbeat=10`。
- 语义场景覆盖：这份历史脱敏采集记录没有新的显式“开始/结束”目标时钟场景标记；按当前
  8 个场景契约计为 `0/8`。旧版报告里的 `defuse-kit` 形状不能替代
  `defuse-kit-abort-restart` 场景，因此 `manifest.complete=true` 不被当作语义覆盖。
- 原始正式采集来源证明：`realObserverProvenance=false`。脱敏测试样例只作为回归证据，不能
  替代与验收轮次绑定的原始记录器身份、环境和验收包摘要。
- 独立观察端事件记录：没有 `objective-events.jsonl` CSTV/demo 记录，因此观察端可见状态变化
  误差、固定偏差和随机/共同模式延迟的结论均为未知，不能用同一来源内部的 `0 ms` 或
  `88 ms` 代替。
- Core 规范策略：配置的短时有效窗口 `1000 ms`，实测 `3 × p99 = 767.4 ms`，上限
  `maximum=2000 ms`；短时有效窗口足够。因此这次 `0.1 s` 未通过不构成放宽有效窗口的理由。
- 数值精度 `0.01 s`：不承诺；`precision_time=3` 不是 1 ms 精度保证。

这份采集记录不能作为 #49 的最终正式环境验收依据，也不能填补真实最小
`planting → planted → defusing → abort → defusing → defused/exploded` 回归测试样例要求。
缺失的完整真实采集记录必须由 Windows + CS2/CSTV 观察端探针提供；合成测试样例只用于验证
分析器和 Core 的确定性行为。
