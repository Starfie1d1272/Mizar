# 目标计时专项验收

本页维护计时测量与独立参考规则。输入解释见[游戏数据语义](../reference/telemetry.md#目标计时)，整场 RC 验收见[发布流程](../development/release-readiness.md)。

## 输入与执行

```sh
pnpm qualification:objective-timing <capture-dir>
```

正式采集清单必须包含原始采集器来源、相对单调时钟原点、CS2 构建、验收包 SHA-256、环境与运行编号。普通或脱敏样例只用于分析器回归，不能冒充正式原始证据。

配置以 [production-config.json](../../packages/telemetry-gsi/src/production-config.json)为唯一来源；分析器比较 `timeout / precision_time / buffer / throttle / heartbeat`，只输出允许公开的配置，不输出令牌。

## 三个独立结论

| 结论 | 检查 |
| --- | --- |
| 证据基础 | 原始来源、采集完整性、正式配置、场景覆盖与短时有效窗口 |
| 来源语义与生命周期 | 倒计时状态切换、回合目标事实、拆弹钳、取消/重启及对应结果 |
| 数值精度 | 采样间隔、终止误差、独立参考偏差与可用性 |

显式语义冲突为 `FAIL`，缺少必要证据为 `INCONCLUSIVE`。数值精度失败不自动等于生命周期语义失败；基础验收通过也不承诺 0.1 秒精度。

测量包括有效包间隔分位数、倒计时与单调时钟残差、来源内部状态残差、安放/拆弹/爆炸终止残差、接收时间、缺失区间与序号间隙。同一 GSI 包内部一致性不能证明观察画面的共同偏移或随机延迟。

0.1 秒能力要求有效间隔 p99 ≤ 200 ms、独立转换残差 p95 ≤ 100 ms、独立绝对偏移 ≤ 100 ms、正式配置与完整场景覆盖、倒计时样本完整，以及三种终止过程均有样本且误差满足 100 ms 界限。有效窗口还需 ≥ 实测 p99 的三倍且不超过 [Core 策略](../../packages/core/src/runtime/objective-timing-policy.json)上限，单独报告是否足够。

终止误差超限为数值 `FAIL`，缺倒计时或终止样本为数值 `INCONCLUSIVE`。`precision_time=3` 不构成毫秒保证，当前不承诺 0.01 秒。

## 显式场景窗口

必需窗口为：`freezetime-live`、`plant-abort`、`planted-explode`、`defuse-kit-abort-restart`、`defuse-no-kit-abort-restart`、`too-late-defuse`、`fast-defuse-missing-planted-sample`、`reconnect-restart`。

每个窗口使用绑定采集身份的 `before / after` 标记，原始帧验证真实后果。快速拆弹看窗口第一帧，不看整份文件第一帧。重连不能从心跳间隙推断：需开始侧下包/拆弹状态、新采集身份中的正常观测及递增的数据源代际。

Windows 标记示例：`mark.ps1 objective-plant-abort -Phase before`，操作后记录 `-Phase after`。重连后用 `rotate.ps1` 在同一轮验收切换采集身份，等待新代际正常观测再记录 `objective-reconnect-restart -Phase after`；接收序号保持单调，不另造验收专用代际。

## 独立事件参考

可用时以同场 CSTV/demo 的 `objective-events.jsonl` 交叉核验；没有独立参考仍可验证 GSI 生命周期，但不能证明独立数值精度。

参考事件使用受支持的 `bomb-begin-plant / bomb-abort-plant / bomb-planted / bomb-begin-defuse / bomb-abort-defuse / bomb-defused / bomb-exploded`。记录参考身份、采集身份、相对微秒时间、数据源角色/代际/序号/tick/UTC/单调时刻/地图/tick 率，以及来源身份和 SHA-256。

发生时间按清单的单调时钟原点对齐，无法重现共同时间基准则证据不足。在线地址摘要记录数据源身份，离线 demo 摘要校验文件内容。精确格式与校验维护在[验收证据工具](../../scripts/qualification/evidence)，原始帧、清单、标记和独立参考保留完整性摘要。
