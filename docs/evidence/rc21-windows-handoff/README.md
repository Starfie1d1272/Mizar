# RC21 Windows 末局诊断资料

当前验收结论由 [#35](https://github.com/Starfie1d1272/Mizar/issues/35) 维护，修复与待排查项由 [#149](https://github.com/Starfie1d1272/Mizar/issues/149) 维护。本目录保留历史失败及修复重放，不作为宣传图片或最终 RC22 实机通过证明。

- `nuke-terminal-input.jsonl.gz`：RC21 最终包自然 Nuke 的实际 GSI 301 帧，sequence39650–39950。保留 gameover、18局历史与爆炸死亡晚到的输入形状；身份和源昵称已匿名替换。
- `nuke-terminal-statistics.json` / `nuke-late-kad-defect.json`：实际 Program 首末赛后统计及静态摘要差异。比分13:5、18局历史通过，但三名选手死亡晚更新，冻结页面少计。
- `rc22-terminal-kad-replay.json`：上述真实输入经生产适配器、Runtime、Projection及新摘要Store的离线重放，最终十人K/D与直接观测一致；不是最终RC22 Windows实测。
- `natural-default-c4-summary.json`：无跳转自然爆炸，实际DOM余影336.6ms衔接至HP更新；不单凭DOM报告宣称OBS像素通过。
- `radar-profile-*-summary.json`：原生WebView2回调时序，包含诊断开销，不能当GPU完成帧率。两段Mirage都保持fps_max0；60上限命令被游戏明确拒绝，见 `fps-control-rejected.json`，不构成帧率A/B。

原始完整GSI、身份映射、含声录像与用户设置仅留本机。`provenance.json` 区分实际包来源与离线修复源码；`privacy-verification.json` 记录针对本机原身份与名字的文本扫描。运行 `node docs/evidence/rc21-windows-handoff/verify.mjs` 检查摘要和源序列完整性。
