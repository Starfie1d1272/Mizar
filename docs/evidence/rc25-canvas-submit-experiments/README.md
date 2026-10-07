# RC25 原生 Canvas 提交隔离实验

2026-10-08（北京时间），继续核对「调研 Issue149方案」最新完整结论、草稿 PR #169 与 #149 评论后，在原 Windows 机器短实测。当前状态仍由 [#149](https://github.com/Starfie1d1272/Mizar/issues/149) 和 [#35](https://github.com/Starfie1d1272/Mizar/issues/35) 维护。

使用原公开 RC25：源码 `04404d6c38848a92c147eb6f22b66795052fc098`，内容摘要 `55a23e2460407aea21906b60fea7c696f6c867f195dcbc82b722697aa1e9a16b`，ZIP SHA-256 `6a277565de5d9809d9cad817c76b13f34c59b263a3d46a6cf42954427824a3d9`。没有改包内文件，没有测试 PR #169 或宣布其性能通过。

## 方法与实际结果

固定真实 EPL Inferno、1 倍速、每段从 tick 20000 重置、开始时核对 b1t 视角、506×506 雷达、150% DPI、默认 HUD、OBS 1920×1080/60，无推流和录制。MAA/MuMu 与 SteelSeries 保持运行；WebView2 154.0.4258.62、OBS 32.2.2。原样、停止目标 Canvas 像素提交、恢复原样构成第一组；随后分别试本机 HUD 隐藏、目标 Canvas 最多 60 次/秒提交、再次恢复原样。不是同时改变多个产品选项。

每段约 60 秒；回调间隔使用实际 `performance.now()` 进入时刻，同时保留 rAF timestamp。只包装指定 Canvas 的 context 方法，不包装全局 Canvas/JSON 原型；保留原始 rAF 回调、WebSocket、协议校验、store、适配与模型执行。Long Tasks/Long Animation Frames 能力检测通过。探针每段显式启动，期限或容量到达后恢复。没有截图或重型追踪混入这些采样。

| 段 | 变化 | 最大进入间隔 | >100ms | >250ms | 回调体最大 |
| --- | --- | ---: | ---: | ---: | ---: |
| A1 | 原样 | 237.6ms | 10 | 0 | 1.9ms |
| B | 仅停止目标 Canvas 像素提交 | 26.2ms | 0 | 0 | 2.1ms |
| A2 | 恢复原样 | 384.5ms | 45 | 5 | 1.7ms |
| HUDOFF | 隐藏本机游戏 HUD，雷达正常绘制 | 480.5ms | 52 | 2 | 2.0ms |
| C60 | 仅目标 Canvas 最多 60 次/秒提交 | 597.2ms | 37 | 4 | 2.0ms |
| A3 | 恢复原样 | 379.2ms | 70 | 7 | 9.9ms |

B 仍尝试执行 138,968 次目标 drawImage 方法调用，但全部目标像素绘制被诊断层阻止；不是关闭数据源或模型。C60 允许 2,648 个原绘制回调、转发 27,864 次 drawImage，约 44.1 个绘制回调/秒。这些是 JavaScript 层的计数，不是合成器提交帧或屏幕呈现帧。`results.json` 对应字段更名为 `allowedDrawingCallbacks` 与 `forwardedDrawImageCalls`，数值未变。正常段回调体较短，仍不能单凭它排除回调外的主线程工作。

独立只读雷达接收者约 1,500 帧/段，最大接收间隔 74–84ms；同 WebView 的 CDP WebSocket 事件（三通道合计）最大交付间隔 73–84ms。**这些不是实际 JS listener、schema、notify 的分段耗时，也不是服务器 send 完成或源输入年龄。** 各段没有 Long Task 记录；原样存在 Long Animation Frames，不能把缺少 Long Task 自动解释成 GPU 根因。

## 单独追踪

30 秒宽类别追踪触及 100MB 容量上限，未导出、不当完整证据。随后单独采集 5 秒 `devtools.timeline,gpu`，21,091,288 字符，126,758 事件，无数据丢失；完整文件留本机。摘要见 `trace-summary.json`。

GPU 线程出现 `DXGISwapChainImageBacking::Present` 约 134.3/113.8ms 的等待，嵌套在对应 `Scheduler::RunTask` 内；不能累加成两倍耗时。该追踪窗口中 Renderer 的最长 FunctionCall 约 1.793ms、最长 MajorGC 约 1.782ms。等待更新区域约 1882×397、含 alpha，尺寸接近 HUD 区域，但没有 surface 映射证明；单独隐藏本机 HUD 未改善，不能指认它是根因。此短追踪不与前面逐长间隔一一对应，也不是逐 draw 的 GPU fence。

## 结论与仍缺的证据

停止目标像素提交时长间隔消失，恢复后重现，支持优先调查**绘制提交及其后续共享呈现链路**；未锁定某个 Canvas API、缓存类别或 GPU 驱动。隐藏 HUD 和简单最多 60 次提交都不足以解决，因此不把这些临时选项变成产品修复。

以下限制保留在 `results.json`：

- Windows 输入操作有延迟，首个观测 demo 时间约 5:21–5:38；重复同一起点、初始视角、相同预热环境，但采样窗口仅重叠，不是精确游标同步重放。不能将 A1/A2/A3 的发生率差异单独解释成退化。
- 只记录当前/前一回调观察到的 dataset 序号与年龄，不能称为 presentation.accept 或 dispatch 年龄。没有跨端账本和时钟校准，`sourceAge=null`。
- 没有 JSON/schema/notify、React commit、缓存 hit/miss/evict/clear 的源码 hooks；没有完成 PR #169 的完整链路诊断设计。
- 没有最小 cadence 与详细 observer 模式的开销对照；所有 A/B 段共用探针，不称无扰动性能测试。
- B 画面明确冻结，只是定位实验，不能算产品可用性 PASS。

下一步应接入有界源码诊断并生成独立候选，优先关联目标 surface 与 Present/缓存跨 surface 提交；必要时一次只隔离具体 drawImage 来源类别，再复验默认真实绘制。不要据此跳过校验、删除地图/道具绘制、扩展外推或直接修改透明性/GPU flags。#149 保持开放。

## 恢复与资料范围

各会话按期限停止，探针对象/模式已撤除，九个目标 context 方法回到原生函数、阴影仍为原样。rAF 的 `Window.prototype` 身份比较不是有效的原函数校验，保留其限制；停止代码恢复捕获的原引用，随后整个测试运行时正常退出，不伪称独立身份校验通过。

正常 `--stop` 后 Host 与受管理 CS2 退出，17 项视频字段零差异，无 pending。随包脚本显式恢复 GSI，RoundSense 原文件字节恢复，OBS 正常关闭。结果见 `restoration.json`。

本目录保存匿名数值摘要、恢复证明及下述可审计探针；原始采集、全部逐帧事件、大文件追踪与配置留在本机 `.agent-tmp/rc25-radar-retest`。不上传账号、令牌、完整日志或重复宣传截图。

## 极简动态画布复验

同日读取「调研 Issue149方案」对 #171 的最新复审后，继续使用相同原版 RC25、真实 EPL Inferno、tick 20000、初始 b1t 视角、1 倍速、506×506 画布、150% DPI、原 CSS 阴影和 OBS 环境。逐段显式启动 60 秒探针；仍保留原 rAF 回调与输入、模型、缓存生成链路。

极简模式只拦截目标 context 的九个像素绘制方法。原回调完成后，每帧以单位变换整面清屏，再绘制一个移动的 24×24 青色标记，不调用目标 drawImage。它保留画布大小、CSS 和更新活动，但改变像素覆盖面积与实际绘制负载，不声称与正常雷达 GPU 工作量相同。

| 有效段 | 变化 | 最大进入间隔 | >100ms | >250ms | 回调体最大 |
| --- | --- | ---: | ---: | ---: | ---: |
| DYN-A1 | 正常雷达 | 379.4ms | 54 | 9 | 2.0ms |
| DYN-M2 | 每帧清屏和移动标记 | 604.3ms | 56 | 11 | 1.7ms |
| DYN-A2 | 恢复正常雷达 | 507.8ms | 62 | 6 | 2.0ms |

DYN-M2 实际绘制 7,231 次动态标记，原雷达仍尝试 68,807 次 drawImage，目标 drawImage 全部阻止。单独约 0.6 秒像素验证读取三个不同位置，均得到 `[0,229,255,255]`，确认实际像素持续变化；读回不混入三段计时。首次极简段 DYN-M 因游戏控制台未关闭而排除，未用其数值形成结论。有效段核对控制台关闭；DYN-A2 中有一次状态截图，保留其干扰限制。各段起点相同，但输入操作延迟造成窗口只重叠，不能用三段发生率差异衡量退化。

**分类结果：极简动态画布仍复现长间隔。** 地图与烟火图片不是产生现象的必要条件，应优先追查该 WebView 的持续画布更新、出帧、合成、提交确认与呈现。原输入和缓存生成链路仍在，未证明某个驱动、API 或具体 surface 为根因，也没有完成性能修复。

补抓同一目标探针与浏览器追踪：5 秒宽类别触及 80MB 上限，已关闭流并撤销探针，不算完整证据；随后 3 秒 `blink.user_timing,cc,gpu` 成功，25,158,127 字符、139,562 事件、无数据丢失。能看到 `BeginMainFrame`、`DidReceiveCompositorFrameAckOnImplThread` 与 `Present`，GPU 的 `Present` 区段最大约 88.1ms。**这一短窗口没有 >100ms 的目标间隔，也没有目标 surface 的唯一映射；“前一帧拖住下一帧”的机制验证仍为 INCONCLUSIVE。** 不把 Present 区段当作 DXGI 系统调用或 GPU 执行耗时。

详细结果、完整长间隔前后回调时间锚点、局部序号、像素验证和恢复证明见 [dynamic-results.json](dynamic-results.json)。仍没有实际 radar JS listener 分段、缓存命中计数、跨端源年龄；CDP 三通道聚合事件不能代替 listener 及时性证明。

### 探针审计与恢复

[probe-original.js.txt](probe-original.js.txt) 为 #171 实际使用的原探针；[probe-dynamic.js.txt](probe-dynamic.js.txt) 为本轮三段使用的探针。文件逐字保留，SHA-256 记录在结果中。它们是人工注入的诊断资料，未接入产品运行时。九个方法为 `clearRect / drawImage / fill / stroke / fillRect / strokeRect / fillText / strokeText / putImageData`；通过目标 context 的 `clearRect` 识别雷达回调，其他画布不受拦截。

本轮改为保存并恢复 context 的自有属性描述符，直接对比启动前的 rAF/context 函数引用。期限 60 秒、样本上限 20,000、Long Task/LoAF 各 1,024，拒绝重复启动，停止幂等，超时和 `pagehide` 恢复。模拟生命周期检查覆盖显式停止、超时与卸载，均验证移动标记绘制、重复启动拒绝和原函数身份恢复；实机三段亦全部返回身份恢复成功。原轮 `Window.prototype` 比较限制仍保留，不能用本轮改进倒推历史检查成功。

正常退出本轮 Host 和受管理 CS2，17 项视频字段零差异、pending 消失；随包脚本显式恢复 GSI，RoundSense 字节恢复，OBS 正常退出。没有修改发布包、生成新 RC 或验证 #169。#149 保持开放。
