# RC14 Windows 排查证据交接

此目录是可删除的临时证据交接包，服务于 [RC15 #149](https://github.com/Starfie1d1272/Mizar/issues/149)。实际验收结果仍由 [#35](https://github.com/Starfie1d1272/Mizar/issues/35) 维护。它不进入产品资源，也不是正式测试基准。

## 跨平台分工

| 项目                    | macOS / Linux 可完成                                                                  | 必须在 Windows 上最终复验                                                     |
| ----------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 雷达性能                | 根据实际回调时序排查调度、缓存地图/效果、减少每帧样式读取与写入，重放与浏览器性能测试 | 已补工作台 WebView2 回调时序；修复后重验，OBS 独立雷达源与 GPU 完成耗时尚未测 |
| 烟雾重复爆开、变灰      | 根据实体、owner、时间、阵营/死亡轨迹排查生命周期，编写回归                            | 同一 RC 中实际烟雾动效、投掷者死亡和实体重入；轨迹不能单独证明视觉重复        |
| C4 预测弱闪烁           | Worker 队列/批处理、过期边界、协议与视觉过渡实现，离线计时                            | 安装后 Node Worker + WebView2/OBS 的可见 pending、端到端延迟与观感            |
| C4 图标外观             | 图标着色缓存、图层、轻微动效与减少动效模式                                            | Windows 实际 OBS/工作台可辨识性、与选手重叠的效果                             |
| 工作台当前图比分        | 复用比赛头的映射，区分回合比分/系列比分，覆盖换边、未绑定、缺失数据                   | 真正工作台尺寸、换边后与游戏/OBS 显示一致性                                   |
| 默认击杀徽标            | CSS/变量打磨，检查多位数、长文本、十人布局                                            | 实机 DPI、缩放与 OBS 输出可读性                                               |
| 拆弹圆环                | 已复现底圈无彩色进度，结合真实投影检查缺失钳状态/分母，验证开始、取消、再次拆、缺时间 | 修复后在对应回合重验实际圆环；本包已有 RC14 对应录像                          |
| 无比分/地图条时雷达上移 | 判断布局槽位、收起空位、浏览器布局检查                                                | 原生三个区域、DPI、覆盖层对齐与遮挡                                           |

以上八项都可在 macOS/Linux 修改代码。Windows 专属 Host（焦点、穿透、任务栏、Steam 启动、配置恢复、托盘）、发行 EXE 和真实 CS2/OBS 集成仍必须 Windows 复验。跨平台浏览器通过不能替代该层。真实 Steam API 头像可在任意系统测试 HTTP/cache；桌面申请入口另在 Windows 检查。

## 文件与证据边界

- `provenance.json`：原始包/源码身份、原始采集 SHA-256、导出片段范围和摘要。原始整局 37,487 帧，完整性已核对。
- `telemetry-trace.jsonl.gz`：整局逐帧白名单轨迹，包含比分、阶段、选手阵营/血量/位置、烟火实体及 owner/lifetime/effecttime、C4 状态/时间。不是完整 GSI，不能直接送入生产接口。
- `smoke-excerpt.jsonl.gz`、`defuse-excerpt.jsonl.gz`：连续真实 GSI 片段，凭据和本机端点移除，身份匿名化。仅供离线适配器/测试使用；不能当作 testkit sanitizer v2 的正式 gold fixture。
- `second-half-pistol-excerpt.jsonl.gz`：25262–26852 帧，换边后的第一回合（含前后准备/结束边界）。用户已将“8:4”修正为“下半场手枪局”；不要继续依赖记忆比分定位。
- `radar-only.mp4`：实际 OBS 录制的雷达区域，裁切为 374×372，保持原 60fps，去除音轨。原录像为 1080p60、179.93 秒；裁切不用于测量原渲染器 FPS。此视频不包含所报告下半场手枪局的圆环区域。
- `auto-map_result.png`、`manual-map-result.png`：实际 OBS 单图结果及无数据等待画面，未改像素；选择不含选手身份的画面。
- `scene-capture-monitor.jsonl`：每约两秒记录预测/等待人数和场景。可确认采样时 pending 存在，不能据此量化每秒闪烁或 Worker 延迟。
- `memory.jsonl`、`live-summary.json`：进程采样和整局摘要，不能替代 Canvas 帧率或多图增长分析。
- `half-side-proof.json`：换边前后实际比分及首发队伍的 source-side 归属。
- `video-after-*.json`、`exit-retry.json`、`cold-restart-stop.json`：视频恢复/退出核对；首轮故障 CLI 退出码未同步取得，不填写猜测值。

## 补充实机取证：下半场手枪局与下一回合

用户重新授权使用游戏窗口后，于 UTC 2026-10-06 17:18:03–17:21:04 使用同一 RC14 原始包、独立状态目录播放真实 Nuke demo，跳转至 tick 77000。未注入合成遥测。以下文件补齐原先缺少的画面与回调数据：

- `pistol-objective-only.mp4`：真实 OBS 1080p60 录像中第 65–120 秒的顶部目标区域，840×180，无音轨。中心演员昵称区域用黑块遮盖（裁切后 x320/y86/w200/h18），其余像素未重绘。约第 27 秒可见拆弹图标和圆环底圈，没有推进的彩色进度。`pistol-defuse-ring.png` 是此时脱敏后的实际录像帧。
- `pistol-program-timing.jsonl.gz`、`pistol-renderer-summary.json`：同一轮真实 Program 投影的目标计时，保留接收序号/回合/阶段。手枪局及下一回合共 543 个 `defusing` 样本均有行动倒计时，`durationSeconds` 和 `hasDefuseKit` 均为空。首个事件触发截图早于 OBS 页面更新，视觉判断以录像为准。未知钳状态不能直接补成“无钳”；修复需遵循目标计时语义。
- `radar-pistol-and-rifle.mp4`：同一次 OBS 179.93 秒录像的雷达区域，374×372、60fps、无音轨，包含之后烟火效果。两份视频与投影属于同一真实运行；原始完整私人录像留在本机。
- `radar-callback-samples.json.gz`、`radar-callback-summary.json`：实际工作台左栏 WebView2 Canvas 的 rAF 回调时序。150% DPI、539×539 backing，保留前 20,000 样本，覆盖 146.48 秒；回调平均 136.53 次/秒，帧间隔 p50/p95/max 为 4.2/20.9/549.9ms，387 个间隔超过 33ms、115 个超过 50ms。回调耗时 p50/p95/max 为 0.3/0.6/4.2ms。包括烟火实体的 projectile/effect/terminal 相位与源样本序号，可离线分析长间隔的位置。
- `windows-pistol-recording.json`：OBS 采样区间 renderSkipped 增量 0、编码丢帧 0；最终 `--stop` 返回 0、受管理 CS2 关闭、17 项视频字段一致、原 GSI/RoundSense 和 OBS 录制目录恢复。

性能探针测量 JavaScript 回调（模型更新、Canvas 提交与探针开销），不是 GPU 完成时间，也不是独立 OBS Browser Source 的回调。达到 20,000 上限后不再记录；不能把等待的三分钟写成三分钟完整性能样本。长间隔仍存在，不能由较低绘制耗时断言已修复卡顿。烟雾重复爆开的根因、C4 预测端到端延迟和 RC15 修复后观感仍待排查/重验，已有录像和真实片段可先跨平台分析。

Steam64 已一致替换成 **合成的 17 位标签**，选手/队伍昵称改为 ANON。数字 owner/entity ID 保留以排查身份漂移；合成标签不是实际 Steam 账户，不应在线查询头像。只移除身份与敏感配置，没有修改游戏位置、时间、血量、比分或实体生命周期。原始映射、配置、完整私有录像仍留本机。

## 使用

Node.js 无额外依赖即可验证摘要、展开 gzip 并检查轨迹：

```sh
node docs/evidence/rc14-windows-handoff/verify.mjs
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {gunzipSync} from 'node:zlib'; process.stdout.write(gunzipSync(readFileSync('docs/evidence/rc14-windows-handoff/second-half-pistol-excerpt.jsonl.gz')));" > pistol.jsonl
```

片段每行保留原 `sequence`、`elapsedUs`、`receivedAt` 与匿名化 `payload`。接入既有 `adaptGsiPayload` 和离线生产重放组合时使用原时序；不要把这些片段导入用户当前游戏/生产状态。定位问题后，把必要最小回归样例按既有来源流程整理，再删除此临时目录；Windows 未覆盖项在 #149 保留待验。
