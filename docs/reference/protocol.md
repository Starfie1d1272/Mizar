# 接口与协议

本文解释交互语义与兼容规则，精确字段和版本以链接的解析器为准。系统职责见[架构](architecture.md)，游戏字段解释见[遥测语义](telemetry.md)。

产品运行时的 `/health.product.appVersion` 来自同包 artifact 元数据，与 `gitSha` 一同供高级设置展示；开发运行或旧包缺少版本号时明确显示不可用。

`GET /local/v1/resource-library` 面向本机受信任页面，汇总示例素材状态及 MulNX 当前版本、已检查版本和镜头来源名称。对应提供方不可用时返回 `null`，不推断安装状态；该查询不返回路径，也不修改资源。MulNX 更新检查继续使用现有 `/operator/orchestration` 控制入口。

原生运行时提交 MulNX 版本选择后，`cameraReady` 表示当前活动运镜已能在所选版本中验证并映射其镜头来源；已明确关闭运镜也可就绪。`false` 表示原配置仍保留但来源暂不可用。该字段不表示游戏已连接或允许运镜执行；执行前仍检查游戏会话及具体镜头来源。

## 契约来源

| 契约                     | 代码入口                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| 比赛文档、赛程窗口       | [context.ts](../../packages/protocol/src/context.ts)               |
| 公开快照、可靠事件       | [output.ts](../../packages/protocol/src/output.ts)                 |
| 本地通道版本             | [version.ts](../../packages/protocol/src/version.ts)               |
| 本地消息与接收校验       | [协议源码](../../packages/protocol/src)                            |
| 节目场景、编排状态与展示 | [program-scenes.ts](../../packages/protocol/src/program-scenes.ts) |
| RivalHub 来源解析        | [适配器源码](../../packages/rivalhub/src)                          |
| HUD 配置与预设文件       | [配置包公共入口](../../packages/hud-config/src/index.ts)           |

Mizar 契约使用严格结构和大小限制，未知字段或不支持版本拒绝。契约分别演进，不同步提升所有通道版本；新增字段先更新契约、解析器与样例，破坏性变化升级相应版本。外部提供方 DTO 的兼容策略由其适配器维护，不能直接替代 Mizar 契约。

## 比赛输入与缓存

`MatchDocumentV1` 保存比赛、参赛方、名单、地图池、地图、BP、时间与解说资料，赛事和阶段允许空值，名单可以为空；`ScheduleWindowV1` 仍保存具有真实赛事关联的有序比赛摘要。

`resultDisposition` 在 RivalHub v2、内部文档和节目投影中保留 recorded、pending、omitted 的区别。recorded 需要合法系列比分，且非弃赛结果不能与已有地图胜负和图序矛盾；pending/omitted 必须保持空比分。上游未结束时不把其汇总比分当成终局结果。持久化、终局投影与比分展示同步更新，当前发布不提供旧 Mizar 读写兼容层。

RivalHub 输入同时接受 `rivalhub.broadcast-manifest.v1` 与 `.v2`。v1 的必需赛事约束保持不变；v2 可表达没有赛事和阶段的比赛，BP 的参赛方引用、地图与比分校验仍然执行。Mizar 本地文档使用既有 v1 容器的可空上下文，旧版本解析器可能拒绝此类新文档，因此不能把无赛事文档交给旧客户端。赛事文档的线格式保持兼容。

无赛事文档可导入并经本地比赛库原子保存、重载和投影，不生成赛事记录或相邻赛程。现有本地创建表单仍创建赛事比赛。公开 LIVE 与可靠事件的 outbound v1 仍要求赛事授权；无赛事绑定不产生该输出，后续独立在线授权需单独演进协议。解说直播外链独立允许无内嵌凭据的绝对 HTTP/HTTPS 地址；拒绝危险 scheme、相对地址、控制字符与反斜杠。它不是素材下载或嵌入入口，不放宽头像、队标等资源的 HTTPS/相对路径规则。清单到比赛文档转换失败进入既有领域诊断，提供阶段、字段路径及修正方向，不输出原始字段值。未知时间和字段保留空值，不从 BP 反推完整地图池，不从阶段显示名称推断阶段键。

赛事测试赛在提供方文档、内部比赛文档和赛程摘要中携带 `isTest`。测试赛使用原赛事授权、参赛方、BP 和 LIVE/reliable 输出，不走演示模式或制造占位赛事。正式比赛的相邻赛程排除测试赛；选中测试赛时只保留本场，不自动衔接正式比赛或其它测试。上游的「测试赛」阶段/场次名称用于原有制作界面展示。此标记控制节目关联，不放宽身份、遥测或输出权限。

来源、修订号、新鲜度和诊断属于获取结果的外层信息，不进入比赛事实。Steam64 使用字符串；参赛方身份与当前 CT/T 阵营分开。身份至少区分 `unbound / resolving / matched / degraded / mismatch`。

| 入口                                                                  | 用途                            |
| --------------------------------------------------------------------- | ------------------------------- |
| `GET /local/v1/match-document`                                        | 当前统一比赛资料及来源信息      |
| `GET /local/v1/tournament`                                            | 本地赛事库、当前选择和相邻赛程  |
| `POST /operator/local-match/create`、`select`、`save`                 | 创建、选择、保存本地比赛        |
| `POST /operator/local-event/save`、`/operator/local-schedule/reorder` | 赛事资料与比赛顺序              |
| `POST /operator/local-asset`                                          | 受大小限制的 PNG/JPEG/WebP 资源 |

队伍复用通过明确 `teamId` 选择，不按同名猜测；更新模板不改写其他比赛已有快照。保存核对当前上下文修订号、结构和引用，持久化使用原子替换。

旧本地赛事库读取时，若结构错误仅来自 rc29 原来接受的解说相对直播链接，则停用这些链接（置为 `null`），不猜测目标网址；其他结构、身份与引用仍须通过完整校验。写回前在原文件同目录保存 `local-tournament.json.before-live-stream-url-<原始字节 SHA-256>.json`，逐字节保留原库和原链接，不覆盖已有备份，再复用原子替换提交。备份不完整或写回失败时保留原库并报告失败；恢复后赛事、队伍、名单、地图、BP 与当前选择可继续使用。新保存、导入及在线输入仍执行严格 URL 规则。备份属于本机资料，不应上传；需要找回旧链接时从备份核对并填写有效绝对地址。该迁移不改授权或 HUD，也不提供旧客户端回退兼容。

RivalHub 资料先经过结构与语义校验，阻断错误不进入 Core。比赛与赛程分别维护最近有效缓存（LKG），恢复重新解析、校验和转换。赛程缓存按赛事与请求时间窗口核对兼容性。

广播统计使用独立的 `rivalhub.broadcast-stats.v1`，由 RivalHub 提供当前赛事统计快照。Companion 在进入制作并激活在线比赛或其在线缓存时使用已配对 installation 读取 `/api/mizar/stats?matchId=...`，按安装和比赛隔离内存缓存。失败或无效响应在制作期间按冷却及 `Retry-After` 持续重试，成功取得有效快照（包括合法空统计）后停止自动刷新；明确的权限拒绝阻断自动获取，直到授权恢复。换比赛、重新进入制作或明确刷新可重新获取，退出制作清除本次快照。本机 `/local/v1/broadcast-stats` 仅读取匹配赛事、双方及首发身份的数据。统计不进入比赛文档、赛程或 Gameplay 投影。自动模式下等待及图间从主画面开始轮播可用统计卡，卡片采用当前节目场景外观而非 HUD 外观；手动模式、暂停与其它节目场景优先。每张卡固定快照，下一张卡才采用刷新。数据不足的专题跳过，设置中的统计状态和刷新属于现有 RivalHub 区域。

同场刷新失败可保留当前绑定并标记过期；切换到另一场失败不能残留上一场。旧请求晚返回不能覆盖新选择；赛程获取失败不清除当前比赛。在线候选恢复后不静默覆盖本地选择，需明确确认。

### 本机头像设置

`GET /local/v1/steam-avatars` 只返回配置与缓存状态；`POST /operator/steam-avatars` 支持 `configure`（保存或清空密钥）和 `clear`（清除缓存）。写操作仅允许本机受信任 Origin。`GET /local/v1/steam-avatar/:filename` 只读取已登记的有界 JPEG 缓存。密钥不回显、不进入比赛文档或支持导出。

## 本机观察器控制

`GET /local/v1/observer` 提供组件版本、连接活动状态与来源健康。工作台通过原生 `observer_command` 提交连接和停止意图，Host 核对当前游戏实例后调用 `POST /operator/runtime/observer`；该接口使用本次运行的私有能力，接受启动、停止和游戏会话续约。入口、运行时、Steam API 及输出路径由安装与运行数据目录推导。连接密码经 stdin 传递，状态响应只含运行摘要。观察器事件进入 Lookahead 来源，消费边界沿用正式节目与私有辅助的独立投影。

`GET /local/v1/observer-assist` 返回观察辅助 `settings`、游戏自动操作 `gameAutomation`、当前连接端点摘要与修订号。受信任本机 Origin 通过 `POST /operator/observer-assist` 通过 `configure`、`configure-game` 分别保存偏好，通过 `connection` 提交本场连接。密码仅随本次服务会话保存在内存，比赛切换清除本场连接。相同有效值再次保存不更新修订或通知消费者；提示时间只更新辅助计算：单改 `leadSeconds` 保留缓冲与测量历史并立即重新投影；旧配置的 `expectedDelaySeconds` 读取时忽略。`revision` 仅用于辅助启停、游戏操作与本场连接准备。

私有 `assist` 通道使用 schema 4；开启时携带来源状态、时间参数、`timingBasis`（`estimated` 或 `program-clock`）、校准状态、只读 `measuredDelaySeconds`、`waitingReason`、距首个提示窗口的 `nextWindowSeconds` 与最多六条击杀提示，包含当前 Program 昵称、唯一观战槽位、预计发生倒计时。当前生产使用的 `estimated` 路径依赖可靠的两源回合时钟校准；校准不足或连续性丢失时等待，不以固定配置延迟猜测。无事件和缓冲为正常等待状态。关闭时沿用基础辅助载荷。Program、雷达和公开输出继续使用各自契约。

Host 的 `prepare` / `start-configured` 绑定游戏实例、Desktop Job 和配置修订，并由 Host 根据游戏启动偏好提交 `useMulnx`。标准路线直接启动选定的观察器；MulNX 路线按自动连接与 HUD 开关提交命令，观察器仍由独立开关决定。节目连接与 HUD 命令复用 MulNX 的 `Game/Command/NoReport` 队列，payload 使用其填充器要求的 JSON 字符串。精确网关回执证明入队，游戏数据与本机控制台查询分别负责节目连接、HUD 值的读回。

`prepare` 返回的 `revision` 是绑定当前游戏实例、Desktop Job、启动方式和配置的准备令牌，Host 原样交给 `start-configured`。返回现场复用已有早源；节目连接与 HUD 操作分别按本场已接受的动作去重。仅改变早源地址、提示时间或重试辅助不重复已接受的节目连接。启动、停止与设置引发的辅助启停串行执行，连接变化、更新的准备令牌与停止使旧在途启动失效；组件加载后、真正创建进程前仍核对取消。

工作台可先进入制作，再在既有本图连接入口提交 `map-connection`：一次确认带唯一标识和连接方式，可留空沿用内存中的地址与密码。同地址的新图重新连接使用新标识，因此不被上一图的节目命令去重吞掉；同一确认失败后的重试保持标识。选择服务器无缝换图时必须沿用已有连接，保留早源且不向同一游戏发送节目连接命令。确认时请求停止旧镜头并清除旧提示；选择下一图时，若节目仍在上次确认的地图，辅助提示和自动运镜等待节目地图上下文变化。节目命令入队、无缝保留和实际游戏连接是不同状态，仍须现场核对。

同一确认标识不得用于不同的连接、方式或下一图选项；服务端拒绝冲突。留空沿用时，标准游戏可显式请求 `copy-connection`，该本机操作要求受信任 Origin 和当前修订，返回仅供复制的节目源命令，响应禁止缓存；普通状态仍不返回密码。

本场 Host 续约仍有效时，关闭辅助只停止早源，重新开启复用本场来源启动；不自动重发节目连接。明确停止、切换连接或超过六秒未续约后，重新启动需 Host 再次确认。`GET /local/v1/observer` 另含 `pending`、有限错误码 `error`（当前为 `observer_operation_failed` 或 null）及 `retryAvailable`。界面结合既有 `failed`、`health`、`terminal` 区分连接中、正常重连与失败；重试沿用原生 `observer_command` 的 `start-configured`，由 Host 重新准备，无需浏览器提交路径或凭据。`retryAvailable` 表示辅助已开启、有本场连接、现场资格有效且无在途操作；即使旧租约已过期，仍可请求 Host 重新核对当前游戏，动作执行时继续校验；进程启动或命令入队不代表真实游戏连接、HUD 或节目画面已经验证。

## 公开实时输出

本机 Program 快照的可选 `payload.allChat` 仅包含当前受管游戏中明确标记 `[ALL]` 的公开聊天，最多三条，每条含稳定标识、发送者、文本与过期时间。它属于本机播出展示，不进入赛事结果、可靠事件、网站 LIVE 或 Lookahead。制作实例、现场会话、Program 数据源代际、地图执行或数据新鲜度变化时清空；同进程同地图重新播放或加载仍按明确的引擎播放/加载边界清空，不依赖地图编号一定改变。不读取 TEAM、私聊、未知时间区间及积压旧消息。前端只按文本节点展示，并自行按过期时间收起，不依赖下一帧到达。

`GET /local/v1/live-snapshot` 返回当前公开状态，`?radar=1` 请求公共雷达；无有效匹配上下文时返回 `503`。只复制正式节目与同代际雷达允许字段，不暴露原始输入、整个运行状态或观察辅助。

C4 异步预测的普通实战更新可最多合并十六毫秒；等待期间保留已发布完整快照及原游标，不另发新游标配旧估算。计算完成重投影当前输入，慢计算公开当前等待状态，连续性或资格失效立即发布。Program 与雷达仍按同一投影批次发布。

本地 Program 的 `map.roundHistory` 可表达经过 Core 绝对编号与比分校验的当前 CT/T 观测历史；无赛事绑定时不含官方获胜方，不改变外部赛果。公开输出的回合历史直接来自系列进展，保留完整/部分/不可用标记。雷达必须与节目属于同一进程、会话、数据源代际、地图执行和接收序号；不满足时 `radar = null`，其余有效状态可继续使用。

公共雷达坐标已经完成地图校准，消费者只按显示尺寸缩放。未知或越界位置为空，不钳到边界或沿用上一帧。楼层、朝向、道具时间与火焰只表达已有证据；外部消费者负责展示平滑，不再做世界坐标校准。结构和字节上限由输出解析器统一维护。

可靠事件来自发生转换时的上下文，包含幂等键、时间、连续性游标、身份与有限赛果。事件种类和逐类负载见 `output.ts`；接收端必须去重，不能把本地观测直接当作官方赛果。

- 高影响事件需要新鲜上下文、匹配身份和当前执行证据。
- 单图结果同时表达参赛方相对比分与当时 CT/T 比分，由生产端完成换边归属，接收端不自行重算。独立的 `map_player_snapshot` 事件关联该结束事件的幂等键，携带当前绑定与地图执行中最后有效的基础数据，最多十人；无完整覆盖证明的 ADR 不输出，缺值保持 null。比分事件保持旧四字段契约。旧接收端可拒绝新增事件，不影响比分和后续赛事。
- 持久投递队列 v2 在同一串行提交中记录随机提交标识与完整载荷 SHA-256（包含事件、终态回执、连续性及待核对标记）；同步并原子替换恢复副本后再替换主文件，全部成功才发布内存。完好 v1 主文件保持可读，下次提交迁移为 v2；损坏 v1 不推断提交代次。主文件通过完整校验时优先，忽略可能较旧或尚未发布的镜像。主文件损坏时先另存两份原始字节；仅在主文件仍有合法 v2 提交标识及摘要、镜像完整校验通过且两者提交标识与摘要均相同时，恢复整个镜像，不拼接记录。主文件缺失、截断、元数据损坏、镜像损坏或不同提交均不能证明一致性：原字节隔离待核对，旧事件不进入发送队列，待核对标记随后续提交持久化并在重启后继续提示。此时允许本地应用启动并生产新的事件，不宣称旧事件已恢复或送达。完整恢复保留原幂等键、终态回执、生产实例、会话和连续性，沿用原发送、授权、退避与过期门禁。摘要用于检测意外损坏，不是身份认证或所有磁盘故障下的最新提交证明。磁盘读取、原字节保全或恢复提交失败仍中断并保留阶段及原因，不报恢复成功。
- 持久投递队列有上限、退避与过期规则。普通重试保持事件和幂等键；上下文明确不兼容时终止旧事件。
- 重启只恢复兼容的投递连续性，不恢复旧遥测、时钟或统计；等待新输入核对。终图事件在当前地图需要继续核验最终比分；同一地图后续有效终局证据冲突时终止旧事件。同生产实例和会话内的跨图恢复按序重放地图边界，并使用当时持久保存的有效名单；快照单独重试且不阻塞后续地图。
- `map_started` 证明已观测到当前有效地图执行，不是首回合开始边沿。首次冻结期或中途接入均可提供证明；同 epoch 的 generation、context/名单/身份恢复、authority 重新认领及重启后，必须收到新的已接受遥测才补发一次，稳定正常帧不重复发布。
- 开始证明使用当时合法的 producer/session/generation/context 与递增 runtime/receive cursor。只有成功构造并可靠入队后才标记发布；投影或持久化失败保留后续新帧的机会。连续性检查点和旧开始事件不能替代新证明；失效恢复轮次的旧开始事件停止重试。
- RivalHub 仍核对 BP、首张未完成地图、十人首发、context/authority/连续性并审计；新证明不覆盖人工接管或正式结果，结束事件不自动恢复权限。跨项目真实实测独立记录。

### HTTP outbound reference

配置 `MIZAR_LIVE_OUTPUT_URL`、`MIZAR_RELIABLE_OUTPUT_URL` 和 `MIZAR_OUTPUT_TOKEN` 启用 HTTPS POST 输出。两个目标独立可选，启用任一个必须提供令牌；禁止内嵌凭据和重定向，令牌只由本地服务使用。

快照默认包含有效公共雷达。可靠事件带 `Idempotency-Key`。`2xx` 表示接受，`408/429/5xx`、网络错误和超时可重试，其他状态拒绝；快照失败丢弃旧值，发送前重新检查当前有效性。

RivalHub LIVE 回执必须明确 `accepted:true` 才表示应用接受。`accepted:false` 的 `frame_expired / contended / delivery_dropped` 及 HTTP 429 的 `capacity` 为正常丢帧；`broadcast_unavailable`、未分类的旧服拒收、无效回执、非 2xx 和超时累计为投递失败。适配器在既有连接状态暴露安全结果、连续未接收计数及持续时间；短暂正常丢帧不提示，持续无成功接收达到阈值后只记录一次诊断并降级。正常丢帧不清除既有失败窗口或告警，只有明确 `accepted:true` 清除提示并确认恢复；没有原因的旧服回执只记未知拒收。失败保留 fetch/read/parse/validate/cancel 阶段及最多三层经过类型、长度、安全字符与既有脱敏校验的异常 name/code/cause，超时独立分类；禁止记录异常 message/stack、网址、凭据与响应正文，未知但合法的异常名称/机器码保留，凭据样式与不合法标识不原样输出。不逐帧记录远端正文，不排队或重试旧 LIVE。可靠事件仍按其独立 ACK 与取消合约处理。

RivalHub 集成使用赛事级凭据、数据源认领和授权修订号。认领后还需建立地图开始证据：实时快照等待当前认领轮次、生产实例、会话、代际和地图执行的 `map_started` 获得成功回执后才发送，等待期间不缓存旧快照；重新认领或执行变化需要新回执。此投递门槛不替代网站的身份、首发与权限校验，见 [ADR-0050](https://github.com/Starfie1d1272/Mizar/blob/3b187e168ad755ede595eb8371bfaf5933c044fa/docs/decisions/0050-live-after-map-start-acknowledgement.md)。恢复队列保留事件原始生产实例；适配器只使用匹配该实例与会话的认领上传，旧事件在本机终止投递，不借用新认领或当前首发证据，见 [ADR-0051](https://github.com/Starfie1d1272/Mizar/blob/3b187e168ad755ede595eb8371bfaf5933c044fa/docs/decisions/0051-recovered-events-and-source-authority.md)。上线顺序优先部署兼容的新 RivalHub，随后更新 Mizar；若旧 RivalHub 仍在运行，它会拒绝临时快照，但应继续接受原格式的比分。可靠队列超时向底层传递取消信号，取消或已被新地图开始投递取代的回执不修改本地授权与地图确认。授权与低频控制请求采用有界等待，重叠授权轮询共用一个在途请求；超时提示使用中文，原始错误保留为日志原因。公开上传速率、超时和队列限制以[连接适配器](../../apps/companion/src/match-context/rivalhub-connection.ts)及[输出实现](../../apps/companion/src/output)为准。`GET /local/v1/reliable-output-status` 仅提供本机投递诊断，不返回完整事件。

`GET /local/v1/rivalhub-schedule` 仅刷新轻量赛程，不预取整表详情。`GET /local/v1/rivalhub-library/:matchId` 按需读取已授权赛事中的单场详情，离线时明确区分已有浏览缓存与缺失资料；缓存不能授予在线来源资格。详情在打开、切换、显式刷新及持续浏览的每分钟读取，当前制作比赛仍每十秒刷新。同授权范围、同场在途读取共享已校验实体；相邻一秒内的自动刷新可复用刚校验的实体，显式读取和载入仍请求网站。授权变化取消旧 scope 在途读并隔离旧回包，不复用旧 ETag。不同场次最多三份在途读取，满额明确返回暂不可用，不排队；失败后释放额度。浏览文件沿用 installation 稳定身份，升级保留已浏览资料，磁盘中的旧 viewer/认领标记不跨 scope 恢复。临时读取故障有界退避，429 遵守 Retry-After；不重放 LIVE 或写请求。网站赛程超过内部相邻赛程契约上限时，保留完整浏览列表，内部相邻赛程不可用并向操作者提示限制，不截断比赛。

授权响应的可选 `authorizedUser` 与赛程的可选 `viewer`（仅 `userId`、`displayName`）、行级 `assignedToViewer` 仅用于连接状态及操作员比赛库；新鲜赛程更新身份和认领标记，字段缺失保持未知。身份和认领信息不进入 Core、通用比赛事实、HUD、雷达或公开输出。排序只置顶本人认领的未结束比赛，历史比赛仍置底；刷新保留有效的手动选择。

`POST /operator/rivalhub/refresh` 使用已配对凭据刷新当前关联比赛，不接收浏览器凭据或任意 URL。与每 10 秒自动刷新共用单个在途请求；不同比赛的待确认选择不被后台刷新覆盖。`GET /local/v1/rivalhub-connection` 包含关联的 `activeMatchId`、`sourceReady`、`sourceBlockedReason`、`lastRefreshAt`、`refreshError` 与受限网站工作台地址。关联 ID 不证明推送资格；十人当前首发未到齐时不消耗界面自动认领次数，后端认领继续核对现场模式、在线资料和快照身份。

`GET /local/v1/obs` 保留实际节目场景、Mizar 预期场景及是否对齐，并增加只读 `programEvidence`：当前集合归属、注册场景与包装类型、预期来源的存在／启用状态，以及游戏采集类型、目标程序类别、目标窗口可选状态、可选 CS2 窗口数、OBS 报告活动与来源尺寸。检查期间场景或集合变化标记 `changed`；查询失败为 null，保持连接事实并记录脱敏原始错误，不解释为没有来源。完整帧健康与实际捕获进程身份保持未验证，不从活动或尺寸推断钩子成功，不将全屏包装未使用游戏源解释为故障。支持包保留这些有限值、节目控制模式、资料有效性、身份与地图绑定状态，不导出任意场景名、窗口标题、输入设置或凭据。

本机允许的 Origin 可取得 `captureDiagnostic` 日志状态。同源浏览器 GET 缺少 Origin 时，必须同时具备同源 Fetch Metadata、本机 Referrer、回环连接及本机 Host；单纯缺少 Origin 不授权采证，跨源或远程不返回该字段的内容。只有唯一对应运行中 OBS 的会话、完整扫描且新鲜的事件参与当前提示；未知或超时不重用旧告警。复查响应直接更新既有状态订阅，较早的在途轮询不能覆盖结果；人工复查在较早采证结束后重新读取。成功记录清除当前故障关联，历史错误继续保留。`reported_success` 只说明日志报告成功，实际画面仍需核对。进程打开失败无错误码时保持未知，错误 5、捕获文件更新错误 32 与挂钩未就绪分别解释；不推断占用程序、不更改权限或结束进程。

OBS 支持采证按固定本机目录分块扫描近期会话，摘要保留分类错误计数、故障代表与最新事件。支持包 `attachments.obsLogs` 提供扫描范围内允许的技术事件全集，附件是技术事件记录，保留允许的固定操作、原因、错误码和事件消息，区分黑名单拒绝、互斥量、捕获文件加载、窗口进程查询及各挂钩事件；它不是完整 OBS 原日志，省略未识别的私人正文、标题、路径与凭据。事件绝对时间从会话起始日期和全部日志时间顺序恢复，跨午夜顺序不明或时钟回拨时标为未知，不使用文件修改日期把旧错误刷新为当前错误。读取、单行、摘要、附件和最终导出均有上限；`scan` 记录读取／文件字节、缺失字节范围、忽略行和截断原因，附件记录遗漏事件数量及首尾时间。最终摘要预算截断与前期扫描截断分别标记，不能用 `exportTruncated=false` 声称完整。保存集合选择合并 OBS 的 Basic 与 BasicWindow 字段，读取成功仅表示持久文件存在。

`GET /local/v1/obs/outputs` 返回 Companion 观察的直播与录像输出状态：`phase`、可空 `active`、在途 `pending` 和 `revision`。OBS 输出事件与首次连接／重连快照共用状态；断线或核实失败为 `unknown`，不能解释为已停止。客户端轻量轮询此本机视图，不直接连接 OBS。

`POST /operator/obs/output` 仅允许本机回环模式与可信 Origin，接收严格的 `{output: "stream" | "record", action: "start" | "stop", expectedRevision}`；修订号使用该输出最近快照的 UUID。不接受 Toggle 或任意 RPC。同一输出只允许一个在途操作，配置、场景修复、音频配置与启停互斥；冲突、过期、未连接及结果未确认返回 `409` 与稳定错误码。RPC 成功后仍等待事件／查询核实实际输出；超时不自动重发，重连只读取状态。OBS 拒绝码按有限类别提示：忙碌、输出未启用并需检查配置、状态已变化或其它明确拒绝；未收到可确认结果时仍为结果未确认，不从超时推断配置缺失。原始拒绝码与原因经现有脱敏 cause 链记录，不直接回显 OBS 原文。命令只使用 OBS 已保存设置，不改变制作生命周期；退出工作台不会隐式停止输出。

POST /operator/obs/ensure 在输出停止时自动创建／启用 Mizar 集合、补齐场景、按当前编排选择初始节目并准备默认音频；返回最终 findings。已有自定义音频或游戏捕获音频时只检查，名称冲突不覆盖。初始化请求超时边界为 30 秒，浏览器请求边界为 40 秒；失败不撤销已成功的步骤，重试按现状补齐。

`POST /operator/obs/audio-setup` 在 OBS 输出停止且当前集合为 Mizar 时，显式添加默认桌面音频与麦克风到 Mizar 场景。已有自定义来源不自动替换；静音、音量、音轨与场景音频检查通过既有 OBS findings 返回。设备选择与实际试听在 OBS 完成。

## 本地实时通道

WebSocket 子协议为 `mizar.local.v1`，路由为 `/local/v1/{channel}`。

| 通道          | 内容                                               |
| ------------- | -------------------------------------------------- |
| `program`     | 正式节目数据；不含未来信息或原始输入               |
| `radar`       | 雷达领域帧，不绑定具体渲染框架                     |
| `operator`    | 制作控制需要的上下文、绑定与诊断                   |
| `assist`      | 当前辅助通道可用性与游标；未冻结能力不预留虚构字段 |
| `program-cue` | 正式节目精确事件形成的短时展示提示                 |

前四者为完整快照，每个消费者只保留一个正在发送和一个最新待发值；新值覆盖旧待发，慢消费者不阻塞其他消费者。重连获取当前基线，不补发历史。

每个连接独立维护接收状态：拒绝不兼容版本、同一进程内运行序号回退或连接中途更换进程；忽略重复/倒序通道序号。会话、数据源代际或地图执行变化时重置对应证明，新进程建立新连接。

`program-cue` 不进入快照存储：先接收基线，再接收当前提示，允许序号间隙并有界去重。发布端使用有界先进先出队列，溢出或超过投递时限丢弃；重置清空旧提示，不补播历史动画。客户端还要核对与节目相同的进程、会话和地图执行，不能将 CSTV 与 GSI 的数据源代际直接比较。

通道传输限制见 [transport-constants.ts](../../apps/companion/src/local-web/transport-constants.ts)；展示动画寿命不属于协议或 Core。

## 制作控制与场景

`program-scenes.director.next` 仅表示后续节目预告，不是切场命令。`nextStatus` 区分 `predicted / awaiting / complete`，`nextReason` 解释证据不足或节目结束；`readyToTake` 是编排服务已满足计时门槛的候选，仍受手动保持、数据有效性与 OBS 确认约束。`blockCause: telemetry` 表示遥测不可用且当前比赛资料与身份没有冲突；等待或图间可继续播放本地统计快照，但不能据此触发 Director 切场。手动保持、暂停、身份冲突和其他阻断仍优先。客户端不得根据预告自行切场或推导比赛阶段。新增字段保持可选以兼容旧快照；当前服务始终提供明确预告状态。

| 入口                                                              | 语义                                                                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /local/v1/readiness`                                         | 汇总数据、场景和 OBS 的当前就绪情况                                                                                                                               |
| `GET /local/v1/production`、`POST /operator/production`           | 制作生命周期及带预期修订号的 `enter / hide / finish / shutdown`（Host 正常退出复用安全收尾；成功后拒绝新进入，允许退出重试）                                      |
| `GET /local/v1/roster-candidate`                                  | 当前可信首发候选                                                                                                                                                  |
| `POST /operator/local-match/capture`、`create-from-server`        | 基于候选与上下文修订号保存；不信任客户端提交的玩家列表                                                                                                            |
| `GET /local/v1/desktop-overlay`、`POST /operator/desktop-overlay` | 仅本机覆盖显隐策略，不更改 OBS 节目                                                                                                                               |
| `GET /local/v1/obs/confidence`                                    | 当前场景缩略图；请求期间切场则返回空                                                                                                                              |
| `POST /operator/obs/launch-target`                                | 本地 Origin 保护的 OBS 程序路径解析，供桌面 Host 独立启动；不返回密码、不启动进程                                                                                 |
| `GET /local/v1/program-scenes`                                    | 当前场景、修订号、候选、阻断与编排状态                                                                                                                            |
| `POST /operator/program-scene`                                    | 有修订号校验的人工切场                                                                                                                                            |
| `POST /operator/program-director`                                 | `{action: "resume", expectedRevision}` 恢复自动；`{action: "warmup", scene: "waiting" \| "gameplay", expectedRevision}` 修改热身自动接续选择，不改变手动/自动模式 |
| `GET /local/v1/program-presentation`                              | 有限节目摘要与相邻赛程，不返回完整比赛文档                                                                                                                        |
| `GET /local/v1/production-guidance`                               | 私有、只读、不缓存的制作提示与平台状态                                                                                                                            |

场景状态的可选 `introRevision` 标识一次开场 Take：准备期间使用本次 `preparing.revision`，成功切入后保留该标识；恢复自动或切到其他场景不创建新的开场实例。浏览器只保留开场标识、时长与最后接受的服务端展示位置，状态读取中断时暂停，恢复后同步 Director 锚点，不保留旧遥测或建立游戏时钟。

切场中的 `preparing` 用于准备渲染，OBS 完成后才提交 `active`；失败清理准备状态，人工意图使旧自动请求失效。静态节目缓存只保留最后安全展示，换比赛清除，不成为赛果来源。

首发候选覆盖上下文、代际、地图执行与成员，在原子写盘前再次核对；缺少阵营归属时由操作者确认。`GET /local/v1/series-binding` 派生当前地图可确认的位置、阻断原因和复核修订令牌，不建立第二份比赛状态。`POST /operator/series/bind` 提交地图执行绑定命令、原因和 `expectedRevision`；上下文、来源代际、地图执行、身份核验或已有赛果变化时拒绝过期确认。只接受身份已核验的同名未完成位置，不允许直接改比分、覆盖已完成位置或新增地图。

## HUD 配置

| 入口                        | 内容                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| `GET /local/v1/hud-config`  | 已启用的解析快照、修订号与 ETag                                  |
| `GET /operator/hud-config`  | 完整编辑文档、启用状态与编辑修订号                               |
| `POST /operator/hud-config` | `save-resource / save-as / activate-preset / import-preset-pack` |

保存不改变播出快照。启用相同解析内容保持播出 ETag，不同内容才产生新快照。每次修改带 `expectedEditorRevision`，在串行提交队列内比较；过期返回 `409`，无效命令 `400`，持久化失败 `500`。冲突保留本地草稿，不自动覆盖或重试；错误响应不泄露底层敏感信息。创建响应明确返回资源身份，不能靠前后列表差推断。

内置资源只读；配置损坏或暂不可读时保留最近有效配置。自定义启用快照独立验证版本、引用、设置、几何和语义值，不用新外观方案重算旧内容；重新启用才更新。内置引用启动时解析当前代码。1.0 前不承诺旧格式迁移，缺字段不静默套默认值。

预设文件只包含已声明的预设、布局和外观，导入原子创建新副本并重写引用，不启用、不执行代码、不携带比赛数据或图片。精确格式和上限见[配置包](../../packages/hud-config/src/index.ts)，可编辑样例见 [perfectworld.mizar-hud.json](../examples/perfectworld.mizar-hud.json)。

播出配置协调器启用时，`GET /local/v1/broadcast-display-config` 返回 `{activeRevision, hud, program}`，三个字段来自同一活动快照；音乐、运镜、设备状态和路径不进入此响应。配置不可读取时返回 `503`。`GET /local/v1/broadcast-config/migration` 是本机受限的迁移状态查询；运镜来源未验证可报告 `pending / camera_identity_unavailable`，此时其他可用模块仍可使用。`GET /local/v1/broadcast-config/pending-camera` 返回 `{ pending }`，保留首次迁移中无法验证的旧运镜目录和策略，或返回 null。`POST /operator/broadcast-config/pending-camera/restore` 接受 `{}`，验证全部来源后原子创建草稿，返回 `{ restored: [{ legacyId, moduleId, activeSnapshot }] }`，不启用运镜；失败保留原记录。`POST /operator/broadcast-config/pending-camera/delete` 接受 `{}`，明确删除待恢复记录。`GET /local/v1/broadcast-presets` 和 `POST /operator/broadcast-presets/{save,clone,preview,apply}` 受本机来源限制；预览不提交活动配置，使用请求由服务端在生产与资源引用守卫内准备并提交。进入制作等待正在进行的使用请求完成 owner 同步；同步失败时保持准备状态并返回错误。

`GET /local/v1/broadcast-modules` 返回 `{ modules: [{ module, builtin, availability }] }`；`availability` 为 `{ state: 'ready' }` 或 `{ state: 'dependency_missing', reason }`，提交使用时仍重新验证。本机操作 `POST /operator/broadcast-modules/save` 接受 `{ value, expectedRevision }`，`clone` 接受 `{ moduleId, expectedRevision, name }`，`apply` 接受 `{ moduleId, expectedRevision, expectedActiveRevision, requestId }`。`delete` 接受 `{ moduleId, expectedRevision, replacement? }`；存在方案引用时，replacement 为 `{ moduleId, expectedPresetRevisions }`，其中音乐或运镜可以用 null 关闭，HUD 和节目必须选同类替代。当前活动模块必须先替换。`POST /operator/broadcast-presets/delete` 接受 `{ presetId, expectedRevision }`，不删除模块。五套内置 HUD 和 Pulse 在服务端禁止更改和删除，复制后的模块独立编辑。

`GET /local/v1/broadcast-assets?resourceId=…&version=…&digest=…&fileId=…` 按完整 `AssetRef` 读取已安装包中的音频或 PNG、JPEG、WebP 图片，查询值分别 URL 编码。成功响应包含实际 `Content-Type` 和 `X-Content-Type-Options: nosniff`；缺失、损坏、不支持分别返回 404、422、415。此接口不接受磁盘路径，也不安装或枚举包。场景图片槽位为 `pulse.background`；配置保存资源引用，页面以完整引用构造本机 URL，预览和正式节目及 BP 共用此映射。Pulse 渲染器支持 `pulse.white`、`pulse.blue`、`pulse.gold`、`pulse.muted`、`pulse.canvas` 和 `pulse.shell` 颜色字段，网页遇到其他字段或图片槽时拒绝预览及从资源页使用。

Pulse 场景支持 `pulse.background` 图片槽，以及 `pulse.white`、`pulse.blue`、`pulse.gold`、`pulse.muted`、`pulse.canvas`、`pulse.shell` 颜色 token；颜色为 `#RRGGBB` 或 `#RRGGBBAA`。其他素材槽、token 或颜色值返回 422 `capability_unsupported`。已活动场景素材损坏时，保留原活动快照和引用锁，迁移状态报告 `program_dependency_unavailable`；显示配置仍返回真实快照供 HUD 使用，并通过响应头 `X-Mizar-Program-Status: dependency_missing` 标明场景不可用，页面须据此显示错误而非呈现替代场景。模块目录和独立 HUD 操作仍可用。修复素材或编辑场景后需显式使用场景，重新验证后恢复显示。

资源释放检查包含草稿、活动及上一个活动快照，以及持久化使用回执所引用的资源。即使随后切换并删除了原模块，对同一 `requestId` 的合法重试仍返回原回执，不重新切换活动配置。

`GET /local/v1/broadcast-modules/:id/references` 返回 `{ moduleId, revision, active, presets: [{ id, name, revision }] }`，供删除前展示引用和提交替代时携带修订；这是提示快照，删除提交时仍检查真实引用、活动状态和修订。

## BP 播放与补录

`GET /local/v1/bp` 是有限的地图卡、步骤、公开标题和播放状态；不返回内部比赛 ID、名单或完整来源文档。ETag 覆盖当前播放进度，浏览器超时隐藏，恢复读取当前值，不重演旧步骤。

- `POST /operator/bp-command` 接收 `{kind: "play" | "hide", expectedRevision}`。修订号随命令、资料变化或回到隐藏态更新，自动揭示不使正常收起命令失效。
- `GET /local/v1/bp-workspace` 使用 `mizar.bp-workspace.v5`，返回来源、就绪、草稿和候选摘要；`standalone` 可编辑本地资料，`bound-overlay` 只补 BP，在线比赛身份与名单保持锁定。草稿可携带有界 `bo3Rules`：`finalBanOrder` 为 `veto_a_first` / `veto_b_first`，`deciderSideChoice` 为 `veto_a` / `veto_b` / `in_game`；缺省请求沿用已有 BP 或本机赛事默认，不假设所有 BO3 规则相同。
- `POST /operator/bp-local-save` 带 `expectedContextRevision`，失败保留旧绑定；成功保存后播放回到隐藏态。
- `POST /operator/bp-rivalhub` 同时核对上下文与待确认候选修订号；确认只激活已验证候选，不发起新的获取。失败刷新保留已有有效候选，新有效结果才替换；旧激活不能清除更新候选。
- `POST /operator/bp-demo` 启动 BO1/BO3/BO5 或退出演示，只在会话隐藏时允许。演示仅在 BP 内存会话生效，不写赛事库、系列赛、身份或在线缓存；退出恢复真实来源，重启不保留演示与播放状态。

## 本地访问与安全

`GET /local/v1/demo-test` 提供有限试播状态：`active`、`phase`（`idle / starting / playing / stopping / recovery`）、`requestId`、双方名称及 `dataReady`。`dataReady` 表示当前新鲜观战数据覆盖，不证明选定文件已经加载，不返回文件路径或私有令牌。

`POST /operator/runtime/demo-test` 仅供持有本次服务私有 `x-runtime-token` 的 Host 使用，拒绝任何网页 Origin。命令为带 UUID `requestId` 的 `begin / playing / finish / complete / cancel`；`begin` 可附双方名称，其余不得附路径、控制台文本或比赛文档。`begin` 需要准备状态、已连接且未推流的 OBS；`playing` 由 Host 再次核对受管进程后提交；`finish` 隔离输入并切等待，`complete` 仅在 Host 确认游戏退出与配置恢复后提交，`cancel` 仅用于未发出游戏启动的准备撤销。重试使用原试播 `requestId`，冲突保持隔离。参数与生命周期错误返回稳定机器码 `error`、实际 `stage`、单次操作 UUID `operationId`、可用时的试播 `requestId` 及中文 `message`；底层异常与响应共享关联号，用户导出的诊断包保留阶段和脱敏原因链，不记录任意私有响应正文。恢复记录损坏时返回新的恢复 ID，Host 按自己的进程日志安全收尾后再确认，不能把损坏字段当控制权。

桌面 `select_demo_file` 只返回本次短期 token 与文件名；`start_demo_test` 使用 token 和双方名称，`enter_demo_test / finish_demo_test` 使用操作 ID。原路径及文件格式校验留在 Host，游戏播放请求使用固定命令与参数；浏览器和局域网不能选择或启动任意本机文件。

`GET /local/v1/updates` 返回有限更新状态、中文说明和制作阻断原因，不返回暂存路径或凭据；`POST /operator/updates` 仅允许本机操作者发起检查、下载、取消、后台检查偏好及结束制作后的恢复自动编排。安装计划只能由持有每次启动私有控制令牌的 Host 调用，拒绝网页 Origin，不接受网页提供的路径或安装参数；原生命令 `install_update` 只允许制作中心主窗口发起。元数据与安装恢复契约见[应用内更新](updates.md)。

应用内更新的安装资格不要求 OBS 已安装或启动。OBS 未连接时仅以成功的 Windows 进程查询确认不存在 obs64/obs32 进程来放行；运行中的未知 OBS 状态、推流或录制继续阻止安装，查询失败保留脱敏原因。页面资格与 Host 安装计划分别核对，不复用页面较早的无进程结果。

桌面私有命令 `set_cs2_preferences` 接收 `qualityPreset`（`very-high / high / medium / preserve`）与 `frameRateLimit`（`60 / 30 / 0`），`cs2_config_status` 返回相同字段及既有恢复状态。只有 Host 解析配置路径、应用设置与保存恢复记录；命令不接受路径或控制台文本。进行中的启动、受管理游戏或待恢复记录阻止修改选项。旧 `preserveQuality` 本机偏好迁移到对应画质及默认 60 帧／秒，不增加公开数据字段。

桌面私有命令 `select_cs2_installation` 仅接受 `executable` 布尔选项，由 Host 打开原生选择框并验证、保存安装根目录；取消返回 false，不安装 GSI。`open_cs2_config_directory` 不接受路径，重新解析当前配置位置后打开文件夹。`gsi_status` 在既有布尔状态外返回 `readFailed`、有限问题列表、候选数、冲突文件与最近操作阶段。路径仅供本机设置页显示；支持包摘要保留问题码与阶段，完整日志保留实际技术路径、参数及相关配置，凭据值被替换。

默认监听 `127.0.0.1`，生产网页与 WebSocket 由同一本地服务提供。非回环访问必须显式设置 `LOCAL_WEB_LAN_MODE=1` 和精确 `LOCAL_WEB_ALLOWED_ORIGINS`；局域网模式禁止控制写入，即使来源在允许列表中。

普通本机修改要求回环监听与有效本机 Origin，不另建普通操作令牌；GSI 认证、验收专用控制令牌与赛事平台凭据相互独立，不混用。高影响操作不离线排队后静默执行。

WebSocket 校验 Origin、子协议和消息大小，通道仅服务端向客户端发送；收到客户端业务消息以 `1008` 关闭。压缩关闭，心跳与缓冲区有界。浏览器按当前页面来源选择 `ws:` 或 `wss:`。

令牌和底层密钥不进入浏览器返回值、公开输出或诊断导出。配置入口与实现见[本地服务源码](../../apps/companion/src)。

### Gameplay 手动门槛与结束提示

`program-scenes` 的 available.gameplay 由新鲜正式输入决定，手动选择不建立赛事绑定；自动编排和非 Gameplay 场景仍受既有可信证据门槛约束。Director 的可选 gg 为 `{ mapEpoch, remainingMs }` 或 null，表示当前自动 Gameplay 的可信单图结束过渡。消费者只在当前场景/执行匹配时显示 GG，不自行推导获胜事实或启动 3 秒倒计时。

Host 私有 `POST /operator/runtime/local-match-exit` 仅允许回环监听、无 Origin 和有效 `x-runtime-token`。`prepare` 为处于准备状态、等待画面的本地独立比赛生成 `{ticket, matchId, contextRevision}`，非适用绑定返回空资格；Host 完成游戏收尾并确认全机没有 CS2 后，以 `settle` 原样回传资格，核对比赛、制作修订和来源代际未变化后接纳关闭期间的接收游标推进，再以 `confirm` 确认该游标。`settle` 每张票据只能成功一次；其后再有新数据、身份变化或重复确认均拒绝。`invalidate` 在新的托管游戏启动前撤销资格。票据与令牌不进入普通本机视图。资格不持久化，恢复的当前选择需通过 Host 重新确认。普通删除确认仍要求本机 Origin，并在最终持久化提交前重新验证活动引用和退出资格。

### OBS 配置实例归属

本机操作员 `POST /operator/obs/remote-commentary/applications` 读取 OBS 应用音频的窗口候选，返回偏好修订与短期候选标识；必要时在空闲的 Mizar 场景集合中创建禁用探测来源。`POST /operator/obs/remote-commentary/application` 接收修订和候选标识，重新核对当前 OBS 连接、集合、探测来源与窗口后保存应用偏好。候选标识一次性使用，过期或上下文变化时拒绝；这些接口要求受信任的本机 Origin，不向公共节目接口暴露窗口信息。

桌面主窗口独占 `begin_obs_configuration` / `finish_obs_configuration` / `read_obs_configuration_context` 权限。开始配置以随机 UUID 关联 Host 保存的启动 `Child` 句柄；通过进程名发现的既有 OBS 不取得归属，显式 `launch_obs` 将实例交由用户管理。配置结束只消费对应会话，其他配置会话未结束时保留；原句柄退出后不通过 PID 或进程名重新取得归属。返回有限 `reason` 与中文 `message`，诊断记录 `obs_configuration` 阶段和脱敏工具失败原因。

结束配置不会发送 WM_CLOSE、WebSocket 停止输出或终止进程：OBS 标准接口不提供原子的空闲退出，Windows 关闭事件可能延迟且输出确认受运行时设置控制。Host 只读核对制作与输出，区分 `production / output / unconfirmed / safe_quit_unavailable` 并提示手动关闭；`not_owned / configuration_in_use / session_finished` 不触碰进程。页面卸载前尚未完成的启动在完成后结束同一会话；重复结束幂等，不消费新会话。

主窗口的原生 `PageLoadEvent::Started` 与 `WindowEvent::Destroyed` 推进 OBS 配置文档代号，不依赖网页卸载时的异步调用。代号由 Host 原子更新；旧会话在 OBS 模块同步清理，等待启动锁或进程检测的旧请求在检查、启动前及提交会话前重新核对。网页先读取 `read_obs_configuration_context` 的字符串 `documentGeneration`，再将其传入开始配置；导航后迟到的旧请求拒绝，不消费新文档会话。导航回调不等待进程或网络操作。

`read_obs_configuration_context` 同时返回该文档的有限保留提示 `message`；下一准备页面读取并展示，重复读取不消费提示，避免 StrictMode 丢失反馈。再次导航时按新的文档代号更新提示，既有或明确交由用户管理的实例不额外提示。Host 重启没有可复用的归属记录，不按名称重建归属。浏览器只保留当前会话对象，不保存归属或文档代号到存储。

私有 operator 的 `matchContext.rosterAuthority` 区分 `local-server / rivalhub / fixture / unknown`，名单编辑权限不从 `origin` 推断；`sourceFailureCode` 是最近真实获取失败的有限类别（网络、超时、授权、未找到、服务、响应、清单或比赛不一致）。它们属于获取外层信息，不写入比赛事实或公开输出。启动缓存不产生失败类别，恢复同版本有效来源后清除失败；原始异常正文和凭据不进入这些字段。

私有 operator 身份诊断的 `affectsExpectedLineup` 由 identity owner 对缺少 Steam64 的 canonical 记录按 `isStarter` 赋值；`false` 保留替补技术诊断但不触发首发恢复操作，`null` 表示旧协议未提供范围；同时存在未知上场账号时先给中性资料来源核对，不断言当前账号不匹配。单独的未标范围缺失诊断不产生当前名单错误。页面不从整体 identity 状态、错图或部分观测推断缺失记录已上场，也不按昵称匹配身份。

### 仅名单差异的在线展示例外

RivalHub 认领请求可选 `allowLineupMismatch: true`；缺省仍严格核对网站首发。Mizar 仅在授权的在线本场资料新鲜、合法当前地图绑定、新鲜当前十名唯一真人且 CT/T 各五人、两方均有当前登记账号证明并与队伍阵营一致时发出。实际账号与预期首发或替补不同是唯一身份问题；资料缺项、重复账号、队伍归属歧义、阵营冲突、错图及过期输入不能获得例外。

公开快照的 `capability.lineupMismatchOnly` 与可靠事件的 `evidence.lineupMismatchOnly` 为可选布尔值，缺失按 false；仅上述证明成立才发 true。允许 `identity=degraded` 的可靠开局与现场比分／遥测展示；LIVE 仍等待同一授权、生产者、会话、代际与地图执行的可靠开局确认。未匹配账号保留 `canonicalPlayerId=null` 与 `identityEvidence=observed`，不按昵称映射登记选手。带上述展示标记的 `map_ended` 仅表达观察到的结束与 CT/T、A/B 候选比分；Mizar 系列状态记录已观察结束但不冻结正式比分或胜者、不增加系列胜场，随后才允许相邻计划图。结束观察、epoch／generation 变化及下一图开局继续经可靠通道与当前授权校验；缺少结束观察不能跳图。正式赛果可靠发送继续需要完整身份匹配，展示结束不授权正式赛果；网站带差异认领记录名单冲突并关闭自动赛果写入。两端协同支持此可选语义后使用，不修改首发或平台生产库。

### 本机诊断历史

`POST /debug/support-bundle` 继续只允许本机受信任 Origin，保留 `mizar-support-bundle/1` 容器；新增 `businessHistory` 附件及其独立 manifest。业务 ID 与诊断名单 Steam64 跨重启和导出保留原值，仅用于使用者明确保存的排障包，不进入新的公开接口，也不自动上传。字段白名单、容量、完整性与旧日志兼容规则见[架构](architecture.md)。

### 本机网站同步健康

`GET /local/v1/rivalhub-connection` 的 `syncHealth` 是仅供制作人员的连接健康投影，不进入正式节目或网站输出。沿用当前关联、现场资格与公开输出身份；有明确绑定地图、完整当前首发与正式 live 观测后开始 15 秒宽限。状态区分未启用、主动停用、其他设备归属、等待、网站正在接收与需要处理；只有当前认领、生产实例、会话、输入代际和地图执行的新 LIVE 接受回执确认恢复。可靠开局确认、认领成功、普通丢帧、旧执行回执和手动补分均不确认恢复。异常标识跨短暂读取缺失与重试保持，真实恢复后下一次异常生成新标识；切比赛或执行重新宽限。

`POST /operator/rivalhub/source/retry` 复用本机来源校验与现场、名单、权限守卫。有当前开局确认时解除实时发送退避，下一次只发送最新快照；未确认开局时重新认领本场，等待新遥测建立当前授权的可靠开局，不重放历史赛果。临时 LIVE 请求失败采用最高 8 秒的有界退避，不缓存或重发旧帧。认领与停止操作在服务端互斥；主动停止先在本次服务运行中禁止本场实时和可靠发送，远端释放失败仍保留本地禁发，只有明确重新认领成功才解除。其他设备归属按比赛限定；HTTP 403 只证明权限失效，不能据此猜测另一台设备。现有诊断与可靠赛果守卫保持独立。

## 本机节目音乐

本地音乐曲目上传 `/operator/music/track` 返回原有曲目字段及经校验的 `portable` 资源引用；旧音乐配置仅保存原曲目字段。

`GET /local/v1/music` 提供本机曲库配置和播放摘要；`POST /operator/music` 保存配置、调整本组音量、停止、下一首或恢复自动；`POST /operator/music/preview` 接收有期限的试听开始、音量更新、续租和停止，核对窗口身份、会话令牌与递增操作编号；不写持久配置或正式播放记录。`POST /operator/music/track` 接收本机选曲，`POST /operator/music/import` 验证并原子应用本地音乐 ZIP。写操作只允许本机可信 Origin，读取检查回环 Host 和浏览器跨站来源；局域网模式拒绝。只返回内容 ID、曲名、策略与必要状态，不返回绝对路径或音频下载地址。比赛、节目、雷达和外部 LIVE 不添加音乐路径或曲库字段；本机私下交付的诊断包保留音乐操作与相关配置，音频正文不进入支持包。格式与限制见[节目音乐](music.md)。

本机诊断导出 `POST /debug/support-bundle` 接受可选 ISO 时间 `from/to` 与可选索引焦点 `focusSessionId`，默认全保留范围；完整日志、压缩分卷、预算和完整性语义统一见[架构](architecture.md)。`POST /debug/control-event` 只允许本机可信 Origin，最多 64 KiB，接收 Mizar 浏览器操作证据，不具备控制或文件读取能力。

`fullLogs.files` 中 `format: obs-log-text/1` 为已关联 Mizar 的 OBS 日志原文经凭据替换后的分卷，采用同一 SHA-256 完整性契约；附带来源会话 UTC 起点与本地时区偏移。`nativeObs` 和 `attachments.obsLogs` 仍是技术事件索引，不能代替原文或证明画面正常。候选选择、预算、拒绝与缺失状态见架构；浏览器不能提交 OBS 文件路径。

## 本机地图编排控制

`GET /local/v1/orchestration` 读取私有预设与请求状态；`POST /operator/orchestration` 接收 configure、create-preset、save-preset、activate-preset、set-automatic、connect、disconnect、resume、hold、skip、audition、browser。`activePresetId` 标识活动预设，`presets` 包含各预设的 `id` 和 `preset` 草稿，`preset` 为独立活动快照。`create-preset` 可带 `sourceId` 复制草稿，省略则创建空预设，响应返回 `createdPresetId`；`save-preset` 带 `id` 和 `preset`，`activate-preset` 带 `id`，仅启用会更新活动快照。旧 `configure` 仍直接更新活动配置。`automaticEnabled` 是持久偏好，`set-automatic` 带布尔 `enabled`，仅准备阶段保存且不发送游戏命令；进入制作时采纳，现场 hold/resume 只改变本次意图。仅回环模式及允许来源可写，恢复/试播绑定当前上下文与连接代际。JSON 上限 256 KiB，严格结构由 `@mizar/protocol/orchestration` 和 Companion 路由共同校验。不接受任意 Provider 地址、控制台命令或文件路径；`isolated` 仅表示专用包磁盘文件符合隔离要求；`held` 表示人工意图，`preparation` 为 waiting / preparing / ready / error，独立表示准备状态。连接与地图变化后自动应用预设并查询活动包和自动列表；自动及手动播放均要求回读成功，状态查询不证明资源加载成功。`request` 的 queued 只表示网关入队，不证明实际播放或停止。`audition` 通过 `stage` 和 `index` 选择本图已保存镜头：开场及单个阶段镜头不传索引，回合使用 `round` 与索引，暂停候选使用 `tactical` / `technical` 与索引。上一条、下一条和重播由客户端保存选择并再次提交；`hold` 停止并保留人工意图。具体语义及候选实机验收见[地图自动编排](orchestration.md)。

桌面 `attach_external_cs2` 仅允许准备中心调用，参数为所选 PID、创建标识和制作修订；可执行路径由 Host 既有安装发现读取。`cs2_config_status` 的 `borrowed` 表示仍持有外部借用意图，`externalDetached` 表示已解除；`running` 只描述本次可用实例，均不代替全机 CS2 停机证明。借用不写受管事务；退出沿用 `finish_workspace` 安全制作收尾后解除，失败保留待重试状态。实际边界见[地图自动编排](orchestration.md)。

`status.control` 区分 browser/native 与 ready/blocked，只是本机控制许可，不是上游执行事实。`browser` 操作携带 `expectedRevision`，在制作生命周期负责者确认准备阶段、非忙碌/试播/更新后同步切换并保持人工。产品服务启动默认 native/blocked，独立开发浏览器服务默认 browser/ready。

`POST /operator/runtime/camera-session` 只接受既有 `x-runtime-token`，拒绝浏览器 Origin 和非回环模式。Host 使用 host-start 注册启动标识并锁定旧原生会话；begin 在当前制作修订的准备阶段生成新租约；pulse 仅延长同 Host/借用代际、尚未失效的六秒期限；invalidate 锁定对应代际。Host 每两秒检查原句柄与唯一性后续约；超时/重启/实例失效/收尾后 connect、resume、audition 和自动调度均拒绝旧许可，必须完成制作后重新交接。旧代际 invalidate 不撤销新代际或浏览器模式。租约标识不作为认证秘密，实际授权仍是运行时令牌，网页不持有它。

### RivalHub 比赛库缓存

`GET /local/v1/rivalhub-schedule` 返回已授权赛事前后各 14 天赛程及 `library` 浏览资料：按 matchId 索引的完整比赛文档、`checkedAt`、`updatedAt`、整体 `syncedAt`、刷新状态与错误说明。后台最多每分钟启动一轮刷新，最多三场并发，首轮取得赛程后即可返回，详情随后填充。提供方 `/api/mizar/match` 支持 ETag / If-None-Match；304 只推进核对时间，200 重新校验和比较单场内容后更新。赛程列表无变化也检查单场，避免漏掉名单、队标或 BP 更新。

缓存按网站地址、授权赛事和安装身份隔离、原子持久化；重启恢复重新校验提供方原文和赛事/比赛标识。网络或单场失败保留已验证内容并明确标记，成功赛程中已移除的比赛不继续出现在库内。浏览缓存不作为正式节目新鲜度依据，不激活比赛。比赛库的“核对并载入本场”是一次明确载入意图：`POST /operator/rivalhub/select` 携带 `activate: true` 后，服务先获取并校验最新资料，再在原上下文修订和候选代次仍匹配时原子持久化、激活；成功返回 `loaded: true` 与对应 `matchId`，界面随后进入本场准备，不再要求页面下方二次确认。获取、并发修订或写盘失败不切换原本场；请求未确认时不显示已载入。不携带该标记的旧调用仍只暂存候选，后台资料冲突也仍需明确确认。连接解除或更换后旧请求不能将旧赛事资料返回给新连接。

`POST /operator/local-match/create` 可选 `eventName` 用于未指定 `eventId` 时自动创建赛事（去除首尾空白、1–128 字）；已有 `eventId` 保留原赛事身份与名称。

### 观战连接命令

端点使用规范十进制 IPv4 与有效端口；IPv4 各分段除单独的 `0` 外不得有前导零。普通输入、高级端点和命令 formatter 使用同一校验，拒绝不规范地址，不静默改写。

本机观战配置接受裸数字 IPv4:port，或只含一次 `connect` 与可选一次 `password` 的受限命令；两条命令可交换顺序，支持大小写、外围空格、参数引号和一个尾分号。拒绝重复／额外命令、无效端口与注入字符，密码字符范围保持不变。27025／27026 固定映射为早源／节目源；其他端点需要显式高级配置。`@mizar/protocol/assist` 的 `formatObserverConnection` 统一输出 password-first 的安全节目源命令；高级端点往返解析需保留原显式早源与节目源配置。

### 本机混音控制

`GET /local/v1/mixer` 返回 `MixerStatus`；`POST /operator/mixer` 接受 `MixerCommand` 并返回 `MixerCommandResult`。协议类型位于 `@mizar/protocol/mixer`。revision 标识后端观察到的绑定上下文，过期命令必须拒绝；写入结果只有经回读确认才返回 `confirmed`。前三路音量是 OBS 观察值，音乐音量是独立的本机 master 配置。音乐条目的可选 `gain` 缺省时使用所属组 `volume`，通过音乐配置保存，旧的组音量命令语义不变。

`POST /operator/resource-library/check-pack` 接收 `application/x-mizarpack`，返回 `source`（含清单摘要）、`name`、外部 `dependencies` 和 `entries`；条目列出 `entryId`、`type`、`kind`、可显示的 `name`、`status`、原因、依赖及现有或已删除副本。`kind` 对方案为 `preset`，对模块为包中模块类型；名称不可读取时使用“未命名模块”或“未命名方案”，`entryId` 仅供选择和关联。状态为 `ready`、`dependency_missing`、`unsupported`、`invalid`、`existing` 或 `removed`；检查是提示快照，提交时重新验证。损坏 ZIP、路径和预算违规或摘要错误整体拒绝，同一身份和版本的不同摘要返回 `409 identity_conflict`。

`POST /operator/resource-library/import-pack` 同样接收完整包字节；查询参数 `selection` 是分别 URL 编码的 JSON `{ "modules": [entryId], "presets": [entryId] }`，`digest` 是检查得到的清单摘要。方案自动带入其所需模块，不支持或无效条目不会阻断其他条目；可解析但本机缺依赖的草稿允许保存，使用时重新验证。响应包含 `mapping`、`reused` 和逐项 `entries`，其中 `result` 为 `imported`、`existing`、`unavailable` 或 `not_selected`；成功的所选条目带可用于定位的 `targetId`。主动选择已删除条目会重新创建；存活副本复用且保留编辑。省略 selection 表示选择全部。导入不启用配置。

已索引包的缓存损坏时，重新选择并导入同一完整身份、经验证的原包可原子修复缓存并复用存活条目；同一 ID 和版本的不同摘要仍返回 `409 identity_conflict`。修复缓存不自动使用场景，须显式使用以重新验证活动显示。

`POST /operator/resource-library/export-pack` 接收 `modules`（每项 `moduleId`、`expectedRevision`）及 `presets`（每项 `presetId`、`expectedRevision`、`expectedModuleRevisions`）数组，至少选择一项；导出前后核对修订。不能编码时返回 `422 export_failed`，`entries` 标识首次无法导出的模块或方案及原因，不生成缺项的成功包。

统一交换支持多套方案，包内共享模块和音频去重，导入后每套方案拥有独立可编辑模块。独立开场音效随包携带；MulNX 外部依赖保留精确发行与归档摘要，使用时由 MulNX owner 核验本机内容。程序本体和播放状态不进入包。

`POST /operator/music` 的 `play` 动作接受 `group` 和 `entryId`；旧客户端可发送 `trackId`，仅在组内唯一匹配时有效。两个字段同时提供时必须指向同一条目。

## LHM CS2 展示宿主（开发入口）

设置 `MIZAR_LHM_ROOT` 为已构建 HUD 的本机目录，`MIZAR_LHM_PORT` 为独立回环端口（默认 1350），可用 `MIZAR_LHM_CONFIG` 指向按 LHM panel 分组的 JSON 值。启动 Companion 后日志给出顶层展示地址。此入口只用于本机验证已信任的构建目录，尚不提供 ZIP 导入、配置编辑、素材上传或安装管理；配置只在启动时读取。不要把目录指向包含机密的文件夹。

宿主以独立 origin 提供静态文件及只读 HTTP/Socket.IO，并使用内容安全策略限制网络访问，不暴露桌面桥接或操作接口。固定身份为 `mizar`；连接与重连都要求客户端注册后发送完整 panel 值和当前正式 Program/Radar 同批投影。`GET /status` 返回当前帧可用状态及缺失项；数据过期或必需的地图、计时、玩家状态、武器覆盖和位置不可用时不发送伪造数据，并刷新已有画面。武器名称缺失时只隐藏该武器；炸弹处于计时状态但缺少相应计时时只隐藏炸弹，其他投影继续更新。当前比赛和队伍从新鲜且已匹配的正式投影生成，按观战槽位确定左右队；比分未知时不提供比赛对象。地图目录复用已核验的 Mizar 校准和图片；官方模板的 Nuke、Train 将两层图按原高度分界合成到一张图。Vertigo 的官方模板写死了专用缩放位置，暂不提供该图；派生模板的多层地图沿用它自己的内置实现，其备用接口不能通过 JSON 表示层可见性函数。队伍标志与面板图片仅使用现有本机素材引用，头像仅使用当前投影引用的 Steam 缓存。panel 图片需由 HUD 的 panel.json 声明，配置值为本机素材 URL；此入口不提供上传。外部图片、赛事、摄像头、投掷物及击杀事件尚不可用。第三方 HUD 自身可能对缺失值使用默认显示。

已构建并在 Chromium 中以仓库真实回放投影试运行官方 `lexogrine/cs2-react-hud` 提交 `7874750c97fcecd8f72eb3fad382917e035ec651` 与派生 `FSA-InfoSA/cs2-react-hud` 提交 `6eb145d5c5d281641d125d8d5a4cb9fb1c121fd3`。这些结果不覆盖真实 Windows、OBS 或 LHM/JT 的验收，也不构成对其他 HUD 的兼容承诺。

### 独立 LHM HUD 导出

`POST /operator/hud-config/export-lhm` 接收 `{ "expectedActiveRevision": "…" }`，只允许回环操作来源。服务端捕获当前 HUD 已启用的解析配置，并在导出完成前复核修订；修订不符返回 409。成功返回 `application/zip` 文件，不更改当前配置或播放状态；缺少预构建运行时或素材时返回 503。

ZIP 根目录包含 `hud.json`、`panel.json`、`keybinds.json`、`mizar-config.json`、预编译浏览器代码与内置素材。`mizar-export-report.json` 列明包含、不支持和需要绑定的项目。该阶段通过 LHM Socket.IO 或 LHM 窗口 IPC 接收 CS2 GSI，复用 Mizar 遥测、运行时和共享 HUD 展示；Mizar 不必运行。BO1、BO3、BO5 比赛系列、队伍身份、标志和选手头像在目标宿主提供时从其只读接口读取，BO2 尚不支持；未绑定或无法确认换边时显示中立 CT/T；目标宿主的比赛数据和媒体不写入 ZIP。炸弹伤害预测、音乐、运镜及节目场景不在此导出范围。实际 LHM/JT、Windows 和 OBS 验收仍需执行。

### Program 统计与装备事实

Program schema 9 为每位选手提供必需的 `statistics` 和 `equipment`，并提供每侧 `teamEconomy`。`statistics` 的数值携带来源、固定窗口和定义版本、回合数、覆盖程度与不可用原因；旧 ADR、伤害、花费及 K/A/D 字段从同一结果映射。`equipment` 包含主副武器、手持武器、Zeus 的武器 ID、道具数量与 C4 事实，完整武器数组仍保留。手持武器要求新鲜、当前且存活的选手有唯一 active 或 reloading 武器；C4 根据炸弹持有者和 carried／planting 状态判断，未知时保留空值。Companion 向 Core 传入按 GSI 武器名称索引的纯语义目录（canonicalKey、kind、family），不向 Core 传图片路径；语义不完整时不能将未知道具当作零。队伍经济只有完整当前五人名单和相应字段可用时才求和。

地图摘要使用 `mizar.program-presentation.v2`，选手摘要必需包含同一 `statistics` 结构。该版本变更需要同步更新冻结器及消费者；Radar、Assist 和网站 broadcast-stats 契约未因此改变。

历史统计的本机展示选择使用独立的 `mizar.broadcast-stats-presentation.v1`，契约位于 `@mizar/protocol/broadcast-stats-presentation`。该结构保留网站快照的比赛、赛事、修订和生成时间，以及两队与选定的两位选手；各固定专题携带稳定 ID、资格与原因、已选行和原始数值及样本。地图分页、手枪／经济／道具字段和七维画像均为固定字段，数值格式化由展示层完成。网站 `rivalhub.broadcast-stats.v1` 仍是原始来源，不用展示筛选结果伪造或覆盖该文档。

节目插页使用 `/local/v1/broadcast-stats-program` 的 `mizar.broadcast-stats-program.v1`。`pages` 是已确定资格及顺序的页面；其中 `playerIds`、`ranks`、`maps`、`recentItems` 和 `vetoSteps` 已按页面筛选及分页。`displayPlayers` 提供当前首发的身份、画像及已选指标；单人介绍的 `profileDefaultId` 与 `playerIds` 分别是默认选手和可选名单。`lineupHasStats`、`profileMode`、`radar.mode` 和 `metricRows` 的存在性由 Companion 判定。每个展示指标包含 `value`、`unit`、`numerator`、`denominator`；百分数为 0–100，`per100` 为每百回合，`per-round` 为每回合，null 是未知而非零。`metricRows.max` 是已算好的比较尺度，`ranks.place` 是名次，展示层仅选择字段和格式化。原始 `history` 为兼容消费者保留，不作为页面自行推导的输入。缺少赛事地图池时不从历史地图推造地图池。

武器页展示已有观测行中按击杀排序的前五项；`weaponCoverage` 明示样本完整性，未知时不能将这些行称为完整武器列表。AWP 仅在已有观测行时展示已知值；只有来源明确标记完整且列表缺行时，才可将该武器计为零。网站当前对武器完整性报告 `unknown`，空列表和缺行不证明零击杀。
