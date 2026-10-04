# Nuke / Legacy–Falcons，第1回合

来源：`falcons-vs-legacy-m1-nuke.dem` 的 cs2-demo-format/2.0 导出；demo SHA256 见 `demo-source.json`。本目录是 **Demo 派生的协议形状输入**，不是 GSI 实机录制。265帧，从安放前到拆弹完成；通过 production GSI adapter → Core → Program/Radar，未手写最终投影。

- 位置、朝向、HP：原导出8 tick采样；事件tick取之前最近的采样，不插值。
- 安放、拆弹：原始事件tick；TeSeS从8756到9396，真实连续10秒拆弹。
- 炸弹爆炸时长：导出缺少fuse netvar，六次实际安放→爆炸事件间隔均2624 tick（41秒）。仅此离线示例使用该事件间隔，并非证明引擎fuse参数为41秒。
- 战绩：累计真实击杀事件。观察目标为检查者选择。
- 不含完整实时装备、钱、护甲、弹药、头像，不拿冻结期装备冒充当前装备，不拿“仅手持武器”冒充完整背包。缺失项保持未知。
- 赛事阶段显示DEMO REPLAY，仅当前Nuke地图；不借用模板的Ancient/Mirage选图事实。

再生成：先将指定zip解压到本地目录，然后执行：

```sh
python scripts/fixtures/import-nuke-reference.py /path/to/extracted-demo-export
pnpm --filter @mizar/companion exec tsx test/program-fixtures/generate-nuke-reference.ts ../../fixtures/demo/nuke-lgcy-flc-round-01 ../web/public/fixtures/nuke-demo-round-01/replay
```

仅在 `VITE_VISUAL_FIXTURES=1` 的开发页面提供此参考源。真实录制源的哈希、sanitizer来源检查保持原规则。
