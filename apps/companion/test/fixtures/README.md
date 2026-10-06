# RC14 拆弹回归片段

`rc14-defuse.json` 来自 [PR #150](https://github.com/Starfie1d1272/Mizar/pull/150) 提交 `a23d71e9083c317a020f1d209e44aaf5a6221cb2` 中匿名真实 `second-half-pistol-excerpt.jsonl.gz`；源文件 SHA-256 保存在 JSON 中。

只保留首次十秒拆弹前后连续八帧及生产适配器需要的白名单字段：接收游标/时间、provider、map、round、bomb、phase_countdowns、行动者的公开状态与位置。没有凭据、原始私人账户或本机路径，不保留完整采集。选手 ID 和名字沿用证据中的匿名替代值。

该片段用于确认没有钳子字段时可从真实 9.999 秒倒计时恢复十秒动作。它不是完整 gold fixture，也不代表 RC15 实机通过。烟雾真实数值回跳的展示回归另见 `apps/web/test/radar-presentation.test.ts`，并明确使用受控边界输入。
