# 接口与协议

本文维护接入语义、可见性、并发与恢复约定。精确字段、版本和容量以解析器及路由为准；职责见[架构](architecture.md)，游戏字段含义见[遥测](telemetry.md)，操作步骤见[使用手册](../guide/quick-start.md)。

## 契约来源

| 契约 | 权威入口 |
| --- | --- |
| 比赛文档与赛程 | [context.ts](../../packages/protocol/src/context.ts) |
| 公开快照与可靠事件 | [output.ts](../../packages/protocol/src/output.ts) |
| 本地通道版本与消息 | [version.ts](../../packages/protocol/src/version.ts)、[协议包](../../packages/protocol/src/) |
| 制作、场景与展示 | [program-scenes.ts](../../packages/protocol/src/program-scenes.ts)、[跨语言生命周期](../../apps/companion/src/match-context/lifecycle-contract.json) |
| 桌面 IPC | [命令、窗口权限和参数与回执](../../apps/desktop/src-tauri/ipc_contract.rs)、[前端校验入口](../../packages/protocol/src/desktop-ipc.ts) |
| RivalHub 输入 | [来源适配器](../../packages/rivalhub/src/) |
| HUD 与播出模块 | [hud-config](../../packages/hud-config/src/index.ts)、[broadcast-config](../../packages/broadcast-config/README.md) |
| 音乐、混音与运镜 | [music.ts](../../packages/protocol/src/music.ts)、[mixer.ts](../../packages/protocol/src/mixer.ts)、[orchestration.ts](../../packages/protocol/src/orchestration.ts) |
| 诊断事件 | [diagnostics.ts](../../packages/protocol/src/diagnostics.ts) |

Mizar 契约严格校验结构、版本与大小，各契约独立演进；破坏性变化升级对应版本，不同步抬升所有通道。提供方 DTO 的兼容规则留在其适配器，不替代 Mizar 契约。

所有桌面 IPC 共用一份 Rust 声明，生成原生命令签名、窗口权限和 TypeScript 参数与结果校验。Web 通过统一传输入口验证参数和 Host 回执，诊断事件交接复用同一入口；调用方不能自行声明结果类型。诊断固定回执校验日志范围、累计丢失和分段信息。更新、游戏停止和备份恢复只授予准备中心窗口，诊断导出授予有入口的制作及诊断窗口。诊断正文等不透明数据由所属领域继续校验。CS2 状态忙碌时只表示当前操作，完整状态用于核对恢复结果。确认制作收尾还要读取并校验本地 OBS 与网站来源收尾证据。

带预期修订的修改在提交时核对；哪些请求需要该字段以对应路由为准，不给严格请求结构自行添加字段。冲突不自动覆盖草稿，也不能因为同为 HTTP 409 就重放；生命周期合同的 `status/error/retryable` 决定允许的自动重试，文案不参与机器判断。未知副作用先核对原操作，不能按未执行处理。

`/health.product.appVersion` 与 `gitSha` 来自同包产物元数据，开发或旧包缺失时显示不可用，不推测版本。

## 本地访问与安全

默认仅监听 `127.0.0.1`，生产网页和 WebSocket 由同一服务提供。非回环查看须显式启用 `LOCAL_WEB_LAN_MODE=1` 并配置精确 `LOCAL_WEB_ALLOWED_ORIGINS`；**LAN 模式只开放公共查看，允许 Origin 不授予私有读取或写入权。**

私有页面、HTTP 接口和私有 WebSocket 要求回环模式及回环 authority。权限按 HTTP 路由实际匹配的入口判断；普通请求读取 Host，绝对 URL 请求读取 URL 中的 authority。页面路径由[网页路径表](../../packages/protocol/src/local-pages.ts)和节目场景共用。普通本机写入另要求可信 Origin。Host 私有 `/operator/runtime/*` 入口另要求本次运行的 `x-runtime-token` 并拒绝网页 Origin；具体入口仍核对制作、窗口或事务资格。GSI 认证、运行时能力、验收令牌和平台凭据互相独立，不混用。

WebSocket 校验 Origin、子协议和消息大小，只允许服务端发送业务数据；客户端业务消息以 1008 关闭。压缩关闭，心跳和缓冲有界。客户端按页面选择 `ws:`/`wss:`。凭据和底层密钥不进入公共投影或诊断导出。诊断可保留排查必需的技术路径，但不接受任意路径采集私人文件内容；高影响操作不离线排队后静默执行。

## 比赛输入与缓存

`MatchDocumentV1` 以单场比赛为根，包含参赛方、名单、地图池、地图、BP、时间与解说；赛事/阶段可空，名单可空。`ScheduleWindowV1` 仍要求真实赛事关联。Steam64 使用字符串，参赛方与 CT/T 分开；身份区分 `unbound / resolving / matched / degraded / mismatch`。

- `resultDisposition` 保留 `recorded / pending / omitted`。已记录结果须有合法比分，待补/不提交保持空比分；进行中的平台汇总不当作终局事实。
- RivalHub 接受 manifest v1/v2，v1 仍要求赛事，v2 可无赛事。无赛事本地文档不生成占位赛事或赛程；outbound v1 仍需赛事授权。旧解析器可能拒绝新的可空上下文，不能承诺旧客户端兼容。
- `isTest` 保留在文档与赛程。测试赛沿用原授权和身份校验，正式相邻赛程排除测试赛，选中测试赛不自动衔接其他比赛。
- 来源、修订、新鲜度和诊断属于外层包络；`source=cache` 的已核实来源可附 `cachedFrom`，缓存本身不授予写入或推送资格。
- 未知时间/字段为空，不从 BP 补造地图池，不从阶段显示名猜键。解说直播链接仅接受无凭据的绝对 HTTP/HTTPS，资源 URL 继续使用自己的更严格规则。

| 入口 | 语义 |
| --- | --- |
| `GET /local/v1/match-document` | 当前统一比赛资料及来源包络 |
| `GET /local/v1/tournament` | 本地库、选择和相邻赛程 |
| `POST /operator/local-match/create`、`select`、`save` | 创建、选择、保存；修订与引用核对后原子提交 |
| `POST /operator/local-event/save`、`/operator/local-schedule/reorder` | 赛事资料与顺序 |
| `POST /operator/local-asset` | 有界 PNG/JPEG/WebP 资源。按字节摘要原子写入，同内容重传可修复残缺文件，读取核对摘要 |
| `POST /operator/local-tournament/reload` | 故障修复后显式重读资料库，不激活比赛 |

队伍复用按明确 `teamId`，不按同名猜测。模板更新不追改其他比赛快照；`create` 的可选 `eventName` 仅在无 `eventId` 时创建赛事。比赛删除/恢复、当前引用和退出资格由[资料库路由](../../apps/companion/src/match-context/local-tournament-routes.ts)与[架构](architecture.md#比赛与赛事上下文)维护。

资料库不可读/解析失败返回 `503 local_tournament_unavailable`，保留文件与草稿，拒绝基于空库或旧内存写回；其他已核实来源继续。重载失败后文件缺失不当作空库恢复。合法旧格式迁移须先完整保全原件，再严格校验和原子提交，不放宽新输入。

### RivalHub 比赛库缓存

| 入口 | 语义 |
| --- | --- |
| `GET /local/v1/rivalhub-schedule` | 授权赛程及已浏览库摘要，不预取整表详情 |
| `GET /local/v1/rivalhub-library/:matchId` | 按需校验单场资料，失败区分浏览缓存与未缓存 |
| `POST /operator/rivalhub/select` | 暂存候选；`activate: true` 则重新获取并按原修订原子激活，成功返回 `loaded/matchId` |
| `POST /operator/rivalhub/refresh` | 使用已配对凭据刷新当前关联比赛，不接收任意 URL 或浏览器凭据 |
| `GET /local/v1/rivalhub-connection` | 关联、来源资格、刷新与同步状态 |

缓存按网站、赛事和安装身份隔离，重启重验提供方原文；浏览不激活比赛，也不作为节目新鲜度。轻量赛程定期刷新，详情在打开/持续查看时按需读取；当前制作比赛另按自身刷新周期。ETag 与核对时间不改变身份或授权，旧 scope 回包不得进入新连接。

同场兼容刷新可保留绑定；切换另一场失败不能残留上场资料。手动选择优先，晚回包不覆盖新选择，BP 冲突须明确确认候选。`authorizedUser/viewer/assignedToViewer` 只用于操作员身份和库排序，缺失保持未知，不进入 Core 或公共输出。

### 本机头像设置

`GET /local/v1/steam-avatars` 只返回配置/缓存摘要；可信本机 `POST /operator/steam-avatars` 支持 `configure` 与 `clear`。`GET /local/v1/steam-avatar/:filename` 只读取已登记的有界 JPEG。密钥不回显、不进入比赛文档或支持包，头像缓存不改变选手身份。

## 本地实时通道

子协议为 `mizar.local.v1`，路由为 `/local/v1/{channel}`。

| 通道 | 内容与交付 |
| --- | --- |
| `program` | 正式节目完整快照，不含未来信息或原始输入 |
| `radar` | 雷达领域完整帧，不绑定展示框架 |
| `operator` | 私有制作、绑定和诊断快照 |
| `assist` | 私有辅助状态、游标与当前提示 |
| `program-cue` | 节目时间轴的短时展示事件，不写快照存储 |

LAN 仅开放 `program/radar/program-cue`，协议发现也只列可访问通道。HTTP 与 WS 共用可见性声明，私有控制不能借白名单开放。

快照消费者各保留一个在发值和一个最新待发值，慢连接不阻塞其他人。重连只取当前基线，不补历史。每个连接拒绝不兼容版本、进程内运行序号回退和中途更换进程，忽略重复/倒序通道序号；会话、来源或执行变化重置对应证明。

单条非文本/非法 JSON 丢弃并记录错误；结构无效或连接中断须重订阅基线，不能继续把旧快照当实时。`GET /local/protocol` 与网页声明用于核对版本；只有取得确实不同且匹配的新网页资源才有界自动重载，不能反复刷新或连接已知不兼容通道。

`program-cue` 先基线后当前提示，有界排队、去重和有效期，溢出或过期丢弃。重置清空旧特效，不补播动画；消费者核对同一生产实例、会话和地图执行，不直接比较 GSI 与 CSTV 的来源代际。限制见[传输常量](../../apps/companion/src/local-web/transport-constants.ts)。

## 公开实时输出

`GET /local/v1/live-snapshot` 返回当前公开状态，`?radar=1` 请求公共雷达；无有效匹配上下文返回 503。只复制允许字段，不返回整个运行状态、原始输入或辅助数据。

雷达须与 Program 属于同一生产实例、会话、来源代际、地图执行和接收序号，否则 `radar=null`，其余有效状态仍可用。坐标已经校准，消费者仅缩放与平滑；未知位置为空，不钳边界或沿用旧帧。C4 异步计算等待时保留完整快照及原游标，完成重投影最新状态，不拼接新游标与旧估算。

本机 Program 的 `allChat` 仅含受管游戏明确的 `[ALL]` 公共聊天，最多三条，按过期时间自行隐藏。它不进入网站 LIVE、可靠事件或 Lookahead；不读取 TEAM、私聊、积压或时间未知的记录，连续性/加载边界清空。浏览器按文本节点展示。

### 可靠事实与顺序

可靠事件由转换发生时的上下文派生，带幂等键、时间、连续性游标、身份和有限结果。种类/字段见 [output.ts](../../packages/protocol/src/output.ts)，接收端必须去重，本地观测不自动等于官方赛果。

- 高影响事实需要新鲜上下文、匹配身份和当前执行证明。单图结果同时携带参赛方与当时 CT/T 比分，接收端不重算换边。选手快照独立关联终图幂等键，未知统计为空，不补造 ADR。
- 已接受事件固定原平台、赛事、安装、比赛、生产实例、会话和 authority，不能借新选场或新认领代发。普通重试保持原事件与幂等键；原授权不可用时保留待处理或终态证据。
- 来源/执行边界及检查点在同一持久事务提交；后续事实不能越过未确认边界、失败检查点或捕获缺口。拒收/过期/撤权保留原范围阻断，不当作送达。
- `map_started` 表示已观察到有效执行，不一定是首回合边沿。恢复或重新认领后必须取得新遥测并可靠入队，旧检查点不代替新证明。
- 重启不恢复旧遥测、时钟和统计。已固定来源的可靠事实可按原身份继续交付，不能用当前首发填旧事件；当前结果冲突仍须按原范围处理。
- 队列、暂存和捕获证据有上限，容量不足明确拒绝/保留缺口，不静默淘汰未知责任或清库恢复。SQLite 落盘、封口、远端接受与来源释放分别证明。活动区间、未知来源和捕获回执各有上限；已经确认并归档的区间保留原证据。

可靠队列初始化失败仅隔离网站同步，状态以 `available:false/records:null` 表示未知，本机有效投影继续。暂态写失败重试原请求和检查点，后续无关成功不能清除屏障；崩溃前未落盘正文无法重建。存储/来源职责与安全恢复见[架构](architecture.md#网站来源与可靠交付)，接口入口见[同步健康](#本机网站同步健康)。

### HTTP outbound reference

设置 `MIZAR_LIVE_OUTPUT_URL`、`MIZAR_RELIABLE_OUTPUT_URL` 和 `MIZAR_OUTPUT_TOKEN` 启用 HTTPS POST；目标独立可选，任一启用都需令牌。禁止 URL 内嵌凭据和重定向，令牌只在本地服务使用。

通用输出的 2xx 表示接受，408/429/5xx、网络错误及超时可重试，其他状态拒绝。可靠请求带 `Idempotency-Key`；快照失败丢弃旧值，下次只发送重新核验的最新状态。

RivalHub 另有业务确认：

- LIVE 必须 `accepted:true` 才表示网站接受。约定丢帧原因不等于失败恢复；只有新的成功回执清除持续未接收状态。不缓存或重发旧 LIVE。
- LIVE 先等待当前认领、生产实例、会话、代际和地图执行的可靠 `map_started` ACK。认领成功、HTTP 200 或 `needs_attention` 均不替代该门槛和实际 LIVE 接收。
- 可靠拒收只接纳约定的原因/恢复动作/合法请求 ID，未知正文不回显。`context_stale` 仅在原范围和名单仍匹配时合并刷新，兼容激活后等待新遥测；`reconcile` 不授权抬升游标或重放事件。
- 超时传递取消，迟到或已被新操作取代的回执不得修改新授权。网络重试有界、按原因退避，日志保留安全阶段与原因码，不逐帧保存网址、凭据或远端正文。

速率、超时、拒收分类和容量以[连接适配器](../../apps/companion/src/match-context/rivalhub-connection.ts)及[输出实现](../../apps/companion/src/output/)为准。`GET /local/v1/reliable-output-status` 返回本机诊断、worker 失败阶段和存储容量（达到九成时标记接近上限），不返回事件正文。worker 无回执或退出后暂停网站投递，正常退出并重启后从原账本和提交回执恢复。

### 仅名单差异的在线展示例外

可选 `allowLineupMismatch:true` 只用于新鲜授权本场、正确地图绑定、当前十名唯一真人与 CT/T 各五人均已证明，且唯一身份问题为首发/替补差异的情况。重复账号、缺项、队伍歧义、错图和过期输入不能取得例外。

`capability.lineupMismatchOnly` / `evidence.lineupMismatchOnly` 缺省 false。例外可展示实时观测并取得可靠开局，未匹配选手保持 observed 身份；LIVE 仍等当前开局 ACK。差异结束只记录观察到的结束与候选比分，不冻结正式比分/胜者、不增加系列胜场，网站关闭自动赛果写入。两端支持后使用，不修改平台首发或正式赛果。

### 本机网站同步健康

`rivalhub-connection` 的 `sourceReady/sourceBlockedCode/sourceBlockedAction/sourceBlockedReason` 派生自当前输出资格，`sourceCommandPending` 只表示在途命令。`sourceCleanup` 区分待释放、受阻、未决认领及 `coverageUnknown`；查询成功、空队列或来源消失不证明责任已结清。

`syncHealth` 区分未启用、主动停用、他机归属、等待、正在接收和需处理。正式 live、地图与首发就绪后有宽限期；只有当前来源/执行的新 LIVE 接受回执确认恢复。认领、开局 ACK、旧执行回执和人工补分不能替代。

| POST 入口 | 作用与限制 |
| --- | --- |
| `/operator/rivalhub/source/claim` | 认领本场，默认不接管其他设备 |
| `/operator/rivalhub/source/resume` | 明确恢复，先处理旧 scope，再合法复用或认领，等待新开局与 LIVE |
| `/operator/rivalhub/source/retry` | 有开局确认则解除当前 LIVE 退避；否则重新核对认领并等新遥测，不重放历史赛果 |
| `/operator/rivalhub/source/release` | 主动停用并交接既有责任；释放失败仍保持本地禁发 |
| `/operator/rivalhub/source/retry-stop` | 只重试同进程仍保留的原人工停止来源，不重认领 |
| `/operator/rivalhub/source/retry-handoff` | 重试已冻结待交接身份，持久交接不等于网站释放 |
| `/operator/rivalhub/output/retry` | 只恢复原边界/待写事件的本机持久化，不认领、不恢复远端授权、不主动发送 |

来源动作固定 `matchId/contextRevision`，执行及异步返回后复核目标；过期认领若已被网站接受，保留原精确身份清理责任，不启用或暂停后来来源。认领意图在请求前按网站、赛事、安装与比赛持久保存，未知结果阻止同场重复认领，不阻断其他合格场次。明确业务拒绝才清除，丢响应/未知查询不能当作未提交；有界轮转对账的迟到确认直接进入原场 `release_pending`，不退役后来来源。清理先核对原范围可靠交付再释放；关闭确认后只补本地归档，不重复释放。

首次自动认领由 Companion 后台维护，不依赖页面轮询；本场已有来源、主动停止、同场他机或同场旧责任未决时不自动恢复。重复自动尝试有预算，条件变化重新核对；显式命令仍受完整资格约束。进入或返回工作台不等于 `resume`。

来源状态版本 3 以有界列表保留各场意图；版本 1/2 先严格校验再原子迁移，保留原范围、授权水位、幂等授权证明和已有采集引用。迁移失败保留原件并隔离来源操作；旧版不能读取版本 3，不支持直接回退或空状态替换。已确认来源与未决意图共同预留容量，满额拒绝新认领而不驱逐证据。

`output/retry` 要求可信本机来源和当前目标，不要求当前发布就绪。200 只确认本机记录；403/409/503 分别表达来源拒绝、目标/记录未确认或能力不可用。初始化失败不能靠此入口解除，修复存储后重启。撤权隔离、区间封口及回执结构由[来源状态](../../apps/companion/src/match-context/rivalhub-source-state.ts)和[队列仓库](../../apps/companion/src/output/outbox-repository.ts)维护，不支持删库、重编号或不同版本并行写入同一数据目录。

## 制作控制与场景

| 入口 | 语义 |
| --- | --- |
| `GET /local/v1/readiness` | 当前数据、场景、OBS 就绪摘要 |
| `GET /local/v1/production`、`POST /operator/production` | 制作状态及带修订的 `enter/hide/finish/shutdown/begin-exit/cancel-exit/retry-handoff` |
| `GET /local/v1/preparation-status`、`POST /operator/preparation-cancel` | 按准备任务身份查询/取消，不重发未知进入请求 |
| `GET /local/v1/program-scenes` | 场景、修订、候选、阻断及编排状态 |
| `POST /operator/program-scene` | 带预期修订的人工切场 |
| `POST /operator/program-director` | `resume` 恢复自动，`warmup` 设置等待/比赛画面接续，不隐式改变控制模式 |
| `GET /local/v1/program-presentation` | 有限节目摘要与相邻赛程 |
| `GET /local/v1/production-guidance` | 私有只读、不缓存的提示与平台状态 |
| `GET /local/v1/roster-candidate` | 可信首发候选 |
| `POST /operator/local-match/capture`、`create-from-server` | 按候选及修订保存，不信任客户端自报玩家列表 |
| `GET /local/v1/series-binding`、`POST /operator/series/bind` | 派生可绑定位置及复核令牌；只接受已核验同名未完成图，不直接改比分或新增图 |
| `GET/POST /local/v1/desktop-overlay` / `/operator/desktop-overlay` | 本机覆盖显隐，不改 OBS |

`begin-exit` 冻结新进入并请求本地来源交接，OBS 与远端收尾分别报告；`cancel-exit` 解除本次退出意图，不清除未完成责任。`retry-handoff` 只在准备期重试原身份，不触碰后来来源或 OBS。生命周期精确响应由[合同](../../apps/companion/src/match-context/lifecycle-contract.json)维护。

导演 `next/nextStatus/nextReason` 只是预告；`readyToTake` 仍需手动保持、数据与 OBS 门槛，客户端不能自行切场。`preparing` 供渲染准备，OBS 确认后才提交 `active`。`introRevision` 标识实际开场 Take，恢复自动或场景重对齐不生成新开场；状态中断暂停展示，恢复同步服务端锚点，不建立浏览器游戏时钟。

### Gameplay 手动门槛与结束提示

人工 Gameplay 选择不要求新鲜遥测，人工对阵可使用现有比赛资料；它们只切画面，不建立赛事绑定或放宽自动资格。导演可选 `gg={mapEpoch,remainingMs}` 仅表示可信终局过渡，客户端核对当前场景/执行后展示，不自行判胜或另起倒计时。

Host 私有 `POST /operator/runtime/local-match-exit` 使用 `prepare/settle/confirm/invalidate` 管理一次性退出票据。Host 实际完成受管收尾并确认全机无 CS2 后才能确认，绑定比赛、制作会话和接收游标；新输入/启动/选择使资格失效。票据不持久化、不进普通视图，恢复的当前选择须重新核实；回收最终写盘仍检查引用与退出资格。

## OBS 控制

[OBS 路由](../../apps/companion/src/obs/routes.ts)统一控制连接、配置、输出与恢复，写操作受本机 Origin、身份、修订和输出状态保护。

| 入口 | 语义 |
| --- | --- |
| `GET /local/v1/obs` | 实际/预期节目、findings、有限节目与捕获证据 |
| `GET /local/v1/obs/confidence` | 当前场景缩略图，请求中切场返回空 |
| `GET /local/v1/obs/outputs` | 直播/录像的 `phase/active/pending/revision` 与捕获准备状态 |
| `POST /operator/obs/output` | 严格 `{output:stream\|record, action:start\|stop, expectedRevision}`，不接受 Toggle 或任意 RPC |
| `POST /operator/obs/ensure`、`repair`、`check` | 显式准备/修复与只读检查分开，返回当前 findings |
| `POST /operator/obs/capture-recover` | 依原事务核对/回收已有项目并刷新证据，不新建、不重启游戏、不切当前节目 |
| `POST /operator/obs/video-preflight`、`video-prepare`、`video-restore` | 制作修订与事务 ID 绑定的视频设置准备/恢复 |
| `POST /operator/obs/capture-warmup`、`capture-initialization`、`capture-warmup-release` | 按准备事务和租约建立、核对、清理临时捕获 |
| `POST /operator/obs/launch-target` | 供 Host 解析既有 OBS 启动目标，不启动进程、不回密码 |

输出启动与结构写入串行，停止命令由输出所有者去重和确认，不等待只读扫描；停止使在途准备的输出租约失效。RPC 成功后仍需事件/查询确认，未知/超时不重发。`active` 只表示 OBS 占用输出，`phase:active` 还需当前代际开始事件或新增发送字节，不能证明平台最终画面。断线/查询失败为 unknown，不当作停止。

新建来源、集合结构与视频写入要求全部视频输出明确空闲。当前集合相关临时捕获租约未结束时阻止新输出；其他集合未决记录分开保全，不以旧责任阻塞当前集合。已有输出只读核对。无唯一实际窗口返回等待，不凭默认目标创建；清理只按原身份与受管变换，未知或人工修改保留责任。结束制作不隐式停止 OBS 输出。

状态、检查、现有设备枚举和采集证据独立于配置写入队列；旧观察不得覆盖新准备结果。`GET /local/v1/obs` 遇到代际变化返回 `409 obs_observation_changed`，客户端重新读取，不按断线或未准备处理。

`programEvidence/captureDiagnostic` 区分节目是否对齐、来源启用、可选目标、尺寸及有限日志原因。场景变化标记 changed，查询失败保持未知；活动、尺寸、日志 `reported_success` 都不证明实际像素。敏感采证 GET 要求可信本机来源；无 Origin 的同源浏览器须同时满足 Fetch Metadata、Referrer、回环和本机 Host，不能仅凭缺 Origin 放行。附件/索引说明扫描范围与遗漏，不冒充完整 OBS 原日志。

### OBS 配置实例归属

桌面主窗口独占 `begin_obs_configuration/finish_obs_configuration/read_obs_configuration_context`。会话关联 Host 实际启动的句柄和文档代号，发现既有进程不授予归属，导航后的旧请求不得创建/消费新会话。

结束配置只消耗对应会话并返回有限原因；不发送关闭窗口、停止输出或强杀。OBS 没有原子空闲退出接口，故制作中、输出中、未知或不具备安全退出能力时保留实例，提示人工关闭。Host 重启不凭进程名或旧 PID 重建归属，浏览器不把会话存入持久存储。

### 本机混音控制

| 入口 | 语义 |
| --- | --- |
| `GET /local/v1/mixer`、`POST /operator/mixer` | 有修订的固定角色混音，写后读回才 `confirmed` |
| `POST /operator/obs/audio-mode` | `desktop/independent/cancel/recover`，按绑定修订切换或恢复原模式事务 |
| `GET /local/v1/obs/audio-devices`、`POST /operator/obs/audio-device` | 固定桌面/麦克风角色的短期设备候选，输出空闲时重验、写入和读回 |
| `POST /operator/obs/remote-commentary/applications`、`application` | 本机应用候选及一次性选择，重验连接、集合和候选，不公开窗口信息 |
| `POST /operator/obs/commentary-prepare`、`audio-setup` | 显式音频准备，不替代实际音轨与试听 |
| `POST /operator/obs/audio-meter` | 约两秒只读输入峰值采样，取消/断线/身份变化结束，不改配置 |

音频切换可沿已准备模式事务在输出期间进行；新增结构仍要求空闲。未知原事务保留，恢复核对 before/applied/mixed 与来源身份，不清空记录。桌面模式可直接换采集设备，但先核对新设备与全部实际监听路径；未知或将重复/丢失节目声音时返回 `audio_device_monitor_unknown/conflict`，只拒绝本次换址，不重放旧监听恢复或加载音乐库。应用未运行可等待或取消，不后台自行切换。

混音音量与音乐 master/曲目 gain 分别归属，输入电平不代表输出音轨或平台有声。OBS 版本、监听设备及回采约束见[音频架构](architecture.md#专用集合音频与迁移)。

## HUD 配置

| 入口 | 语义 |
| --- | --- |
| `GET /local/v1/hud-config` | 已启用解析快照、修订与 ETag |
| `GET /operator/hud-config` | 完整编辑文档、启用状态及编辑修订 |
| `POST /operator/hud-config` | `save-resource/save-as/activate-preset/import-preset-pack` |

修改带 `expectedEditorRevision`，过期 409、无效 400、持久化失败 500。创建返回明确身份，不凭列表差猜结果。保存不改变播出，启用后相同解析内容可保持 ETag；身份与来源回执仍须同步。内置只读，故障保留最后有效配置和原文件，冲突保留草稿不自动覆盖。

暂停样式支持范围由配置能力校验器维护。不支持的新保存/导入/克隆/启用返回 `capability_unsupported`；历史已存配置仅样式不支持时显示回退 `legacy`，以 `x-mizar-hud-fallback: unsupported_pause_visual` 标明，不改原文件。缺字段或渲染器不支持不能套此降级。

预设文件仅含声明的布局、组件和外观，导入为重写引用的新副本，不启用、不执行代码、不含比赛数据或图片。精确结构见[配置包](../../packages/hud-config/src/index.ts)，示例见 [perfectworld.mizar-hud.json](../examples/perfectworld.mizar-hud.json)。

### 统一播出资源

`/local/v1/broadcast-modules`、`broadcast-presets` 与 `broadcast-display-config` 分别提供模块、方案和活动展示。保存/克隆只改草稿，显式 apply 才让各消费者应用；失败模块与未确认回执独立表达。完整命令、引用和逐项导入由[播出配置路由](../../apps/companion/src/broadcast-config/routes.ts)及[交换包](../../packages/broadcast-pack/README.md)维护，不在各编辑器另建活动状态。

`GET /local/v1/resource-library` 汇总官方示例与 MulNX 已选/随包/准备状态；不可用返回 null，不猜安装结果，不回路径或顺带写入。恢复与启用接口见[资源 Store](../../apps/companion/src/resource-store/README.md#升级后的恢复)。

## BP 播放与补录

`GET /local/v1/bp` 返回地图卡、步骤、公开标题和播放状态，不返回内部比赛 ID、名单或完整文档。ETag 包括播放进度，超时隐藏，恢复读取当前值而不重演旧步骤。

| 入口 | 语义 |
| --- | --- |
| `POST /operator/bp-command` | `{kind:play\|hide, expectedRevision}`，自动揭示不让正常隐藏命令过期 |
| `GET /local/v1/bp-workspace` | `mizar.bp-workspace.v5` 来源、就绪、草稿与候选；standalone 可编辑，bound-overlay 仅补 BP |
| `POST /operator/bp-local-save` | 核对 `expectedContextRevision`，失败保留绑定，成功后播放隐藏 |
| `POST /operator/bp-rivalhub` | 核对上下文与候选修订，只激活已验证候选，不再获取或清除更新候选 |
| `POST /operator/bp-demo` | 仅隐藏时进入/退出 BO1/BO3/BO5 演示，仅内存生效 |

BO3 草稿的 `bo3Rules` 有限表达禁图顺序与决胜选边；缺省沿用已有 BP/赛事默认，不假定所有 BO3 相同。演示不改赛事库、系列赛、身份或在线缓存，重启不保留；在线补录不改平台身份和名单。

## 本机观察器控制

| 入口 | 语义 |
| --- | --- |
| `GET /local/v1/observer` | 组件/连接健康、当前失败、pending、retryAvailable、stopReason 与 recovering |
| `GET /local/v1/observer-assist` | 设置、游戏自动操作、连接摘要、mapConnection 和修订，不返回密码 |
| `POST /operator/observer-assist` | 本机可信 Origin 的偏好、连接、接收恢复和校准意图 |
| `POST /operator/runtime/observer` | 仅 Host 私有能力的准备、启动、停止与续约，路径/运行时由安装和数据目录推导 |

`prepare` 的修订令牌绑定游戏、Job、启动方式和配置，原样传给 `start-configured`。辅助设置、节目连接和 HUD 命令分别去重；只改提前时间保留缓冲/测量，不重启已接受游戏连接。停止辅助保留本场连接，`resume-receiver` 核对连接 ID 与修订，旧目标拒绝。

`recalibrate` 提交连接 ID、预期修订和 `calibrationRevision`；仅当前制作、启用且未暂停/等下一图时接受。它推进独立校准修订、清空基线，不重建游戏连接；旧请求 409 不再次清空。

`assist` schema 3 使用 `timingBasis:estimated`，返回测量/等待原因、下个窗口与最多六条提示。当前节目昵称、观战槽位和倒计时来自私有投影；无可靠校准时等待，无事件是正常状态。公开 Program/Radar 不包含这些信息。

### 观战连接命令

端点为规范十进制 IPv4 与有效端口，不接受分段前导零。输入可为裸 `IPv4:port` 或只含一次 `connect` 和可选一次 `password` 的受限命令；拒绝额外命令、重复、危险字符，不执行用户任意控制台文本。格式化统一由 `formatObserverConnection` 完成，明确区分节目与早源端点，高级配置往返保持原值。

每次连接带唯一确认 ID 与方式，同 ID 不得改目标。新图显式新意图，重试保留原 ID；无缝换图沿用连接，不发送游戏 connect。标准游戏可用带修订的 `copy-connection` 取得禁止缓存的复制命令，普通状态仍不回密码。

游戏命令提交前按已核实进程和意图持久去重；未知发送不自动重放，标记写入失败保留本机制作并提示人工处理。网关 queued 只证明入队，实际连接和 HUD 值另行核对。

Host 续租绑定当前实例与退出代次，辅助租约失效停止接收。有效同一意图可在有限窗口恢复一次，不重发游戏/HUD；主动暂停、结束或换连接不自动重启。租约与配置修订不同，不进入浏览器或日志正文，私有认证仍由运行时令牌承担。具体期限与失败分类见[观察器实现](../../apps/companion/src/telemetry/)。

## 本机节目音乐

`GET /local/v1/music` 提供曲库配置和播放摘要；`POST /operator/music` 管理配置、人工播放/暂停/继续/停止/下一首/恢复自动。`play` 优先使用组内 `entryId`，旧 `trackId` 仅唯一匹配时有效，同时提供须指同一条目。

人工播放不依赖比赛阶段或遥测，持续到明确停止、恢复自动或控制变化；自动阶段规则独立。`POST /operator/music/preview` 使用窗口身份、会话令牌和递增编号管理有期限试听，不写正式游标或配置。试听通过 OBS，可能进入输出，不能当私下浏览器播放。监听借用与恢复有独立回执，不改变长期偏好或音轨；媒体播放、监听开启和实际有声分别判断。

查询和播放/停止中的来源核验不准备结构；缺少来源须通过 OBS `ensure/repair` 显式准备，不由试听或后台轮询补建。音乐准备在视觉建立后、最终复核及进入许可之前执行，失败与视觉能力分别报告。

`POST /operator/music/track` / `import` 接收本机音频和 ZIP。Web 读取前检查 32 MiB/128 MiB 限制，服务端独立限制请求和展开内容；413 是文件超限，不是服务离线。失败保留原配置。

这些接口仅本机可信来源，不提供音频下载或绝对路径，不把音乐数据加入公开比赛协议。诊断仅保留操作和相关配置，不含音频正文。包格式、试听租约、人工控制及监听见[节目音乐](music.md)。

## 本机地图编排控制

`GET /local/v1/orchestration` 为私有预设和请求状态；`POST /operator/orchestration` 接受有限配置、预设创建/保存/启用、自动偏好、连接、hold/resume/skip/audition 与浏览器模式命令。结构及大小由[路由](../../apps/companion/src/orchestration/routes.ts)校验，不接受任意地址、控制台文本或路径。

`presets` 是草稿，`activePresetId/preset` 是活动身份和独立快照；保存不启用。`automaticEnabled` 是下次进入偏好，现场 hold/resume 只改本次意图。`held`、`preparation` 与 `status.control` 分别表示人工选择、准备结果与控制许可，不是游戏执行事实。

`audition` 只选择本图已保存阶段/索引。自动与手动播放均须验证隔离包、活动包和空自动列表；`isolated` 只证明磁盘要求，queued 只证明入队，不能证明加载、播放或停止。

Host 私有 `POST /operator/runtime/camera-session` 通过 `host-start/begin/pulse/invalidate` 管理租约，核对制作修订和受管实例。旧心跳/失效代次不撤销新租约或浏览器模式。产品启动默认 native/blocked，浏览器备用需准备期显式选择。启动/卸载与内容格式见[地图自动编排](orchestration.md)，不提供任意外部游戏接管。

## 原生试播、游戏与更新

这些能力由 Host 持有文件选择、路径解析、进程验证和副作用，网页只提交有限意图。

| 入口 | 边界 |
| --- | --- |
| `GET /local/v1/demo-test` | 有限阶段、requestId、双方和 dataReady；数据就绪不证明选定 Demo 已加载 |
| `POST /operator/runtime/demo-test` | 私有 `begin/playing/finish/complete/cancel`，重试原 requestId，未知结果保持隔离 |
| `select_demo_file/start_demo_test` | 短期选择 token 与文件名，不接受网页任意路径；完成须 Host 确认退出与恢复 |
| `set_cs2_preferences/cs2_config_status` | 有限画质/帧率和当前恢复摘要；canPreserve 不是已完成备份或启动证明 |
| `select_cs2_installation/open_cs2_config_directory` | 原生选择或重新解析当前目录，不接收任意打开路径 |
| `GET /local/v1/updates`、`POST /operator/updates` | 有限状态、检查、下载、取消和偏好，不回暂存路径 |
| `install_update` | 仅准备中心主窗口发起，Host 重新核对安装计划与运行资格 |

试播 `cancel` 只用于尚未提交游戏启动的撤销；`complete` 在游戏停止和配置恢复后确认。错误响应使用稳定 error/stage/operationId 与有限中文提示，原始原因只进入脱敏诊断。

`mulnx-prepare` 的窗口尺寸仅接受当前事务的有限正整数 16:9 目标，不接受任意参数；清理/更新不借启动许可。更新安装不要求先打开 OBS，但未连接时须通过实际进程查询确认没有 OBS；未知或活动输出阻止安装。完整信任和恢复规则见[应用内更新](updates.md)。

## 本机诊断历史

事件为 `mizar-diagnostic-event/2`，保留原生产者、序号、事件与业务身份。桌面 `persist_diagnostic_events` 回执确认该批持久化，不证明业务成功；浏览器 `POST /debug/control-event` 经本机来源校验，持久后 204，非法 400，无可用 writer 503。

| 入口 | 语义 |
| --- | --- |
| `POST /debug/support-exports` | 可选 ISO from/to 与已验证 Host pin，返回 exportId/阶段，不回大正文 |
| `GET /debug/support-exports/:id` | 固定任务状态与覆盖摘要 |
| `POST /debug/support-exports/:id/cancel` | 请求取消，不证明 worker 已退出或输入已释放 |
| `GET /debug/support-exports/:id/files/:name` | 受控附件下载，校验本机同源请求 |
| `save_support_bundle(exportId)` | 原生选择目标并保存既有 ZIP，不接收任意源路径或前端摘要 |

`settled` 表示输入使用结束且已尝试收尾，要等待 worker 实际退出；单个终态消息不够。有效 ZIP 的临时清理失败仍可 ready，另报 `cleanupStatus:unconfirmed`，不删除有效包、不伪造正文缺口，也不声称资源全释放。

人工包为 `mizar-support-bundle/2`。覆盖、分卷、pin/保存租约和容量见[诊断架构](architecture.md#诊断证据历史与导出)。旧 `/debug/support-bundle` 不注册；旧包/日志留原位，使用对应版本工具，不自动迁移删除。人工保存不自动公开上传，云回传另遵循[同意与撤回契约](diagnostics-delivery.md)。

## Program 统计与装备事实

Program schema 9 的 `statistics/equipment/teamEconomy` 均来自同一领域计算。统计带来源、窗口、定义版本、回合覆盖及不可用原因；未知为空不当零。手持武器需新鲜存活选手唯一 active/reloading 证据，C4 按持有事实；队伍经济须完整当前五人字段才能求和。渲染层不重算身份、ADR 或经济。

`mizar.program-presentation.v2` 的选手摘要沿用相同统计结构，`seriesWinner` 由 Core 判定；未知为空。来源语义和历史恢复见[遥测](telemetry.md)。

历史赛事统计来自 `rivalhub.broadcast-stats.v1`，按安装、赛事、比赛和双方身份隔离。合法空快照也算成功，失败按权限与退避规则处理；统计不进入比赛文档或 Gameplay。`mizar.broadcast-stats-presentation.v1` 和 `/local/v1/broadcast-stats-program` 的页面、资格、排序、分页及比较尺度由 Companion 计算，展示仅选字段与格式化。

百分数为 0–100，per100/per-round 分别按百回合/回合；null 是未知。武器覆盖 unknown 时，缺行不等于零或完整武器表；缺地图池不能从历史推造。等待页是否轮播由制作生命周期与实际节目决定，人工保持等待不停止场景内轮播，退出/试播不轮播。契约见[统计展示](../../packages/protocol/src/broadcast-stats-presentation.ts)。

## 原生 HUD 导出

`POST /operator/hud-config/export-lhm` 仅允许本机操作来源，按活动/模块修订导出并在完成前复核。包包含预编译 HUD 与必要素材，不含音乐、运镜或节目场景；失败不改活动配置。

导出 HUD 的请求与重试绑定当前连接/比赛，切场、断连和卸载使旧回包失效。只有宿主比赛接口 404 表示明确无本场；坏结构继续重试，不清除有效游戏输入。迟到资料只重投影，不重放 GSI 或延长新鲜度。确认换场撤下旧输入等新数据；有地图计划时需唯一匹配才显示正式身份，否则可中立显示观测。GSI 没有比赛 ID，同图换场或无计划的归属仍依赖宿主，不能以新接收时间作为身份保证。
