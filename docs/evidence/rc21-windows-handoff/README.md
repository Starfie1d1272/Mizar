# 末局统计的最小复现与历史验收

这里保留 RC21 发现的末局晚到 K/D 缺陷输入、修复回放和 RC22 定点实机结果。它们各自只证明原记录中的构建与范围，不代表 Final RC 或正式 1.0 通过。

| 保留材料 | 用途 |
| --- | --- |
| `nuke-terminal-input.jsonl.gz` | 已去敏的 301 帧连续末局输入，来源序列 39650–39950 |
| `nuke-late-kad-defect.json`、`nuke-terminal-statistics.json` | 缺陷与当时统计对照 |
| `rc22-terminal-kad-replay.json` | 修复源码的离线生产链回放 |
| `rc22-windows-terminal-result.json` | 指定 RC22 的十人结果、比分与历史核对 |
| `provenance.json`、`privacy-verification.json` | 原采集、修复回放的来源与历史脱敏检查；不改写原构建身份 |
| `verify.mjs`、`SHA256SUMS` | 当前最小保留集的摘要、连续序列与结果校验 |

```sh
node docs/evidence/rc21-windows-handoff/verify.mjs
```

`SHA256SUMS` 只索引当前保留集。原始数据文件和来源记录内容不变；原完整清单、调查摘要、探针与交接记录可在[固定历史提交](https://github.com/Starfie1d1272/Mizar/tree/ab787f93837c424e5cf2447696d906db28b758db/docs/evidence)复核。原始身份映射、完整私人采集与含声录像不在仓库中。

当前候选的发布身份、性能和恢复结论由[发布说明](../../release-notes-draft.md)及其 RC26 清单、PR #176 来源维护；实际产品图片继续由[图集](../../screenshots/README.md)维护。当前正式发布门槛见[发布流程](../../release-readiness.md)。
