# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Mizar 面向校园与社区 CS2 赛事中资源有限的小型制播团队；以下职责来自仓库现有文档与已实现工作流（并非经正式用户访谈或留存调研验证的画像，且同一人在小型赛事中常兼任多项角色）：

- **制作人员／导播（主要操作者）**：在紧张赛事现场准备比赛资料、管理 CS2 与 OBS 环境、推进或接管节目编排、核对播出状态、控制推流／录像并处理异常与收尾。
- **解说**：借助同机工作台或共享／局域网只读画面查看真实 CS2 画面、大雷达、比赛资料与赛程；资料中可登记解说与直播间信息。
- **观察者**：在受管 CS2 中观战、切换选手视角、使用隐藏原生 HUD 与数字键观战配置，结合大雷达与可选私有提前提示掌握局势。
- **赛事资料维护者／RivalHub 授权方**：本地模式下由操作者维护本机赛事、队伍、名单与 BP；连接模式下在 RivalHub 维护官方资料与终局结果，并授权本场实时数据源。
- **观众／网站读者（最终观看者）**：通过直播平台消费 OBS 16:9 节目画面与 HUD，或通过连接网站查看公开实时状态与公共雷达；不接触制作控制、私有观察辅助或技术诊断。
- **开发者／维护者**：基于用户主动导出的脱敏支持包与运行诊断排查现场问题。

## Product Purpose

**让校园赛事，也有职业赛场的转播呈现。**

Mizar 是一个本地优先、开源（AGPL-3.0-only）的 CS2 赛事制播系统，覆盖从赛前等待、地图禁选（BP）、对阵开场、局内 HUD 与雷达、常规半场、单图结果、图间到整场结果的完整节目流程。

- **解决什么问题**：校园与社区 CS2 赛事通常缺乏专职导播团队与商业制播栈，人工在 OBS、资料表、HUD 和观战窗口间频繁切换极易漏切、错图、播出错乱数据或造成直播事故。
- **两种使用方式**：
  - **本地制作**：完全在本机管理赛事、队伍、名单、地图与 BP，无需依赖任何外部赛事网站即可完成正式转播。
  - **连接 RivalHub（及遵循公开协议的外部赛事平台）**：授权后复用官方赛事资料与 BP，并在满足身份与连续性门槛时向网站提供局内 LIVE 状态、公共雷达与可靠观测事件；平台负责官方资料与正式赛果，Mizar 负责现场观测与节目呈现，相邻项目 DAK 负责赛后分析。
- **成功意味着什么**：所选比赛与真实 CS2 观战事实一致、节目在正确时机平滑衔接且随时可由人工接管、编辑与试播不污染正式播出、异常状态有明确原因与恢复入口、结束后受管游戏与 OBS 配置安全恢复。

## Positioning

与常见的单页 CS2 HUD 覆盖工具或强绑定云端平台的商业制播方案相比，Mizar 的差异化机制在于：

1. **端到端状态驱动的八场景节目编排，而非孤立的局内覆盖层**：通过 CS2 GSI 与已核验的比赛资料统一驱动赛前等待、BP、对阵开场、局内 HUD、半场、单图结果、图间与整场结果，并与 OBS 专用「Mizar 制播」场景集合、节目音乐及可选 MulNX 运镜协同。
2. **单一运行事实 + 严格多面投影**：`packages/core` 维护唯一 `RuntimeState` 与 `SeriesProgress`，分别向播出画面、雷达、导播工作台、技术诊断与私有观察辅助发布独立投影；HUD、雷达、节目和公开输出共享同一份比赛事实，避免多处手工录入与数据漂移。
3. **默认 Fail-Closed 与防串场／防假数据契约**：通过 `producerInstanceId`、`liveSessionId`、`programSourceGeneration`、`mapEpoch` 与受管 CS2 进程身份核验，拒绝跨场串用、陈旧帧续命或缺失数据的虚构补齐。
4. **本地优先且完整可控的现场生命周期**：核心制播不依赖云端或外部平台；桌面 Host 统一接管受管 CS2 启动、配置事务备份与安全恢复、Demo 隔离试播，以及 OBS 场景集合保护。
5. **私有观察辅助与公开播出的架构级隔离**：较早时间轴的观察辅助（Alcor 方向）在协议与投影层与公开 Program、OBS 及网站 LIVE 彻底隔离，绝不靠界面遮挡代替数据隔离。

## Operating Context

Mizar 运行在 **Windows x64** 现场制播环境（Tauri 桌面宿主 `apps/desktop` + 本地后台服务 `apps/companion` + React/Vite 前端 `apps/web` + CS2 观战客户端 + OBS Studio）。其前端代码库同时承载**两套目标、受众、风险模型与交互契约完全不同的核心 UI 表面**，后续所有设计与工程工作必须严格区分、绝不混用规则：

### 表面 A：Tauri 桌面端导播工作台与准备中心（操作面）

- **代码与路由范围**：`apps/desktop/`（Tauri WebView2 宿主与原生多窗口协调）+ `apps/web/src/workspace/`、`preparation/`、`operator/`、`bp/`、`music/`、`orchestration/`、`audio/`、`resource-library/`、`debug/`、`ui/`、`patterns/`；涵盖准备中心（`/`、`/operator`、`/matches`、`/resources`、`/picture`、`/settings`）、现场工作台（`/workspace`、`/workspace/left`、`/workspace/dock`、`/workspace/review`、`/workspace/connection`、`/workspace/game-picture`）及独立工具（`/operator/hud`、`/packages`、`/debug`）。
- **真实使用场景**：紧张的赛事现场与开播前准备。准备中心默认最大化、保留 Windows 标题栏与任务栏；进入制作后，桌面全屏 Shell 将无边框受管 CS2 游戏窗口（2K 基准下右上 1920×1080）、左栏（640×1440：全宽正方形大雷达、私有提前提示、本场摘要、制作状态、音乐及底部紧贴边缘的 16:9 OBS 画面确认缩略图）和底栏（1920×360：八个常驻场景切换、可选 MulNX 运镜、观战与本机 HUD 控制、OBS 推流／录像输出控制及固定单行异常／退出栏）连续平铺。
- **核心使用诉求与硬约束**：
  - **防误触**：编辑草稿、已保存资源与当前正式启用配置严格分离，保存或导入不隐式启用；高影响／危险操作（如停止 OBS 直播或录像、「结束本次制作」、覆盖或放弃草稿）必须显式确认并清晰说明影响范围；「返回设置」只切换视图，不结束制作、不关闭游戏、不停止网站来源；「结束本次制作」不隐式停止 OBS 输出；人工切场或音乐保持立即优先于自动编排，必须显式恢复自动；普通工作台交互不抢占 CS2 焦点。
  - **状态清晰（正常静默、异常聚焦）**：必须保留独立状态维度（制作状态、游戏输入新鲜度、身份／名单匹配、地图执行绑定、编排模式、OBS 连接与输出、网站同步、试播隔离、音乐与更新），禁止合并为模糊的“就绪／异常”；但该独立性作用于异常告警、状态变化与展开核对阶段，常态一切正常时保持界面安静克制，严禁把所有正常状态平铺成满屏徽章抢占视觉重心。正常等待不报错，自动成功不弹窗，低频参数与技术明细下沉到二级入口或 `/debug`，每条异常写清“发生了什么、现在怎么做和一个主要动作”。
  - **Windows 100% / 125% / 150% 缩放稳定**：准备中心与独立工具共用 1920×1080 逻辑坐标的等比 16:9 桌面画布（以 2560×1440 为视觉评审基准，按容器 CSS 尺寸等比缩放，不重复乘以设备像素比）；现场工作台底栏及各分区**禁止滚动条**，所有常驻控制必须一屏直达、不裁剪不重叠；共享控件保持至少 32px 逻辑点击高度，底栏缩放后实际点击高度不低于 24px；在 1080p 与 1440p 的 100%／125%／150% 缩放下必须验证完整控件边界与无溢出（浏览器检查只证明布局，Windows 原生贴边、阴影、焦点与多显示器需实机验收）。
  - **技术诊断子面（`/debug`）**：共享表面 A 的操作基础与状态语义，以更高的键值／表格信息密度展示运行诊断、问题时间标记、原始协议标识符与支持包导出，服务排障但不参与播出数据链路。

### 表面 B：OBS 16:9 播出层与多套局内 HUD（播出面）

- **代码与路由范围**：`apps/web/src/program/`、`apps/web/src/bp/BpPage.tsx`、`packages/hud-view/`、`packages/hud-config/`、`packages/radar-view/`、`apps/lhm-export/`；覆盖八个注册节目场景（`/program/waiting`、`/program/matchup`、`/program/bp`、`/program`、`/program/halftime`、`/program/map-result`、`/program/intermap`、`/program/match-result`）、紧凑 BP 底栏（`/program/bp-compact`）与低频数据插页（`/program/stats`），由 OBS 固定 1920×1080 Browser Source 加载，同时也复用于桌面本机 CS2 上方的缩放 HUD 覆盖层（`?host=desktop`）与 HUD 编辑器预览。
- **内置播出范围**：默认 **Mizar Pulse** 提供贯通赛前、BP、对阵、局内、半场、图间与赛果的完整节目包装；另有四套参考主流电竞转播视觉语言的局内 HUD 预设（**EWC**、**IEM**、**Perfect World**、**ESL**）。
- **核心使用诉求与硬约束**：
  - **高速 CS2 画面上的瞬间可读性**：局内 HUD 直接透明叠加在高速移动、光影与烟火剧烈变化的 CS2 实时画面之上，面向桌面与移动端直播观众。核心战斗读数（比分、回合计时、生命、当前观察选手、手持武器与弹匣比例、C4 目标状态与雷达）必须具备极高的一眼可读性；阵营身份与物理左右解耦（换边不混淆双方队伍）；死亡、头像缺失、长中英文队名／昵称与满装备状态均不得挤动五人槽位或造成布局跳动。
  - **电竞转播视觉张力与赛事主角定位**：相较于克制紧凑的导播工作台，播出层需要具备职业赛事转播的视觉层次、构图张力与节制有目的的动效衔接（如 BP 揭示、对阵开场落位、GG 3 秒定格过渡）；同时始终坚持**赛事、队伍与选手是主角**，Mizar 保持次级制作署名，且不将播出装饰直接套回工作台或诊断界面。
  - **Strict Snapshot-Only 契约**：`ProgramView` 与 `GameplayHud` 严禁自行建立网络订阅、严禁维护浏览器侧游戏倒计时器、严禁在渲染层重新推导生死、选手身份、回合统计、赛果或暂停状态；所有呈现（包括目标进度、GG 剩余时长、开场实例位置、雷达帧与公共聊天）均严格消费宿主注入的已投影快照（`ProgramSnapshot`、`ProgramPresentation`、`BpSnapshot`、`RadarFrame`）与导演状态。编辑器预览与正式 OBS 播出必须共享同一配置解析与渲染入口。
  - **Fail-Closed 契约**：正式局内播出经 `hasAcceptedProgramSnapshot` 门控，仅当遥测处于 `fresh` 且实时通道处于 `live` 时接受渲染；一旦断流、数据过期、未就绪、配置不受支持或发生跨会话／跨代际／跨地图执行切换（`producerInstanceId` / `liveSessionId` / `programSourceGeneration` / `mapEpoch`），`presentationBoundaryKey` 切换至 `fail-closed`，`GameplayHud` 宁可返回空画面也绝不滞留过期帧或把旧数据拼到新帧。缺失的队标、头像、统计或未揭示的 BP 槽位安全收拢或显示 `—`，绝不伪造身份、比分、选边或位置；C4 预计爆炸伤害及至多 0.5 秒的爆炸后视觉残影严格受状态与数据边界约束；较早时间轴观察辅助严格隔离在公开播出之外。

### 核心关联流程与外部依赖

- **受管游戏与配置事务**：由桌面 Host 统一通过标准 Steam 或可选 MulNX 启动 CS2，启动前备份受管的画质、帧率、观战键位与 GSI 配置，退出或取消时仅恢复仍属受管范围的字段；外部已运行 CS2 需先关闭，不提供通用接管分支。
- **OBS 集成**：通过 OBS WebSocket 维护专用「Mizar 制播」场景集合及受管浏览器源、游戏捕获源与节目音乐媒体源；首次准备前记录返回集合与节目场景，结束制作或退出时尝试恢复，但不自动关闭 OBS 或自动停止直播／录像；直播／录像推流中禁止结构修复。
- **Demo 试播**：以独立临时 BO1 资料与试播隔离标记复核本地 `.dem` 下的 HUD、雷达与音画，期间暂停正式检查点、资料写入、采集与网站输出。
- **节目音乐与可选运镜**：七组本地音频由两层独立 OBS 媒体源播放；可选地图自动编排按可信比赛阶段向 MulNX 提交预设运镜，支持试播、接管与跳过。

## Capabilities and Constraints

### 已确认的核心能力与系统边界

- **分层单向架构**：依赖方向固定为「适配器 → 领域模型（`packages/core`）→ 投影 → 渲染／传输」，通过 `pnpm architecture:check` 校验；`apps/web` 不消费原始 GSI 或完整 `RuntimeState`，`apps/desktop` 不复制比赛、节目或 OBS 状态。
- **不可合并的独立状态维度**：
  - 制作生命周期（`preparation` / `live` / `hidden`）：隐藏仍在制作，准备不等于 OBS 已停播。
  - 游戏输入（`fresh` / `stale` / GSI `silent`）与进程确认（`cs2-closed`）：断流不能推断游戏退出或技术暂停。
  - 身份与名单：Steam64 为唯一稳定选手标识，参赛方 A/B 与当前 CT/T 阵营分离，绝不按昵称猜测或合并账号。
  - 地图计划与执行：计划槽位（`planned` / `awaiting_plan` / `unplanned`）与单次实际执行（`mapEpoch`）分离，同图重开为新执行，已冻结赛果不被普通刷新覆盖。
  - 赛果与统计：上游终局可为 `recorded` / `pending` / `omitted`，不把缺失显示为 0；半场、图间与结果板均为单图统计，整场结果选手表展示最后一图（不称系列累计）。
  - 平台同步：本机认领、可靠开局回执与网站持续接受当前执行 LIVE 为三种独立证据；人工停止后本机立即禁发。
  - 播出配置：未保存草稿、已保存资源与当前正式启用版本三者分离；预设文件只包含受控配置，不含比赛资料、媒体文件、歌曲或可执行脚本。
- **语言与术语契约**：
  - 产品界面、控制项、状态与错误**中文优先**，使用自然中文表达事实与下一步操作，不直接暴露 `vetoA` 等内部枚举；诊断页面允许在中文说明后附原始协议值。
  - 常用专名与代码标识保留原文（CS2、HUD、OBS、GSI、CSTV、GoTV、HTTP、WebSocket、Steam64）。
  - 正式播出画面保留职业电竞惯用的固定英文广播标签（如 `COMING UP`、`SCHEDULED`、`UP NEXT`、`HALFTIME`、`CURRENT`、`MAP STATS`、`FINAL MAP STATS`、`DECIDER`、`PREVIOUS MATCH`），默认节目包计划开赛时间按 `Asia/Shanghai`（UTC+8）展示，赛事名／队名／选手昵称保留来源文本。
- **权限与安全边界**：局域网访问默认只读，禁止远程控制写入；凭据与密钥不回显或导出；支持包导出仅读取受控产品来源并执行精确凭据脱敏，不收集任意私人文件、音视频或原始聊天。

### 明确未决定、未开放或未实机验证的事项

- **缺少正式用户调研数据**：仓库内无经过核验的用户访谈、角色占比、任务频次、留存或可用性量化基线，后续工作不得将产品目标当成已实测用户收益。
- **通用 HUD 外观工作区尚未开放**：当前 HUD 编辑器仅开放预设选择与组件／布局编辑；`theme.semantic` 外观字段由内部配置校验与消费，不能宣称任意外观属性已开放给用户交互编辑。
- **可选高级能力仍受验收约束**：私有观察辅助（提前击杀提示）、可选 MulNX 自动运镜与正式节目精确事件增强（Issue #215）均有各自隔离与回退边界，不能宣称已完成全部真实赛事验收或已具备双路无头接收能力。
- **自动诊断云端接收默认未部署**：代码库存在经用户同意的诊断回传模块，但默认无同意、无配置端点，不能宣称已部署公共云端诊断服务。
- **验证证据分层**：浏览器截图、Playwright 渲染测试与 Storybook 检查不能替代 Windows 原生窗口、DPI、焦点、真实 CS2、真实 OBS 捕获与音轨的实机 RC 验收。
- **无赛事比赛入口差异**：协议与文档导入支持无赛事比赛与空名单，但当前普通新建表单仍创建带赛事的比赛，文档与 UI 不应混淆两者。

## Brand Commitments

- **品牌双星概念**：**Mizar** 为制播主体，**Alcor** 为观察辅助方向名称，二者以相伴双星关联，并在数据与产品边界上保持独立。
- **既有标志资产（不可重绘）**：产品入口与工具统一使用 `apps/web/public/brand/` 中的官方标志（`mizar-app-icon.svg`、`mizar-mark.svg`、`mizar-mark-mono.svg`、`favicon.svg`），保持原有比例、颜色与留白；Windows 桌面图标与 NSIS 安装器素材由桌面资产源和 `scripts/qualification/installer-assets/` 统一维护。
- **播出署名层级**：播出画面中赛事、队伍与选手始终居于首要视觉地位，Mizar 仅作为克制的次级制作署名；严禁虚构队标、赞助商标志或赛事身份。
- **第三方参考非背书声明**：EWC、IEM、Perfect World、ESL 等预设名称仅用于说明 HUD 风格参考方向，不表示与对应赛事组织存在隶属或背书关系；依赖、字体与素材权利统一维护于 `THIRD-PARTY-NOTICES.md`。
- **产品语调**：冷静、诚实、简洁、中文优先——说清当前有证据的事实与下一步可行动作，不夸大就绪状态、不掩盖未知或降级、不用技术行话为现场人员增加负担。

## Evidence on Hand

以下为仓库内已存在的真实文档、样例、组件目录与画面资产，可供后续设计和评审直接引用：

- **产品与架构权威文档**：
  - `README.md`、`docs/guide/product.md`、`docs/guide/quick-start.md`、`docs/guide/data-source-capabilities.md`
  - `docs/design/current-state/product-facts.md` 与 `docs/design/current-state/source-index.md`（逐条证据索引的现状基线）
  - `docs/reference/architecture.md`、`docs/reference/protocol.md`、`docs/reference/telemetry.md`、`docs/reference/music.md`、`docs/reference/orchestration.md`
  - `docs/design/README.md`、`docs/design/brand.md`、`docs/design/ui-system.md`、`docs/design/mizar-pulse.md`、`docs/design/hud-broadcast-presets.md`、`docs/design/program-direction-v1.md`、`docs/design/product-language.md`、`docs/development/terminology.md`、`docs/roadmap.md`
- **品牌与内置播出素材**：`apps/web/public/brand/`（官方标志、Barlow Condensed 与 ESL 预设字体、EWC/ESL 纹理资产）与 `packages/cs2-assets/`（经 ValveResourceFormat 整理的 CS2 展示素材）。
- **真实回放与视觉样例**：`apps/web/public/fixtures/`（如 `ancient-round-03`、`ancient-round-11-defuse`、`nuke-demo-round-01`、`epl-inferno-opening`、`epl-inferno-final-round`、`epl-inferno-video` 含同步背景录像）、`apps/web/src/program/fixtures/` 与 `docs/examples/perfectworld.mizar-hud.json`。
- **界面截图与几何校验记录**：`docs/screenshots/`（含 `workspace-pulse.png`、五套 HUD 截图 `hud-*.png`、`program-veto.gif`、`program-opening.gif`、`desktop-16x9/` 含 `geometry.json` 与 `scaling.json`、`workspace-controls/`、`shared-match-library/`、`preflight-review/` 等）。
- **共享组件目录与令牌校验**：`packages/design-tokens/`（DTCG 设计变量源）、`apps/web/src/ui/` 与 `apps/web/src/patterns/` 的 Storybook 样例（`pnpm design:catalog` / `pnpm design:check`）。
- **明确缺失、严禁后续工作编造的内容**：无真实外部用户证言、无商业客户／合作赛事背书名单、无经过实测的端到端延迟／可用率／性能基准声明、无正式可用性调研数据、无付费定价或托管 SaaS 承诺；不能将浏览器模拟截图当作 Windows／CS2／OBS 实机验收通过证据。

## Product Principles

1. **比赛事实至上，宁缺勿假（Fail-Closed Integrity）**：正式播出与工作台只呈现经验证的当前事实；缺失、过期或冲突状态必须显式暴露或安全清空，绝不为了画面完整或流畅而补造身份、比分、倒计时、选边或统计。
2. **直觉极简、低认知负荷与最少操作（Calm, Intuitive, Minimal-Action UX）**：界面越干净、简洁、直观越好，突出主路径与清晰的视觉层级，不堆砌无谓装饰与冗余文案；尽量减少用户需要做的判断和手动操作，凡是能依靠合理默认值与自动编排完成的流程，绝不要求人工反复确认或手工切换（高影响与危险操作除外）；坚持**正常静默、异常聚焦与渐进披露**——保留“不合并独立状态维度”的真实性要求，但明确该要求作用于异常告警、状态变化与展开核对阶段，常态一切正常时保持界面安静克制，不将正常状态平铺成满屏徽章，低频参数与技术明细下沉至二级入口或 `/debug`。
3. **双面分治，各尽其责（Dual-Surface Discipline）**：桌面导播工作台以高压现场的零误触、清晰主路径与跨 DPI 稳定为首要目标；OBS 16:9 播出层以高速游戏画面之上的瞬间可读性、赛事主体张力与 strict snapshot-only 契约为首要目标。两类界面共享比赛事实，但绝不混淆设计模式与职责边界。
4. **自动推进，人工始终拥有最终控制权（Automated Flow, Human Authority）**：常规流程随比赛状态自动推进以减轻小型团队负担，但人工接管（画面、音乐、推流／录像、网站来源）始终优先，可随时中断并显式交回，过期自动请求绝不抢回控制。
5. **先预览验证，再显式影响播出（Preview Before Broadcast）**：草稿编辑、样例回放与 Demo 试播必须与正式播出隔离；所有改变在线画面、外部平台状态或本机游戏进程的操作都须清晰标示边界与后果，并保留可重试的安全恢复路径。
6. **本地优先，渐进增强（Local-First, Progressive Enhancement）**：不依赖赛事网站、云端服务或可选插件即可完成完整本地转播；RivalHub、MulNX 运镜、音乐与私有观察辅助均作为可独立降级的增强模块，局部故障绝不拖垮核心播出。

## Accessibility & Inclusion

基于 `docs/design/ui-system.md` 与 `docs/design/current-state/product-facts.md` 确认的产品级可用性与无障碍要求（基准参考 WCAG 2.2，且明确当前自动化检查不替代人工与 Windows 实机无障碍验收）：

- **键盘与焦点**：所有交互控件支持完整键盘操作与可见焦点，焦点不被浮层或固定栏遮挡；原生模态对话框保留键盘焦点、Escape 关闭、背景禁用与关闭后焦点恢复；确认弹窗默认焦点落在取消。
- **点击目标与跨 DPI 稳定**：桌面产品共享控件最小逻辑点击区域为 32px，高密度现场底栏在 Windows 100%／125%／150% 缩放后的实际点击高度不低于 24px；严禁通过牺牲点击区或隐藏滚动条来掩盖溢出。
- **拖动替代操作**：HUD 布局编辑器中的组件位置与尺寸调整必须同时提供 X/Y 数值输入、键盘微调与直接控件等拖动替代方式。
- **非单一色彩传达**：所有状态（OBS、B 站、网站同步、名单匹配、遥测新鲜度、安全告警等）必须同时提供明确中文文字与辅助阅读语义，颜色与圆点仅作辅助；不向屏幕阅读器反复朗读高频比赛遥测。
- **减少动效（`prefers-reduced-motion`）**：工作台与播出层均尊重系统减少动效偏好，停止非必要过渡、旋转与呼吸脉冲，但不得因此隐藏事实、破坏可读性或改变节目时序。
- **中文排版与清晰度**：保持中文常规与粗体真实字重（`font-synthesis: none`），中文标题不使用负字距；安装器图片不嵌入中文文案，避免 Windows DPI 缩放导致文字模糊。
