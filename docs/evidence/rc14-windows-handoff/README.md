# RC14 Windows 排查证据交接

此目录是可删除的临时证据交接包，服务于 [RC15 #149](https://github.com/Starfie1d1272/Mizar/issues/149)。实际验收结果仍由 [#35](https://github.com/Starfie1d1272/Mizar/issues/35) 维护。它不进入产品资源，也不是正式测试基准。

## 跨平台分工

| 项目 | macOS / Linux 可完成 | 必须在 Windows 上最终复验 |
| --- | --- | --- |
| 雷达性能 | 缓存地图/效果、减少每帧样式读取与写入，重放与浏览器性能测试 | WebView2 和 OBS 的真实 rAF FPS、render p50/p95/max、GPU/CPU 负载；现有包未测这些指标 |
| 烟雾重复爆开、变灰 | 根据实体、owner、时间、阵营/死亡轨迹排查生命周期，编写回归 | 同一 RC 中实际烟雾动效、投掷者死亡和实体重入；轨迹不能单独证明视觉重复 |
| C4 预测弱闪烁 | Worker 队列/批处理、过期边界、协议与视觉过渡实现，离线计时 | 安装后 Node Worker + WebView2/OBS 的可见 pending、端到端延迟与观感 |
| C4 图标外观 | 图标着色缓存、图层、轻微动效与减少动效模式 | Windows 实际 OBS/工作台可辨识性、与选手重叠的效果 |
| 工作台当前图比分 | 复用比赛头的映射，区分回合比分/系列比分，覆盖换边、未绑定、缺失数据 | 真正工作台尺寸、换边后与游戏/OBS 显示一致性 |
| 默认击杀徽标 | CSS/变量打磨，检查多位数、长文本、十人布局 | 实机 DPI、缩放与 OBS 输出可读性 |
| 拆弹圆环 | 用下半场手枪局检查输入/投影/计时，验证开始、取消、再次拆、缺时间 | 对应回合在实际渲染器是否出现和转动；本次没有对应圆环录像 |
| 无比分/地图条时雷达上移 | 判断布局槽位、收起空位、浏览器布局检查 | 原生三个区域、DPI、覆盖层对齐与遮挡 |

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

Steam64 已一致替换成 **合成的 17 位标签**，选手/队伍昵称改为 ANON。数字 owner/entity ID 保留以排查身份漂移；合成标签不是实际 Steam 账户，不应在线查询头像。只移除身份与敏感配置，没有修改游戏位置、时间、血量、比分或实体生命周期。原始映射、配置、完整私有录像仍留本机。

## 使用

Node.js 无额外依赖即可验证摘要、展开 gzip 并检查轨迹：

```sh
node docs/evidence/rc14-windows-handoff/verify.mjs
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {gunzipSync} from 'node:zlib'; process.stdout.write(gunzipSync(readFileSync('docs/evidence/rc14-windows-handoff/second-half-pistol-excerpt.jsonl.gz')));" > pistol.jsonl
```

片段每行保留原 `sequence`、`elapsedUs`、`receivedAt` 与匿名化 `payload`。接入既有 `adaptGsiPayload` 和离线生产重放组合时使用原时序；不要把这些片段导入用户当前游戏/生产状态。定位问题后，把必要最小回归样例按既有来源流程整理，再删除此临时目录；Windows 未覆盖项在 #149 保留待验。
