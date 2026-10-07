# RC18 Windows 实测证据交接

此目录保存可删除的排查材料。当前验收与待办由 [#35](https://github.com/Starfie1d1272/Mizar/issues/35) 和 [#149](https://github.com/Starfie1d1272/Mizar/issues/149) 维护；这些文件不进入产品资源，也不是宣传截图或正式重放基准。RC19 修复后的结果须另行记录，不能沿用本包作为 RC19 通过证据。

源码与发布包身份见 `provenance.json`。材料来自 Windows 2560×1440、150% 缩放下的真实 CS2 demo、原生 WebView2 和 OBS 输出；截图中的 ALPHA/BRAVO 为本地演练别名。

| 文件 | 可核对的事实 | 证据限制 |
| --- | --- | --- |
| `c4-five-hud-summary.json`、两张 `c4-*.png` | 五套 HUD 在真实爆炸后、扣血前保留独立预测提示约 352–383ms；图片分别为 HP100 与随后 HP22 | 使用真实 demo 定位爆炸片段，不能代替完整地图或所有卡顿条件验收 |
| 五个 `hud-geometry-*.json` | 实际原生 DOM 的十人卡片、两位数单元格、边界与徽标中心 | EWC 使用等待设计切换完成后的 final 样本；几何数据不能代替观感审查 |
| `defuse-5s-*.png`、`defuse-10s-*.png`、`defuse-timing-summary.json` | 真实 5 秒拆弹与下半场手枪局 10 秒拆弹的进度弧随时间推进；10 秒样本的源钳状态为 null | diagnostic-crop 为 100×100 裁剪后最近邻放大 6 倍，只用于诊断；对应完整截图保留。时序为投影接收与录像时间，存在小幅启动偏移，不宣称精确到游戏 tick |
| `radar-profile-summary.json` | 连续可见原生雷达的 20,000 次回调时序与回调耗时 | JavaScript/Canvas 提交探针，不是 GPU 完成时间，也不是独立 OBS 雷达源性能或同条件 A/B 对比 |
| `native-smoke-phase-*.json*` | 十分钟、5,827 个同序号匹配样本中未发现连续 effect→projectile 倒退 | 死亡与未知 ownerSide 是输入/投影观察；不能单独证明像素颜色、入口动画是否重播 |
| `same-map-restart-input.jsonl.gz`、`same-map-restart-history.json` | RC18 同进程同图重开后，真实输入已 warmup/0:0/空历史，后续半场投影仍残留旧 1–16 回合，判定 FAIL | 输入保留原序号与时间；仅 451 帧白名单片段，不是完整采集；未暴露的 mapEpoch 记为 null |
| `mirage-halftime-5-7.png`、`authored-local-bp.png` | 实际自动半场画面与本地编排 BP 场景 | BP 元数据为演练编排，不代表 demo 携带赛事 BP；单帧不能证明完整转场 |
| `video-after-exit.json` | RC18 正常退出后，17 项受管理视频字段与启动前基线一致 | 只覆盖该次退出与视频字段，不代表全部系统设置恢复 |
| `soak-summary.json` | 约 64.3 分钟、1,925 次连续观察无服务不可用或采集丢帧，126 次进程内存采样 | 包含自然两图播放与操作；Nuke 历史有已知失败，不能计完整历史验收。内存范围不等于证明无泄漏，2 秒采样的 C4 状态不能排除短闪烁 |

输入片段的 Steam64 一致替换为合成的 17 位标签，选手/队伍名称移除。合成标签不能查询真实头像。没有改变位置、时间、血量、比分或实体生命周期。未包含原始身份映射、配置凭据、完整私有采集、带音轨录像或无关桌面画面。

在 macOS/Linux 可用这些材料分析 C4 计算与视觉衔接、共享 HUD 布局、烟雾生命周期及同图重开状态边界；代码修复后的 EXE、CS2/OBS、DPI、焦点和退出恢复仍须 Windows 实测。

运行 `node docs/evidence/rc18-windows-handoff/verify.mjs` 可验证文件摘要、gzip JSONL 与输入片段序号。离线接入既有适配器时使用原始时序，不向用户当前生产会话注入这些片段。
