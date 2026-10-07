# Windows C4、末局与雷达排查材料

此目录补充 RC20 的可删除历史证据和 RC21 修复后的离线重放。原有 RC18/RC19 材料无法承载本次不同构建身份的实测与新末局失败，因此独立保存；当前验收与待办仍由 [#35](https://github.com/Starfie1d1272/Mizar/issues/35) / [#149](https://github.com/Starfie1d1272/Mizar/issues/149) 维护，不在此复制当前报告。这些文件不进入产品资源，不是宣传素材、正式赛果或新的标准回放样例。

来源见 `provenance.json`：Windows 2560×1440 / 150%、原生 WebView2、真实 CS2 demo 和实际 OBS 输出。画面的 ALPHA/BRAVO 是本地演练别名；三张独立 demo 的串联及 BP 是人工编排的 BO3 排练，不代表官方同一场系列赛。

| 材料 | 可核对的事实 | 限制 |
| --- | --- | --- |
| `c4-five-hud-summary.json` | 五套真实爆炸片段的独立余影约 319–401ms，初始HP100/预计HP23 | 原生DOM时序，不是所有五段均有OBS录像；定点跳转不计完整地图 |
| 六份 `hud-geometry-*.json` | 实际十人卡片、两位数单元格、默认存活徽标与数字中心 | 无溢出与几何对齐不等于全部观感通过；死亡摘要行有自己的版式 |
| `same-process-restart-summary.json` | 同一CS2进程重播，未完成执行10→11、旧1–16历史清空，0:0且未冻结赛果 | 独立的未完成图演练，不代表终局统计通过 |
| `nuke-final-input.jsonl.gz` 与摘要 | 381帧白名单真实输入；sequence71662已是gameover/freezetime、18回合、5:13 | Steam64一致替换为合成标签，名称移除；未公开原始采集或身份映射 |
| 两份 `rc21-nuke-*-replay.json` | 修复后生产适配器/Core对37,695帧计18个统计回合；生产Companion末局381帧保留18条历史与系列1:0 | **离线源码重放，不是RC21最终Windows包通过证据**；历史重放从末局片段接入，不能据此恢复完整ADR |
| `defuse-5s-*.png` | OBS录像131/134秒帧的五秒拆弹进度弧明显推进 | 截帧时刻与源接收有小幅偏移，不承诺tick精度 |
| `defuse-10s-active-*.png` | OBS录像68/69.5秒帧的十秒动作进度推进；源钳状态不足 | 此次动作中途取消，不能称完整十秒成功拆弹；diagnostic-crop都是100×100最近邻放大6倍 |
| 四份 `radar-profile-*-summary.json` 与 `radar-profile-summary.json` | 连续原生Canvas回调间隔及耗时；既有顺畅片段，也有441ms/683ms的间隔 | 包含探针开销，不是完成GPU帧率或严格A/B；不能只用低绘制耗时宣称卡顿消失 |
| `native-radar-trace-summary.json` | 原生追踪中681.65ms间隔只有约29.4ms已追踪忙时，单次最长任务约5.6ms | 未归因时间不自动等于GPU时间；数值线程/进程标识已移除 |
| `native-smoke-phase-summary.json` | 十分钟5626个同序号样本、209个死亡owner effect，未见同生命周期effect→projectile回退 | 生命周期轨迹不单独证明像素颜色 |
| `smoke-retained-color-*` 与雷达PNG/JSON | 同一生命周期已有T方ownership证明、当前投掷者已阵亡且源owner字段省略，实际描边为金色，取样像素约RGB239/194/101；14个阵亡样本 | 配对描边/像素来自同序号，PNG是邻近实际帧的示意；只取单一烟雾效果/圆环，不能泛化为所有烟雾 |
| `mirage-intermap-actual.png` | 实际OBS图间画面保留Nuke13:5、Mirage6:13、系列1:1及十人K/D | RC20末局历史与ADR有失败，静态K/D画面不能证明末局累计正确 |

原始输入只移除身份、名称、认证与私有地址，未改变地图、时间、比分、位置、血量或生命周期。未包含完整私有采集、凭据、含音轨录像或无关桌面。图像已单独目视检查；文本扫描见 `privacy-verification.json`。

macOS/Linux 可用这些材料继续排查共享HUD、归约顺序、烟雾生命周期及渲染逻辑；EXE、真实游戏/OBS、DPI、焦点与恢复仍需Windows。运行 `node docs/evidence/rc20-windows-handoff/verify.mjs` 核对摘要和关键输入形状，不把片段注入当前生产服务。
