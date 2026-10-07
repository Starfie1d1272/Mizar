# RC25 雷达长间隔：接收至呈现的测量复核

2026-10-07，代码侧调查。基线 `f6f92c6409d156eed72ab3048a8a59a6e1b90402`；读取 #149 正文及全部七条评论、已合并 PR #166 的五项证据文件与相关运行时源码。原始逐帧采样、探针源码和完整原生 trace 留在 Windows 本机，本轮没有重放它们，也没有新增 Windows 性能证据。

本文保存本次调查与待实现的诊断设计，不能当作产品已经内置诊断的说明。现有 RC25 证据继续保存在 [原目录](../rc25-windows-smoke/README.md)，不改写历史实验。当前状态与后续执行归 [#149](https://github.com/Starfie1d1272/Mizar/issues/149)。

## 结论与证据边界

原阴影 A1、去阴影 B、恢复阴影 A2 的各 120 秒记录：

| 段 | 最大回调间隔 | p99.9 | >100 ms | >250 ms | 回调体最大值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 | 966.7 ms | 329.2 ms | 174 | 28 | 3.7 ms |
| B | 370.9 ms | 254.2 ms | 189 | 14 | 2.1 ms |
| A2 | 375.0 ms | 254.2 ms | 191 | 15 | 2.5 ms |

B 与 A2 不支持可重复收益；A1 的视角和预热条件不同，不能把最大值下降归因于阴影。这个结果降低整体 CSS filter 作为首要单因素的优先级，不证明所有 filter 或合成成本为零。旧 RC23 与 RC25 也不是受控性能对照。

#149 最后一条评论的 Companion 接收审计：三个名义窗口分别 3040/3092/3096 帧，最大间隔 81/82/74 ms，均没有 >100 ms。这不支持 CS2 在这些窗口停止发送，但还缺逐事件的发布、传输和浏览器处理证据。不能用 Canvas 的 sampleSequence 变化次数除以源帧数宣称丢包：发布合并、latest-wins 和同样本重发布的口径不同。

PR #161 已解决表面重读清空全部缓存和工作台重复坐标投影；#163 增加小尺寸容量回归。当前复核确认这些修复存在。旧 30 秒观测只有三次离屏 context 创建、零祖先属性变化，也不支持把缓存误失效直接当成数百毫秒长间隔的既定根因。#168 的 C4 语义修改与本性能结论独立。

## 调用链与盲区

以下均指基线源码，路径相对于仓库根目录。

| 边界 | 源码 | 应记录及不能据此推断的内容 |
| --- | --- | --- |
| 发布与发送 | `apps/companion/src/local-protocol/channel-publisher.ts`、`local-web/websocket-transport.ts` | schema、channelSeq、每消费者 latest-wins、序列化、send 回调、bufferedAmount。send 完成不表示浏览器 listener 已运行；发送缓冲上限不限制浏览器待处理任务数。 |
| 浏览器 message | `apps/web/src/realtime/local-channel-client.ts` | 当前是同步 JSON.parse → acceptance.accept → store.accept；整段可能不在雷达 rAF 计时内。 |
| 协议 | `packages/protocol/src/acceptance.ts`、`radar.ts` | 先 schema.parse，再检查游标、重复及重连。校验成本应单独测，不跳过安全/代际检查换性能。 |
| store | `apps/web/src/realtime/local-channel-store.ts` | 每次 update 新建 snapshot，逐监听器同步通知；notify 总耗时包含下游同步计算，不等于 React 全部工作。 |
| 坐标适配 | `apps/web/src/program/widgets/radar/Radar.tsx`、`adapter.ts` | 包装器按 store 引用缓存适配；getSnapshot 的 cache miss 才做投影。订阅及 rAF 都可能调用它，不能把每次 getSnapshot 当一次投影。 |
| presentation | `packages/radar-view/src/presentation.ts`、`Radar.tsx` | accept 在订阅中使用 performance.now；render 另用 rAF timestamp。区分新源样本、同样本重发布、重复拒绝、边界重置、样本跳号；同 sampleSequence 重发布不会重新 retarget。 |
| React | `apps/web/src/workspace/WorkspacePage.tsx` | 左栏订阅 radar/program/operator 整包；雷达可用性不变仍产生无关的 radar 驱动更新。其他两通道与 OBS 每两秒图像确认仍可能带来任务。 |
| Canvas | `packages/radar-view/src/Radar.tsx`、`render-cache.ts` | 每次实际 render、tick、表面参数重读、resize、缓存与 drawImage 分类计数。缓存命中仍需要跨 surface 绘制，不等于零 copy/上传/合成成本。 |
| 呈现 | WebView2/Chromium | rAF 返回不是 Paint、GPU 或屏幕呈现完成。旧 ReadbackImagePixels/WaitForCmd 仅是一次相关路径，不能代表 RC25 所有长间隔。 |

雷达 effect 有稳定依赖、一个自续 rAF 和卸载清理；源码不支持普通父组件更新必然重建 Canvas、清缓存或新增 rAF 链的说法。不能把 React 重渲染与 DOM 实际变化、effect 重启或浏览器重绘混为一谈。

## 本次最小修复

`WorkspaceLeft` 的 radar 订阅只返回 `hasRadarViewFrame` 的布尔结果，由 `useSyncExternalStore` 比较选择值。判断复用现有共享资格逻辑，不重新实现地图支持、身份或新鲜度规则。雷达本身的 imperative subscriber 继续接收所有已接受快照，既有协议校验、代际、缓存、插值与世界尺寸不变。

回归覆盖连续 101 个 live 样本不重复驱动可用性组件渲染、imperative listener 全部收到，stale/mismatch/不支持地图与恢复、保留旧快照的 reconnect 不误判 live、来源替换与卸载取消订阅。program/operator 的更新没有在本补丁中被消除；因此不能承诺整个 Workspace 不再高频更新，也不能宣称原生 stall 已修复。

本环境完成修改文件的 TypeScript 语法转译检查及 diff 空白检查；没有完整依赖工作树，未执行本地 Vitest、语义 typecheck、lint、architecture/design 门禁。新增回归是否通过及完整 CI 以配套 PR 的实际检查为准；本说明不预先记 PASS。

## 诊断设计：显式开启、固定容量、停止可恢复

本节是后续实现规格，不是当前可调用 API。先在候选源码中接入，再生成有独立身份的诊断候选；不要修改公开 RC25 包内文件后仍称原 RC25。

- 只在指定 WebView/雷达 surface 显式开始，默认关闭；关闭态没有 observer、计时器、逐帧记录分配或全局原型包装。一个会话默认 120 秒，上限 180 秒；重复 start 拒绝，stop 幂等。诊断不写比赛状态、节目输出或生产库。
- 预分配定长数值记录：帧 65,536 条、message 32,768 条、其他 stage span 131,072 条、任务 2,048 条、长间隔索引 1,024 条。任何记录区先满就结束记录，报告 `capacity-stop` 与真实覆盖区间，不覆盖掉未导出的长间隔上下文后声称完整。总量须在实现中按固定字段核算，不把记录上限等同于浏览器总内存上限。
- 每个任务最多保留八个 script 摘要，标签字典最多 128 项且每项限长；记录内部枚举、匿名游标映射及数值，不留 payload、Steam64、队名、URL query、令牌、图片或调用栈全文。字符串超限使用明确的 overflow 类别，不动态扩容。
- 所有写入口检查会话 token、active 和 deadline；即使停止定时器因长任务延迟，过期记录也不继续写。停止时关闭本会话 observer/监听器/定时器并 drain 已有 observer 记录；记录 drain 覆盖限制。卸载、导航、异常及再次停止不能留下回调或覆盖其他会话资源。
- 热路径不 console.log、JSON.stringify、截图、读像素、遍历 DOM 或扫描全部记录。导出、分位数及区间关联在停止后完成；使用 finally 闭合 span，但诊断异常不得打断业务和恢复。

### 单条 message 与帧的关联

每条 message 保存 view、connection generation、channel、接收序号、字符串长度（字符数，不冒充字节数），dispatch enter、JSON end、schema end、acceptance end、notify end。通过显式 schema 包装或 acceptance 内的可选计时边界测 schema，不复制校验逻辑。保存 accepted/ignored/rejected 的结果及已验证游标。

游标按 producer/session/source generation/mapEpoch 分域，加 channelSeq、runtimeSeq、programReceiveSequence；匿名别名映射须在本机两端一致。连接重建与地图/来源切换另记事件，不只用会回绕或换代的裸序号关联。适配、presentation 和监听器 span 带父 message 标识；没有 message 父级的 rAF 接纳明确标注来源。

每个目标 Canvas 的 effect 使用独立 surface generation。记录 rAF timestamp、实际 enter/exit、tick 与实际 draw 边界、draw 是否提交、输入资格、画面使用的游标、最新 dispatch 游标。若被卸载或暂停，明确标记，不能混合多个窗口/Canvas/旧新 rAF 链。

```text
callbackInterval = enter[i] - enter[i-1]
callbackBody     = exit[i] - enter[i]
afterCallbackGap = enter[i] - exit[i-1]
frameStampGap    = rafTimestamp[i] - rafTimestamp[i-1]
```

另记录 `enter - rafTimestamp`，但该差值不是纯排队时间或 GPU 延迟。rAF 同帧回调可共享 timestamp，而进入时间不同。实际 draw 次数与 callback 次数分别计数；没有 draw 的回调不能当成画面刷新。

### 三种输入年龄，不互相替代

1. `dispatchAge`：本 WebView 距该源样本 message listener 开始的时间，只证明浏览器侧可见年龄。
2. `presentationAge`：距 presentation 接纳新的源样本的时间；同 sampleSequence 重发布不重置它。明确冻结、外推封顶、边界重建等状态，不延长外推掩盖无输入。
3. `sourceAge`：帧对应源输入在 Companion 接收后经过的时间。现有协议没有此时间戳；没有关联账本/时钟校准时必须为 null，不能写零或用 dispatchAge 替代。

每次长间隔保留前一帧、当前帧 accept 前与 accept 后的年龄、两者游标及期间 message 时间线。只在恢复后测一次年龄会漏掉积压：一批旧消息刚被消费，dispatchAge 可能近零。暂停期未执行的检查没有数据，不能编造该段的逐毫秒年龄曲线。

Companion 侧用相同会话的有界数值账本关联真实 receiveSequence → projection/channelSeq → send 开始/完成；不上传原始 GSI，也不把只读快照 socket 改成 ACK/控制通道。已有采集可提供 receive 时刻，仍需明确缺失的 publish/send 区段。两个进程的 performance.now 不能直接相减；校准共同时间轴并记录误差，必要时用往返采样给出 offset 区间。发生时钟跳变/对齐失败时 sourceAge 仍为空。MessageEvent.timeStamp 也不是网卡接包时刻。

### 主线程、缓存与最终呈现

使用能力检测后的 Long Tasks 和 Long Animation Frames observer，记录任务起止、LoAF renderStart/styleAndLayoutStart/blockingDuration、可见 script 摘要与 forced layout。小于阈值的多个任务可能一起推迟帧，单独没有 longtask 不能排除主线程。observer 可能延迟投递，脚本归因也有限；不支持、溢出或归因缺失应显式记录。

Workspace/ContextPanel/ObsConfidence 的 commit 计数可用局部 layout effect 标记，但不是 React 总耗时。React Profiler 默认生产构建不提供 profiling；专用 profiling 构建只用于归因，并标明开销，不能当普通 RC 的无扰动计时。需要调用栈、GC 或未归因的主线程工作时转短 trace。

缓存沿已有 RadarRenderCache 计数：按 artwork/smoke/glow/tint 记录 hit、miss、create、evict、clear 及原因、尺寸、条目峰值；只在本 surface 显式观察，不包装全局所有 getContext/drawImage。帧记录底图/纹理/图标的实际 drawImage 数和尺寸变化，image 首次 ready、surfaceDirty 原因及样式读取耗时。近似像素占用不称 VRAM 使用量。

记录 contextlost/contextrestored、visibility/focus 变化。computed filter、DPR、CSS/backing 尺寸仅在开始、结束和真实配置变化时读取，不在每帧强制布局。visibility=visible 本身不能证明原生窗口未被遮挡或始终获调度。

当前官方 LoAF 文档还列有 paintTime/presentationTime：对实际 WebView2 版本逐字段检测，存在时记可用值和缺失原因；这是页面更新的辅助时间，不是本 Canvas 的逐 draw GPU fence。普通 rAF、Canvas API 返回、LoAF duration 都不能直接当 GPU 完成时刻。

### 长间隔报告与回归

每次 >100 ms 事件关联 `[前一回调退出前 500 ms, 当前回调退出后 500 ms]` 内的输入、spans、任务、commit、缓存与绘制记录；窗口超出采集边界须标为不完整。单独标记 >250 ms，导出整体 p99/p99.9/max、每分钟发生率、覆盖秒数、各通道数量与可用性。停止后按时间关联 observer 记录，不能要求它们在事件触发时已经送达。

父子 span 不相加：message 包含 notify，notify 又包含 adapter/accept；计算长间隔内覆盖时取裁剪后的区间并集。任何时间重叠只表示关联，不自动分配因果或 CPU/GPU 百分比。保留无解释时间，但它不是自动计算出的 GPU 耗时。

诊断实现回归必须覆盖：关闭态零记录资源、重复 start/stop、超时与容量先到、旧 token 回调、卸载恢复、消息拒绝路径、时间回退/换代、同样本重发布不刷新源年龄、积压后恢复低年龄但时间线仍保留、重叠 span 去重、observer 延迟/不支持/字段缺失、多 Canvas 分离。用合成任务验证关联逻辑，不把合成堵塞当成原故障再现。

## Windows 短实验：先分类，再做一个变量

固定候选包身份、WebView2 版本、同一 Inferno 片段和视角、full-map、506×506/150% DPI、OBS 场景及其他应用负载。先完成相同预热，再采 60–120 秒；无需完整三图。诊断的最小 cadence 模式与详细模式分别重复同片段，量化新增探针的开销；两种模式都需相同的目标回调计时，不能把完全关闭探针的未知指标写成基线。

第一轮只采完整链路，不再次把删阴影、切预设、降帧率、缩分辨率混在一起。看到典型长间隔后，按下表只选一个后续实验，不穷举所有变量。

| 事件附近证据 | 后续最小实验/处理 |
| --- | --- |
| Host receive 正常但 publish/send 空窗 | 对应候选中补该区段计时；定位序列化、投影或发送等待，不先怪 WebView。 |
| Host send 连续，WebView dispatch 空窗后密集追赶 | 联合 LoAF/trace 查看 message、schema、其他主线程任务；不要先跳过校验或只保留最后一包破坏边界。 |
| notify/React 工作随无关 radar 更新增加 | 同诊断版本对照布尔选择器补丁；验证 imperative 输入与边界一致。其余 program/operator 工作按测量结果另收敛。 |
| 缓存重建/驱逐或表面变化集中于事件附近 | 根据具体 key 类别与失效原因做单项修复；不要只看新建 context 总数。 |
| 输入及时、回调体短，仍无对应 JS 解释 | 选一个短重现窗口抓 renderer/GPU/合成 trace；不从“没有 longtask”直接宣布 GPU 根因。 |
| 需要区分 Canvas 提交成本与输入任务 | 诊断态临时暂停目标 Canvas 的绘制提交，保留 WS/校验/store/适配/model tick/rAF 与对应计数，画面明确冻结；恢复后重复同片段。改善只能定位到绘制/合成这一组，不能据此宣布具体 API 根因或产品 PASS。 |
| rAF 停顿但本页低频 timer 与 WS 连续 | 查可见性、遮挡、原生调度；timer 同时停也只能说明更广的执行间隙，仍需 trace 分解。 |

若需要负载隔离，只额外对照一种负载，例如 OBS confidence 图像请求或某个外部应用；不同时关掉全部进程。重型 trace 和截图不与第一轮轻量测量混跑。测试后停止诊断、恢复所有临时选项，记录残留检查；正式候选需在默认关闭诊断状态下短复验。

本次不默认引入 Worker/WebGL、新 renderer、willReadFrequently、强制 GPU flags、全局透明性修改或不同坐标/烟雾尺寸。这些都不是现有证据支持的最小修复。#149 保持开放，真实性能改善仍由后续指定候选的 Windows 同条件证据证明。

## 官方资料

- [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)：选择值比较与外部 store 更新约束。
- [React Profiler](https://react.dev/reference/react/Profiler)：生产 profiling 需专用构建，测量有开销。
- [MDN requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)：回调 timestamp 与实际进入时刻的区别。
- [Chrome Long Animation Frames](https://developer.chrome.com/docs/web-platform/long-animation-frames)：小任务累计、有限脚本归因与 observer。
- [MDN PerformanceLongAnimationFrameTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongAnimationFrameTiming)：字段支持需运行时检测，包括 paintTime/presentationTime。
- [MDN WebSocket bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount)：这是发送待传字节，不是浏览器接收任务队列。
