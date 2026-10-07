# RC21 Windows 末局诊断资料

当前验收结论由 [#35](https://github.com/Starfie1d1272/Mizar/issues/35) 维护，修复与待排查项由 [#149](https://github.com/Starfie1d1272/Mizar/issues/149) 维护。本目录保留历史失败、修复重放和指定范围的 RC22 实机复验，不能据此宣称完整制播验收通过。

- `nuke-terminal-input.jsonl.gz`：RC21 最终包自然 Nuke 的实际 GSI 301 帧，sequence39650–39950。保留 gameover、18局历史与爆炸死亡晚到的输入形状；身份和源昵称已匿名替换。
- `nuke-terminal-statistics.json` / `nuke-late-kad-defect.json`：实际 Program 首末赛后统计及静态摘要差异。比分13:5、18局历史通过，但三名选手死亡晚更新，冻结页面少计。
- `rc22-terminal-kad-replay.json`：上述真实输入经生产适配器、Runtime、Projection及新摘要Store的离线重放，最终十人K/D与直接观测一致；不是最终RC22 Windows实测。
- `natural-default-c4-summary.json`：无跳转自然爆炸，实际DOM余影336.6ms衔接至HP更新；不单凭DOM报告宣称OBS像素通过。
- `radar-profile-*-summary.json`：原生WebView2回调时序，包含诊断开销，不能当GPU完成帧率。两段Mirage都保持fps_max0；60上限命令被游戏明确拒绝，见 `fps-control-rejected.json`，不构成帧率A/B。
- `rc22-windows-terminal-result.json`：最终 RC22 包在 Windows 中跳转至末局后以正常速度播放爆炸，十人结果页 K/D 与实时观测一致，比分13:5、历史18局。该证据只覆盖末局晚到死亡修复，不覆盖完整地图平均伤害统计。
- `native-radar-aligned-analysis.json`：同一原生渲染器的60秒追踪与回调时间对齐。一段220.8ms间隔与约207.5ms画布像素读回及204.6ms命令缓冲等待重合；另有未被追踪跨度解释的间隔，不能将所有卡顿归因于该路径。
- `radar-cadence-experiment-summary.json`：临时可恢复的回调节奏实验仍出现长间隔；实验没有进入发布包，不作为修复通过证据。
- `rc22-final-session-summary.json`：最终RC22本轮混合定点验收和截图会话关闭后的74,781帧、零丢帧、完整性摘要，以及17项视频配置、GSI/RoundSense/autoexec和OBS退出恢复结果。会话包含跳转和资料变更，不能称为无跳转完整多图验收。

原始完整GSI、身份映射、含声录像与用户设置仅留本机。`provenance.json` 区分实际包来源与离线修复源码；`privacy-verification.json` 记录针对本机原身份与名字的文本扫描。运行 `node docs/evidence/rc21-windows-handoff/verify.mjs` 检查摘要和源序列完整性。

`rc22-epl-gallery-session.json`记录后续真实EPL24图集与三图末局结算：15张最终图、系列2:1、12,567帧零丢帧、正常退出与配置恢复。该会话包含选景跳转，不替代无跳转完整多图或全图统计验收。旧RC14临时视频与中间证据按用户要求从当前仓库移除，历史版本可由Git恢复；当前图集、必要回归输入和未解决雷达诊断保留。
