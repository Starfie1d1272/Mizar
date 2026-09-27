# 产品定义与需求

## 1. 定位

RivalHub Broadcast 是一套 **本地优先、开源、中文优先的 CS2 赛事制播工具**。它的目标不是只画一张 HUD，而是把比赛上下文、实时数据、节目画面、雷达、制作控制和观察辅助组织成一个完整的本地制播工作流。

长期产品目标包含两种运行方式：

```text
独立模式
  本地提供比赛上下文
        │
        └──→ Broadcast Runtime

RivalHub 连接模式
  RivalHub 提供 Match / Roster / Steam64 / BP / Schedule / Branding
        │
        └──→ Broadcast Runtime
```

RivalHub 是第一方、信息最完整的赛事上下文提供方，但不是运行 HUD、雷达、播出画面或观察辅助的前置条件。两种运行方式共享同一套 Runtime 和领域模型，只在赛事上下文来源上不同。

“独立模式”是产品方向，不等于当前已经补齐完整的本地比赛配置、安装引导和全部节目流程。当前能力完成度以代码和对应 milestone 验收为准。校园赛、社区赛和小型赛事是重要适用场景，不是第三种运行模式。

具体边界见 ADR-0006。

## 2. 产品原则

1. **本地优先。** 正式比赛的 HUD、雷达和基础节目流程不依赖持续公网连接。
2. **赛事事实只维护一次。** 连接 RivalHub 时，不在本地重新建立第二套 Team / Player / Match / BP 数据库。
3. **播出画面与辅助信息硬隔离。** Lookahead 未来信息永不进入正式 Program、OBS 正式输出或公开实时状态。
4. **同一套运行时支持完整节目。** Gameplay HUD 是核心场景，但不是产品全部。
5. **制作人员优先于架构术语。** 用户界面说明“发生了什么、该做什么”，不暴露内部枚举和实现名。
6. **可靠性优先于炫技。** 高频状态不积压，断流和错场默认安全降级。
7. **开源与可移植。** Core、Radar、Local Protocol 和 Lookahead 语义不绑定某个云端后台或某个第三方 HUD Manager。

## 3. 产品体验核心：制播工作区

传统 HUD 工作流通常把游戏、网页控制、雷达、诊断和辅助信息分散在多个窗口。RivalHub Broadcast 的长期产品形态是一套**私有制播工作区（Broadcast Workspace）**：

- CS2 播出画面保持最大视觉权重；
- 更易读的雷达、比赛状态和必要控制围绕主画面组织；
- 观察辅助信息放在私有区域，不污染播出画面；
- 制作控制和诊断在需要时可见，不长期占据注意力。

制播工作区是产品体验范式，不等于固定布局，也不要求某一种桌面框架。浏览器、OBS Browser Source、透明窗口或桌面容器只是不同 Host。

## 4. 现场用户

默认现场角色是**同一名解说兼 OB / 制作人员**。同一个人需要：

- 观看延迟的正式比赛时间轴；
- 手动切换 POV；
- 读取 HUD 与雷达；
- 在必要时控制场景和节目状态；
- 查看本机观察辅助；
- 处理断流、身份冲突和配置异常。

`/operator` 表示制作控制职责，不意味着产品必须存在另一名独立“导播用户”。

## 5. 播出画面制播

播出画面由 Program-safe 数据驱动，至少覆盖：

```text
Waiting / Matchup
BP / Veto Playback
Gameplay
Halftime
Map Result
Inter-map
Match Result
Break / Emergency
```

节目状态与 RivalHub 官方事实分离：播放 BP、切换节目场景或手动覆盖展示状态，不应修改赛事后台的 canonical BP、赛果或比赛生命周期。

BP / Veto 只消费已确认赛事事实：制作人员点击“播放 BP”，系统按固定间隔逐项累积展示，完整 BP 保持显示，点击“收起 BP”后统一退场。不提供暂停、上一步、下一步或跳转。`/operator/bp` 提供来源、数据就绪状态、本地填写与同一 Renderer 的预览；未绑定比赛或当前 BP 缺失、不完整、有冲突时，允许本地填写。已绑定比赛的补录保留比赛、赛事、队伍、名单和已完成地图身份，只保存本地 BP；这类 `bound-overlay` 来源模式在保存和缓存恢复后仍锁定 canonical 字段。独立填写创建 `standalone` 本地比赛，可继续编辑本地赛事、阶段、赛制、队名和队标，同时保持稳定 IDs。有效的 RivalHub BP 就绪时隐藏本地补录入口。RivalHub 来源在本地覆盖期间恢复后，先展示比赛摘要并等待制作人员确认切回。独立不透明全屏 `/program/bp` 供 OBS 装载；播放会话由 Companion 持有，不修改 RivalHub canonical BP。Host 与恢复规则见 ADR-0009。

`/operator/bp` 另提供 BO1、BO3、BO5 场景测试，使用 checked-in NJU Rivals 赛事 Manifest 验证 BP 画面、动画和 OBS 输出。Demo 是 ephemeral BP Presentation source：它与真实 BP 共用同一个 `BpSession`，只在 BP Presentation 内生效；不属于本地比赛或 MatchContext source，不持久化，也不写入 RivalHub、LKG、SeriesProgress、IdentityResolver 或 Gameplay Program。Demo 的 Manifest 仍通过标准校验、MatchContext 转换和 `inspectBp` 投影，普通工作台只读取当前 Demo 格式。切换或退出 Demo 需要先收起 BP，退出后恢复最新真实 BP projection。

### 5.1 Gameplay HUD

HUD 至少能够表达：

- 地图、BO 格式、系列赛比分；
- 当前地图序号、已结束/当前/未开始/不再进行的地图、Pick/decider/start side；
- CT/T 当前比分、回合、阶段和时钟；
- 稳定的 5+5 active lineup；raw `allplayers` 中的 observer、coach、extra 或暂时缺失 entry 不直接决定 Player Rails；
- 选手的赛事身份与 `canonical | observed | unresolved` 证据状态；
- 存活状态；
- HP、护甲、头盔、拆弹器；
- 金钱、装备价值；
- 当前武器、弹药和手雷；
- K / A / D 等直播统计，以及由 Core 按 counted damage / counted rounds 计算的 `liveAdr` 与 `completedAdr`；前者可包含当前 eligible round，后者只包含已完成 counted rounds；
- C4 状态；
- 回合历史；
- 当前观察选手。

ProgramProjection 负责完成领域解释；React 组件只负责展示。例如选手存活状态由 Core 统一推导为 `alive | dead | unknown`，Renderer 不再次根据 HP 猜测。

系列赛比分、地图结果和当前地图绑定由 Broadcast 本地 `SeriesProgress` 统一维护。地图结束后本地立即推进，不等待 RivalHub 回写；进程重启使用有界 checkpoint 恢复已冻结事实。实际服务器地图与赛前计划不一致时，比赛 telemetry 仍可继续显示，但 Series 暂停绑定并等待 Operator 明确确认。Round History 恢复不完整时显示 `partial`，不由 Renderer 补猜缺失回合。

Default V1 的中央比分条使用固定 envelope 和稳定的 score / center / objective / alive 区域；状态变化优先在既有区域内替换内容，不推动其它 HUD 组件。正常阶段显示回合与时钟；planting 使用中性 C4 与水平 action progress；planted 后才进入 bomb/danger presentation，引信与 defuse action 分别表达独立事实。默认播出画面隐藏精确 objective 秒数；进度分母证据缺失时只显示状态与不可定量的轨道，不补猜时长。存活人数只在完整 current 5+5 证据且出现死亡后显示，左右沿用 entrant A/B。动画只消费已有 semantic state / progress，不拥有 gameplay timer；urgency 局部化，并支持 reduced motion。具体长期约束见 ADR-0007。

当前观察选手卡使用 `observedPlayerSourceId` 精确匹配 current player，展示身份、K/A/D、`completedAdr`、生命、护甲和真正 active item；阵亡时只保留身份和稳定统计。Default V1 使用固定 360×176 envelope 与固定 media slot，头像存在、缺失或加载失败都不改变外框和字段位置。弹药单位来自官方 item metadata；magazine reserve 使用官方 magazine HUD asset + 数量，不换算为旧式备用子弹。Program 与 HUD 编辑器共享 renderer。

Default V1 的 1920×1080 built-in placement 固定为：Series Strip `400×72 @ (44,36)`、Radar `400×400 @ (44,116)`、Top Score `480×152 @ top-center y=36`、左右 Player Rails `440×478 @ y=524`、Focused `360×176 @ bottom-center -28`。Round History、standalone objective 与 round-result 默认隐藏；Series / Radar / Rails / Focused 的状态变化不应推动其它组件改位。

HUD 编辑器的 normal gameplay preview 继续遵守 #68 的 real-first policy。若同时显示 Program 与 Radar，两者必须解析到同一真实 replay source，并以 capture provenance + Program cursor 精确对齐；找不到同帧 Radar 时 fail closed，不再用“相近场景”拼接。Rivals BP/赛果可以作为明确标注的 presentation overlay，但不得冒充同一场 gameplay telemetry。需要连续时间历史的 ADR/DMG 与 grenade-flight / firing / damage / flash / explosion 等动态效果验收由 #76 的 full-round replay harness 承担，不在静态 fixture 中 patch gameplay truth。

HUD 编辑器的 Replay mode 通过 #76 的确定性 controller 浏览固定的真实回合。开发者可选 source、播放/暂停、重启、seek 和跳转 semantic event；Replay 只消费本地生成的 capture projection 与 presentation fixture。Steam API key 只用于开发期一次性素材导入，不进入 runtime、Replay UI 或 CI。

### 5.1.1 Gameplay HUD 自定义

Gameplay HUD 的普通用户界面提供“HUD 预设”和“HUD 布局”两个工作区。只展示真实 renderer 已实现的组件、显隐、锚点与偏移、Radar 正方形尺寸及完整地图 / 自动聚焦视野；网格、中心线、安全区与吸附属于编辑辅助。standalone objective / round-result 不进入组件列表或画布交互。

外观 schema、内置 theme 和已保存配置继续兼容；品牌色、面板风格与圆角尚未被全部生产组件一致消费，暂不开放外观工作区或预设外观选择。重新开放须有共享 renderer 与每项公开选项的视觉验收证据。

保存、另存与启用相互独立；保存不会改变播出画面，只有启用预设才更新 on-air snapshot。布局按 1920×1080 logical pixels 保存，缩放不改变坐标。预览保留真实样例、确定性重放与实时比赛；实时来源失效时安全隐藏，不回退到样例。编辑器与播出画面共享 Gameplay HUD renderer。

编辑器在收到 Companion 的第一份有效权威文档前只提供只读预览，不创建伪造的可保存草稿；读取失败时保留最近一次有效文档。每次保存或启用都以编辑器 revision 做 compare-and-swap，多个页面同时编辑时，干净草稿自动跟随外部更新，脏草稿在同一资源被外部改动时明确进入 conflict，并保留本地修改，不能静默覆盖。

HUD 配置由本地 Companion 持久化，不以浏览器 `localStorage` 作为权威来源。custom 预设的 activation snapshot 是带独立版本边界的最后一次上屏内容；加载时严格校验其自身的布局、外观语义值和组件设置，不用当前版本 Theme recipe 重新计算后比较 bytes。Theme recipe 升级不会改变尚未重新启用的 custom on-air snapshot；重新启用才生成当前版本的新快照。built-in active reference 每次启动解析当前代码拥有的 built-in。配置损坏或暂时不可读时保留最后有效的启用快照，没有快照则使用内置默认；播出画面不会因为配置控制面短暂失败而切换到另一份比赛事实。

### 5.2 雷达

雷达是一等产品能力，至少支持：

- 选手位置、朝向和存活状态；
- 当前观察目标；
- C4；
- 手雷、烟雾、燃烧区域等可获得的道具信息；
- 多楼层地图；
- 选手编号、头像或自定义 marker；
- 尺寸、透明度和信息密度配置。

已发生轨迹与预测轨迹必须区分。没有可靠地图碰撞或物理依据时，不把简单外推包装成精确预测。

## 6. 观察辅助（Observer Assist）

观察辅助利用比播出画面更早的时间轴，把已经真实发生、但延迟 Program 尚未到达的事件转换成低认知负担的提示。

最小有用提示只回答：

```text
几秒后
谁 → 谁
```

位置只有在证据可靠时才显示。第一层产品不要求武器、未来雷达、叙事分类、推荐 POV、AI 排名或自动切镜。

### 6.1 Lookahead 不是预测

Lookahead 读取的是较早时间轴中已经发生的事件，不是对游戏未来进行机器学习预测。系统负责给制作人员反应时间，人继续拥有最终切镜和叙事判断。

### 6.2 提示提前量

提前量是人因参数，不是领域常量。过短来不及切镜，过长会增加“提前知道结果”的心理负担。因此实现必须允许配置，并以真实使用验证合适范围。

### 6.3 私有显示

观察辅助可以承载在：

- 独立透明置顶窗口；
- 制播工作区的私有区域；
- 调试用浏览器页面。

这些 Host 都消费 `ObserverAssistProjection`。它们不能与正式 Program 混在同一个安全边界内，更不能依赖 OBS crop 或窗口层级来“隐藏”未来信息。

## 7. 比赛上下文与身份

比赛上下文至少需要表达：

- 比赛、赛事、阶段、BO 格式和排期；
- 双方参赛实体；
- 名单、Steam64、选手显示信息；
- BP / veto；
- 地图和官方赛果；
- 解说、直播与品牌上下文。

身份匹配只把稳定赛事身份当作权威依据。Steam64 是运行时玩家匹配与 map-scoped stats 的稳定键；昵称、CT/T 和 observer slot 只作为显示或辅助证据。连接模式下，未知 Steam64 只产生 warning/degraded identity，不会因为稳定形成 5+5 active lineup 就隐藏真实上场选手；无法排除硬矛盾时才 fail closed 到中性 presentation。

身份状态至少区分：

```text
unbound
resolving
matched
degraded
mismatch
```

错场或明确身份冲突必须关闭错误品牌和自动上行资格，但仍允许中性本地观测与诊断继续工作。

## 8. 本地与离线行为

RivalHub 或其它赛事上下文提供方暂时不可达时：

- 已经加载且仍可信的比赛上下文可以继续使用；
- HUD / Radar / 本地场景继续运行；
- 上下文明确标记为过期；
- 不把过期上下文伪装成实时官方事实；
- 切换比赛失败时不能残留上一场的队名、Logo 或名单。

高影响 canonical 操作不能在离线时静默排队后自动执行。ReliableObservation 可以进入有界持久 outbox，但发送前必须重新验证会话、地图执行和身份上下文。

## 9. 用户界面与语言

Operator、配置、错误、诊断与操作提示默认中文，并避免直接暴露内部枚举、类名或架构术语。正式 on-air HUD 不要求逐项中文化：对于 CS 赛事中通用、短且高识别度的广播标签，可以直接使用英文，例如 `ROUND`、`CURRENT`、`DECIDER`、`TECH PAUSE`；语言选择属于 presentation system，不改变 domain truth。

Debug 页面可以显示原始 JSON，但必须用中文说明数据属于哪一层、是否新鲜以及用户应如何判断异常。

开发者文档与诊断说明不适用“把所有英文词翻成中文”的规则；`RuntimeState`、`Projection → Renderer → Host`、`mapEpoch`、`Capture V1` 等 canonical term 应在需要精确指代时保留。术语规范见 [`terminology.md`](terminology.md)。

## 10. 明确不属于核心产品定义的事项

以下能力可以作为独立增强，但不构成 Broadcast 成立的前提：

- 自动导播或自动 TAKE；
- AI 叙事理解；
- 强制服务器安装插件；
- 通用电竞插件市场；
- 第二套赛事数据库；
- 把 Companion 暴露成公网数据平台；
- 依赖特定 HUD Manager 的内部协议；
- 依赖 RivalHub 内部数据库或页面源码。

产品扩展应优先通过明确的 adapter、capability interface 或独立 Projection 接入，而不是扩张一个万能状态对象。

## Web 产品入口（#35 Phase 0）

`/` 重定向到 `/operator`。制作控制、BP 工作台、HUD 编辑器与运行诊断共享导航；播出画面单独打开，不进入产品导航 tab。未知用户路径显示中文 404。制作首页复用 OperatorSnapshot 展示比赛、系列赛、数据与异常；地图绑定仅在需要制作确认时显示。诊断首页提供中文状态，原始证据收进高级技术信息。现场验收继续由 Companion 独立提供，普通运行时只提供进入说明，不自动启动验收。OBS 浏览器源状态来自本地 WebSocket 的浏览器标识，只表示观察到相应连接，不能证明画面已加载或可见。

## Windows 便携入口（#35 后续阶段）

同一产品包使用 bundled Node 24 和 Companion，根目录 EXE 默认打开制作控制；重复打开同版本服务复用当前实例，关闭网页不结束 Runtime。程序资源与可写数据分离，可写目录默认为 `state`，支持 `BROADCAST_STATE_ROOT` 绝对路径覆盖。停止服务和 GSI 安装/恢复保留明确的脚本入口，现场验收继续使用同包内的现有 controller 与 evidence contract。

该阶段已交付便携启动与目录隔离，并增加有界 Host 连接诊断。Windows CI 在 exact artifact 上运行三段各 24 回合的脚本化合成地图流程并导出资源、投递、重连与慢消费者指标；这不等同于真实比赛回放。真实 Windows + CS2 + OBS 现场证据及连续完整比赛验收仍按 #35 后续验收项推进。
