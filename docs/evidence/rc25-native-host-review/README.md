# 原生雷达：宿主修复候选与一次性验收

2026-10-08（北京时间），基于 main `8464fa6a7f74d1b5a69a22e84d7834da55f2c4d1`，复核 #149、#166、#171、#172 及其已提交探针、当前 Host 与锁定依赖。本文记录本次候选取舍，不改写既有 Windows 实验。当前性能门禁仍由 #149 / #35 维护；本次没有 Windows 实测。

## 定位结论

已有证据足够停止把雷达绘图算法作为首要调查方向，但还不足以把全部长间隔归于一个驱动调用：

- #166 去阴影与恢复阴影无可重复差异；#171 完全停止目标像素绘制后，约60秒最大26.2ms、无>100ms，恢复后384.5ms。
- #172 同一目标 Canvas 只清屏并画移动标记仍有604.3ms长间隔；模型、适配和缓存代码继续运行，但不再向目标绘制雷达图片。这与复杂纹理是唯一主因的解释不符。
- 原生回调体短、多个代表性LoAF的大部分时间位于renderStart之前；独立trace发现CrGpuMain Present长区段。这支持优先处理窗口/共享呈现链路，不等于CPU/GPU忙碌时间或逐Canvas fence。
- 各段输入接收较连续，但CDP合并三通道不等于实际JS listener分段计时。保留此测量限制，不再为补全所有指标阻塞确定的宿主修复。
- #172像素确认在M2前对同一Canvas读过像素。它不自动推翻结果，但最终验收应使用重启后的正常上下文，先测cadence再截图；不得把可能受读回影响的上下文当作无扰动基线。

## 源码可证明的问题与最小改动

### 不变窗口仍被反复设置几何

`main.rs`现有250ms Host tick反复调用`present_overlay → placement → set_size/set_position`，没有比较实际几何。锁定的Tao 0.37.1 `set_outer_position`不仅调用SetWindowPos，还调用整窗口InvalidateRgn；因此这不是可假定免费的赋值。

候选`window_presentation::place`读取实际客户区尺寸和窗口位置，只有变化时调用对应setter；resize后重新读取位置。它不缓存“上次请求值”冒充真实状态，因此保留外部移动、DPI变化、窗口重建和失败重试。此项证明移除了不必要的原生操作，不证明604ms已消失。

### HWND隐藏未显式同步WebView2控制器

锁定Tauri 2.12.1的`WebviewWindow.show/hide`转给外层Window；runtime-wry对应WindowMessage只改变原生窗口可见性，区别于WebviewMessage的控制器路径。微软明确要求宿主同步controller.IsVisible，尤其是父窗口最小化/恢复；不能由隐藏外层HWND推断控制器已经不渲染。自动遮挡检测可能另行降低负载，源码并不能证明每个隐藏页一直全速运行。

候选在应用show/hide、初始隐藏overlay、resize/minimize/restore和现有有界Host tick中，根据“窗口实际可见且未最小化”校正controller.IsVisible。仅实际不同才写入；在UI线程闭包中读取当前状态，COM对象不跨线程，失败在已有tick重试。不引入第二个轮询器，不自动Suspend页面，不暂停Companion或OBS。未获焦点不等于不可见。

这也修正此前HUDOFF的解释：它不能排除隐藏WebView对共享呈现链路的影响；新候选不再依赖这个含混实验作为排除条件。

### 预置但默认关闭的进程集合隔离

`MIZAR_RADAR_PROCESS_ISOLATION=1`仅让`workspace-left`使用固定状态目录`webview2/workspace-radar`；默认未设置或0继续原路径。不是每场/每次启动新增目录，不删除现有profile。显式错误值拒绝；启用时发现`WEBVIEW2_USER_DATA_FOLDER`覆盖则拒绝，避免假隔离。企业策略也可能覆盖目录，最终必须核对实际进程集合。

微软文档说明，不同环境对象配相同user-data folder仍共享进程集合；不同目录才是此处需要的隔离边界。该开关沿用受支持的Tauri data_directory，不使用GPU/背景节流实验flags。它隔离的是雷达所在左栏WebView的浏览器/渲染进程集合，不隔离物理GPU或DWM，也不保证驱动等待消失。

Companion、比赛身份、数据游标、页面URL、授权主窗口、OBS与HUD语义不变。代价是额外进程、内存和独立页面存储；左栏按钮与制作状态必须在最终会话一并确认。默认关闭；只在同次最终验收中默认候选仍失败时启用，不自动故障切换。

## 自动化覆盖与交付边界

新增十组Rust回归：2400次不变轮询零原生几何写；仅尺寸/位置变化；外部移动/DPI恢复；resize引起移动后的再次读回；读回缺失/窗口重建；失败重试；非正尺寸；可见/最小化组合；隐藏/恢复与失败重试；隔离默认值、固定目录、非法输入与环境覆盖。

这些用例测试候选策略与调用次数，不测真实WebView2性能。源码SHA/本地文件完整性及diff检查在本轮执行；Rust编译、单测、平台与包检查以本PR实际CI为准，不提前写通过。本地没有Rust/Windows环境。没有合并#169，也没有更改雷达绘图、数据校验、插值、烟火半径、CSS阴影或游戏帧率。

## 一次最终Windows会话，预先写明分支

目标是验证现成候选，而不是每发现一个假设就再请求下一轮。先完成代码CI与正式release-profile候选资格，记录独立构建身份，不能把改过的包继续称作原RC25。保持正常雷达全内容、原预设、506px/150%DPI、同一Inferno片段与b1t起始视角、OBS原负载和原后台软件。所有测量从新上下文开始，关闭控制台遮挡，固定预热，不先对目标读像素。

1. 候选默认模式连续120秒；必要时在同会话先用原RC25做一个60秒基线，避免依赖跨时间的发生率比较。记录实际rAF进入/退出、>100/>250每分钟发生率、p99.9/max、正常像素更新及输入序号。不要再测无绘制、极简绘制、阴影或限帧。
2. 同时核对稳定时不再重复resize/move；Main/工具/overlay隐藏或最小化后的真实controller可见性及恢复。只读观测不改状态；CDP页面visibility是辅助，不冒充controller读回。复验窗口隐藏→显示、工具最小化→恢复、数据恢复无旧标记、OBS输出不变。
3. 默认候选仍有明显冻结时，在同一会话正常退出后，仅设置`$env:MIZAR_RADAR_PROCESS_ISOLATION='1'`重启同一候选，再跑同片段120秒。核对实际profile与不同browser/GPU进程集合；记录增加的进程/内存。其他参数不变。不再重新开发/发包后要求用户再来一轮。
4. 选定确有改善的模式复核正常画面、烟火/C4、连接、工作台按钮与完整退出恢复。若默认已经通过，不运行隔离支线。采样结束撤除有界探针；环境变量仅当前PowerShell会话，恢复原值，不用setx或修改注册表。

判定：自动化通过只证明代码；明显冻结消失、同条件长间隔显著下降且恢复/OBS无回归才可判原生候选通过。若两个模式都失败，明确保持#149开放，并在同次会话保存一个有容量上限的短trace与最小原生复现交上游，不再把删烟火、放宽校验或无限外推作为掩盖。不能保证任何一次实验必然找到外部驱动缺陷，但无需继续无限列举猜测。

## 参考实现与适用范围

- [Tauri 2.12.1 WebviewWindow](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri/src/webview/webview_window.rs)：show/hide仅外层Window；data_directory、with_webview为现有API。
- [Tauri 2.12.1 runtime-wry](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-runtime-wry/src/lib.rs)：WindowMessage Show/Hide与WebviewMessage Show/Hide是不同路径。
- [Tao 0.37.1 Windows window](https://github.com/tauri-apps/tao/blob/tao-v0.37.1/src/platform_impl/windows/window.rs)：set_outer_position的SetWindowPos与InvalidateRgn；按仓库Cargo.lock锁定版本核对。
- [微软Controller IsVisible与示例](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller?view=webview2-1.0.3537.50#get_isvisible)：应用可见性职责；不是依靠视觉上已隐藏。
- [微软进程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)：user-data folder对应进程集合边界，多个同目录Environment不是隔离。
- [微软性能指南](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)：管理不使用的WebView、避免把调试flags当永久修复。
- [WebView2Feedback #5426](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5426)：142/4K/堆叠Canvas退化及用户软件2D绕过报告；与本例154/506px不等同，不能直接继承其根因或把全局关闭GPU作为默认修复。

本候选参考公开API契约与成熟宿主生命周期，不复制其他HUD的领域逻辑，不新增通用诊断框架或第二套比赛状态。
