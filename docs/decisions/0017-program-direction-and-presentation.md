# ADR-0017：自动节目编排与有界场景展示

状态：Accepted（#106，2026-10-02）

## 决策

Companion 的 ProgramDirector 消费现有 Program/SeriesProgress/BP 与制作生命周期，经唯一 ProgramSceneController 请求 OBS 切换。它只拥有节目编排，不拥有比赛事实。替代 ADR-0010 中仅显式切场的限制：现场默认自动；手动 Take 进入持续手动保持，显式恢复自动才交还控制。准备阶段不自动切场。

所有自动请求串行、最多一个在途，无离线队列。切换前后重新验证上下文、代际、revision 与场景资格；新手动意图使旧自动请求失效。OBS 失败暂停自动，恢复自动后重新计算当前场景，不循环重试。

首回合 freezetime 使用已有语义时钟决定 BP 最终板、开场和 Gameplay 的预算；暂停、过期和直播已开始时不补播开场。停留时长集中在 Director 配置，使用单调时钟。默认 BP 最终板 10s、完整 Intro 6s、短 Intro 2s、HUD 稳定提前量 9s、半场退出提前量 5s、Map Result 12s；视觉评审可调整，不能改变 safe gates。

Program presentation store 在同步 projection 更新时捕获可信地图结束的有限选手摘要，最多保存 BO5 的五图；来源是同一 transition 经 SeriesProgress 固化的赛果与当帧 Program-safe 选手 K/A/D；展示层只显示 K/D。缺失字段保持 null，不从比分或队名推断。换图保留摘要，切换比赛/清空来源时清除；不恢复旧时钟、不增加第二份赛果数据库。半场快照保留安全的最近展示，进入资格与已播连续性分开。

场景展示使用独立、严格且有界的 HTTP presentation schema；不扩张 Gameplay channel、不暴露完整 MatchDocument/Operator/Raw GSI。只读客户端重连取得当前值，静态场景在短时断流中保留当前画面，换比赛清除。Preview 的展示样例明确独立于真实比赛，不写 Runtime。

默认美术属于 builtin:mizar-default。赛事标志/名称优先，Mizar 品牌在全屏节目页底部作为次级制作署名，不替代赛事身份；缺少图片折叠媒体区域。Halftime/InterMap/Match Result 共享 Summary Board，只展示头像、昵称、K/D；Match Result 使用最后完成地图，非跨图合计。Matchup 为 Game Capture 上的短 overlay，Halftime 为全屏。没有可用高清地图背景时使用确定性抽象背景，缩略图只用于地图条。

## 场景转场

普通自动切场使用 300ms 淡化，返回 Gameplay 使用 150ms；Intro → Gameplay 保留 renderer 内部交接并使用 Cut，手动 Take、已经开打或距开打不足 1s 的 Gameplay 切入使用 Cut。共享 scene presentation policy 只描述转场类型与时长，不包含 OBS 名称或 provider 配置。

OBS adapter 按 transitionKind 发现本地化 Cut / Fade，只设置 Mizar 目标场景的 transition override，不修改其它场景或全局转场。淡化等待 OBS 视频转场完成事件并核对目标场景；事件超时、配置缺失或失败不视为切场完成。手动 Take 取消自动转场等待，按 Cut 接管，旧请求仍受 revision / generation / qualification 校验。

BP 跨场景退出由同一次 OBS 淡化承担；确认完成前保留 BP 画面，完成后清理播放状态。单独收起 BP 继续使用既有 360ms renderer 动画。BP 进入前准备真实会话，首回合完整板在进入前就绪，失败时清理本次准备；不复制 BP projection 或另建播放时钟。开场准备提供有界的展示 revision，使 renderer 在转场前准备并在提交后延续同一动画。

统一节目预览复用同一转场规则，单视口最多保留当前和待切入两层，快速操作 latest-wins。连续演示仅展示现有版式样例和当前可见 BP，会缩短静态页停留，不发送生产切场、BP 播放或比赛命令；缺少可见 BP 时跳过 BP 并提示。停止、换样例、立即切入比赛会取消演示；减少动效时直接切换。

## 验证

确定性测试覆盖时序、手动保持、过期/暂停/OT、OBS 失败、在途切场竞争、快照跨图保留及错场清除；浏览器检查真实 renderer、可选媒体、长文本与减少动效。真实 Windows/CS2/OBS #35 与原机 #112 仍待验收，本实现不宣称生产 PASS。

节目预览统一由 `/preview` 承载；BP 标签内提供既有播放、收起、BO1/BO3/BO5 演示和本地录入控制。所有场景共用一个预览视口，BP 直接装载 `/program/bp` 并读取 Companion `BpSession`，不使用静态 fallback projection 或独立最终板预览。旧 `/operator/bp` 仅重定向到 `/preview?scene=bp`，不再拥有页面布局和预览实现。Director 的 BP 停留预算保持原有语义。
