# 接口与协议

本文解释交互语义与兼容规则，精确字段和版本以链接的解析器为准。系统职责见[架构](architecture.md)，游戏字段解释见[遥测语义](telemetry.md)。

## 契约来源

| 契约 | 代码入口 |
| --- | --- |
| 比赛文档、赛程窗口 | [context.ts](../packages/protocol/src/context.ts) |
| 公开快照、可靠事件 | [output.ts](../packages/protocol/src/output.ts) |
| 本地通道版本 | [version.ts](../packages/protocol/src/version.ts) |
| 本地消息与接收校验 | [协议源码](../packages/protocol/src/) |
| 节目场景、编排状态与展示 | [program-scenes.ts](../packages/protocol/src/program-scenes.ts) |
| RivalHub 来源解析 | [适配器源码](../packages/rivalhub/src/) |
| HUD 配置与预设文件 | [配置包公共入口](../packages/hud-config/src/index.ts) |

Mizar 契约使用严格结构和大小限制，未知字段或不支持版本拒绝。契约分别演进，不同步提升所有通道版本；新增字段先更新契约、解析器与样例，破坏性变化升级相应版本。外部提供方 DTO 的兼容策略由其适配器维护，不能直接替代 Mizar 契约。

## 比赛输入与缓存

`MatchDocumentV1` 保存比赛、参赛方、名单、地图池、地图、BP、时间与解说资料，赛事和阶段允许空值，名单可以为空；`ScheduleWindowV1` 仍保存具有真实赛事关联的有序比赛摘要。

`resultDisposition` 在 RivalHub v2、内部文档和节目投影中保留 recorded、pending、omitted 的区别。recorded 需要合法系列比分，且非弃赛结果不能与已有地图胜负和图序矛盾；pending/omitted 必须保持空比分。上游未结束时不把其汇总比分当成终局结果。持久化、终局投影与比分展示同步更新，当前发布不提供旧 Mizar 读写兼容层。

RivalHub 输入同时接受 `rivalhub.broadcast-manifest.v1` 与 `.v2`。v1 的必需赛事约束保持不变；v2 可表达没有赛事和阶段的比赛，BP 的参赛方引用、地图与比分校验仍然执行。Mizar 本地文档使用既有 v1 容器的可空上下文，旧版本解析器可能拒绝此类新文档，因此不能把无赛事文档交给旧客户端。赛事文档的线格式保持兼容。

无赛事文档可导入并经本地比赛库原子保存、重载和投影，不生成赛事记录或相邻赛程。现有本地创建表单仍创建赛事比赛。公开 LIVE 与可靠事件的 outbound v1 仍要求赛事授权；无赛事绑定不产生该输出，后续独立在线授权需单独演进协议。未知时间和字段保留空值，不从 BP 反推完整地图池，不从阶段显示名称推断阶段键。

来源、修订号、新鲜度和诊断属于获取结果的外层信息，不进入比赛事实。Steam64 使用字符串；参赛方身份与当前 CT/T 阵营分开。身份至少区分 `unbound / resolving / matched / degraded / mismatch`。

| 入口 | 用途 |
| --- | --- |
| `GET /local/v1/match-document` | 当前统一比赛资料及来源信息 |
| `GET /local/v1/tournament` | 本地赛事库、当前选择和相邻赛程 |
| `POST /operator/local-match/create`、`select`、`save` | 创建、选择、保存本地比赛 |
| `POST /operator/local-event/save`、`/operator/local-schedule/reorder` | 赛事资料与比赛顺序 |
| `POST /operator/local-asset` | 受大小限制的 PNG/JPEG/WebP 资源 |

队伍复用通过明确 `teamId` 选择，不按同名猜测；更新模板不改写其他比赛已有快照。保存核对当前上下文修订号、结构和引用，持久化使用原子替换。

RivalHub 资料先经过结构与语义校验，阻断错误不进入 Core。比赛与赛程分别维护最近有效缓存（LKG），恢复重新解析、校验和转换。赛程缓存按赛事与请求时间窗口核对兼容性。

同场刷新失败可保留当前绑定并标记过期；切换到另一场失败不能残留上一场。旧请求晚返回不能覆盖新选择；赛程获取失败不清除当前比赛。在线候选恢复后不静默覆盖本地选择，需明确确认。

### 本机头像设置

`GET /local/v1/steam-avatars` 只返回配置与缓存状态；`POST /operator/steam-avatars` 支持 `configure`（保存或清空密钥）和 `clear`（清除缓存）。写操作仅允许本机受信任 Origin。`GET /local/v1/steam-avatar/:filename` 只读取已登记的有界 JPEG 缓存。密钥不回显、不进入比赛文档或支持导出。

## 公开实时输出

`GET /local/v1/live-snapshot` 返回当前公开状态，`?radar=1` 请求公共雷达；无有效匹配上下文时返回 `503`。只复制正式节目与同代际雷达允许字段，不暴露原始输入、整个运行状态或观察辅助。

C4 异步预测的普通实战更新可最多合并十六毫秒；等待期间保留已发布完整快照及原游标，不另发新游标配旧估算。计算完成重投影当前输入，慢计算公开当前等待状态，连续性或资格失效立即发布。Program 与雷达仍按同一投影批次发布。

本地 Program 的 `map.roundHistory` 可表达经过 Core 绝对编号与比分校验的当前 CT/T 观测历史；无赛事绑定时不含官方获胜方，不改变外部赛果。公开输出的回合历史直接来自系列进展，保留完整/部分/不可用标记。雷达必须与节目属于同一进程、会话、数据源代际、地图执行和接收序号；不满足时 `radar = null`，其余有效状态可继续使用。

公共雷达坐标已经完成地图校准，消费者只按显示尺寸缩放。未知或越界位置为空，不钳到边界或沿用上一帧。楼层、朝向、道具时间与火焰只表达已有证据；外部消费者负责展示平滑，不再做世界坐标校准。结构和字节上限由输出解析器统一维护。

可靠事件来自发生转换时的上下文，包含幂等键、时间、连续性游标、身份与有限赛果。事件种类和逐类负载见 `output.ts`；接收端必须去重，不能把本地观测直接当作官方赛果。

- 高影响事件需要新鲜上下文、匹配身份和当前执行证据。
- 单图结果同时表达参赛方相对比分与当时 CT/T 比分，由生产端完成换边归属，接收端不自行重算。
- 持久投递队列有上限、退避与过期规则。普通重试保持事件和幂等键；上下文明确不兼容时终止旧事件。
- 重启只恢复兼容的投递连续性，不恢复旧遥测、时钟或统计；等待新输入核对。终图事件还要与当前结束状态和已冻结结果一致。
- `map_started` 证明已观测到当前有效地图执行，不是首回合开始边沿。首次冻结期或中途接入均可提供证明；同 epoch 的 generation、context/名单/身份恢复、authority 重新认领及重启后，必须收到新的已接受遥测才补发一次，稳定正常帧不重复发布。
- 开始证明使用当时合法的 producer/session/generation/context 与递增 runtime/receive cursor。只有成功构造并可靠入队后才标记发布；投影或持久化失败保留后续新帧的机会。连续性检查点和旧开始事件不能替代新证明；失效恢复轮次的旧开始事件停止重试。
- RivalHub 仍核对 BP、首张未完成地图、十人首发、context/authority/连续性并审计；新证明不覆盖人工接管或正式结果，结束事件不自动恢复权限。跨项目真实实测独立记录。

### HTTP outbound reference

配置 `MIZAR_LIVE_OUTPUT_URL`、`MIZAR_RELIABLE_OUTPUT_URL` 和 `MIZAR_OUTPUT_TOKEN` 启用 HTTPS POST 输出。两个目标独立可选，启用任一个必须提供令牌；禁止内嵌凭据和重定向，令牌只由本地服务使用。

快照默认包含有效公共雷达。可靠事件带 `Idempotency-Key`。`2xx` 表示接受，`408/429/5xx`、网络错误和超时可重试，其他状态拒绝；快照失败丢弃旧值，发送前重新检查当前有效性。

RivalHub 集成使用赛事级凭据、数据源认领和授权修订号。公开上传速率、超时和队列限制以[输出实现](../apps/companion/src/output/)为准。`GET /local/v1/reliable-output-status` 仅提供本机投递诊断，不返回完整事件。

## 本地实时通道

WebSocket 子协议为 `mizar.local.v1`，路由为 `/local/v1/{channel}`。

| 通道 | 内容 |
| --- | --- |
| `program` | 正式节目数据；不含未来信息或原始输入 |
| `radar` | 雷达领域帧，不绑定具体渲染框架 |
| `operator` | 制作控制需要的上下文、绑定与诊断 |
| `assist` | 当前辅助通道可用性与游标；未冻结能力不预留虚构字段 |
| `program-cue` | 正式节目精确事件形成的短时展示提示 |

前四者为完整快照，每个消费者只保留一个正在发送和一个最新待发值；新值覆盖旧待发，慢消费者不阻塞其他消费者。重连获取当前基线，不补发历史。

每个连接独立维护接收状态：拒绝不兼容版本、同一进程内运行序号回退或连接中途更换进程；忽略重复/倒序通道序号。会话、数据源代际或地图执行变化时重置对应证明，新进程建立新连接。

`program-cue` 不进入快照存储：先接收基线，再接收当前提示，允许序号间隙并有界去重。发布端使用有界先进先出队列，溢出或超过投递时限丢弃；重置清空旧提示，不补播历史动画。客户端还要核对与节目相同的进程、会话和地图执行，不能将 CSTV 与 GSI 的数据源代际直接比较。

通道传输限制见 [transport-constants.ts](../apps/companion/src/local-web/transport-constants.ts)；展示动画寿命不属于协议或 Core。

## 制作控制与场景

`program-scenes.director.next` 仅表示后续节目预告，不是切场命令。`nextStatus` 区分 `predicted / awaiting / complete`，`nextReason` 解释证据不足或节目结束；`readyToTake` 是编排服务已满足计时门槛的候选，仍受手动保持、数据有效性与 OBS 确认约束。客户端不得根据预告自行切场或推导比赛阶段。新增字段保持可选以兼容旧快照；当前服务始终提供明确预告状态。


| 入口 | 语义 |
| --- | --- |
| `GET /local/v1/readiness` | 汇总数据、场景和 OBS 的当前就绪情况 |
| `GET /local/v1/production`、`POST /operator/production` | 制作生命周期及带预期修订号的 `enter / hide / finish / shutdown`（Host 正常退出复用安全收尾；成功后拒绝新进入，允许退出重试） |
| `GET /local/v1/roster-candidate` | 当前可信首发候选 |
| `POST /operator/local-match/capture`、`create-from-server` | 基于候选与上下文修订号保存；不信任客户端提交的玩家列表 |
| `GET /local/v1/desktop-overlay`、`POST /operator/desktop-overlay` | 仅本机覆盖显隐策略，不更改 OBS 节目 |
| `GET /local/v1/obs/confidence` | 当前场景缩略图；请求期间切场则返回空 |
| `POST /operator/obs/launch-target` | 本地 Origin 保护的 OBS 程序路径解析，供桌面 Host 独立启动；不返回密码、不启动进程 |
| `GET /local/v1/program-scenes` | 当前场景、修订号、候选、阻断与编排状态 |
| `POST /operator/program-scene` | 有修订号校验的人工切场 |
| `POST /operator/program-director` | `{action: "resume", expectedRevision}` 恢复自动 |
| `GET /local/v1/program-presentation` | 有限节目摘要与相邻赛程，不返回完整比赛文档 |
| `GET /local/v1/production-guidance` | 私有、只读、不缓存的制作提示与平台状态 |

切场中的 `preparing` 用于准备渲染，OBS 完成后才提交 `active`；失败清理准备状态，人工意图使旧自动请求失效。静态节目缓存只保留最后安全展示，换比赛清除，不成为赛果来源。

首发候选覆盖上下文、代际、地图执行与成员，在原子写盘前再次核对；缺少阵营归属时由操作者确认。`POST /operator/series/bind` 只提交地图执行绑定命令和原因，不允许直接改比分。

## HUD 配置

| 入口 | 内容 |
| --- | --- |
| `GET /local/v1/hud-config` | 已启用的解析快照、修订号与 ETag |
| `GET /operator/hud-config` | 完整编辑文档、启用状态与编辑修订号 |
| `POST /operator/hud-config` | `save-resource / save-as / activate-preset / import-preset-pack` |

保存不改变播出快照。启用相同解析内容保持播出 ETag，不同内容才产生新快照。每次修改带 `expectedEditorRevision`，在串行提交队列内比较；过期返回 `409`，无效命令 `400`，持久化失败 `500`。冲突保留本地草稿，不自动覆盖或重试；错误响应不泄露底层敏感信息。创建响应明确返回资源身份，不能靠前后列表差推断。

内置资源只读；配置损坏或暂不可读时保留最近有效配置。自定义启用快照独立验证版本、引用、设置、几何和语义值，不用新外观方案重算旧内容；重新启用才更新。内置引用启动时解析当前代码。1.0 前不承诺旧格式迁移，缺字段不静默套默认值。

预设文件只包含已声明的预设、布局和外观，导入原子创建新副本并重写引用，不启用、不执行代码、不携带比赛数据或图片。精确格式和上限见[配置包](../packages/hud-config/src/index.ts)，可编辑样例见 [perfectworld.mizar-hud.json](examples/perfectworld.mizar-hud.json)。

## BP 播放与补录

`GET /local/v1/bp` 是有限的地图卡、步骤、公开标题和播放状态；不返回内部比赛 ID、名单或完整来源文档。ETag 覆盖当前播放进度，浏览器超时隐藏，恢复读取当前值，不重演旧步骤。

- `POST /operator/bp-command` 接收 `{kind: "play" | "hide", expectedRevision}`。修订号随命令、资料变化或回到隐藏态更新，自动揭示不使正常收起命令失效。
- `GET /local/v1/bp-workspace` 使用 `mizar.bp-workspace.v5`，返回来源、就绪、草稿和候选摘要；`standalone` 可编辑本地资料，`bound-overlay` 只补 BP，在线比赛身份与名单保持锁定。草稿可携带有界 `bo3Rules`：`finalBanOrder` 为 `veto_a_first` / `veto_b_first`，`deciderSideChoice` 为 `veto_a` / `veto_b` / `in_game`；缺省请求沿用已有 BP 或本机赛事默认，不假设所有 BO3 规则相同。
- `POST /operator/bp-local-save` 带 `expectedContextRevision`，失败保留旧绑定；成功保存后播放回到隐藏态。
- `POST /operator/bp-rivalhub` 同时核对上下文与待确认候选修订号；确认只激活已验证候选，不发起新的获取。失败刷新保留已有有效候选，新有效结果才替换；旧激活不能清除更新候选。
- `POST /operator/bp-demo` 启动 BO1/BO3/BO5 或退出演示，只在会话隐藏时允许。演示仅在 BP 内存会话生效，不写赛事库、系列赛、身份或在线缓存；退出恢复真实来源，重启不保留演示与播放状态。

## 本地访问与安全

桌面私有命令 `set_cs2_preferences` 接收 `qualityPreset`（`very-high / high / medium / preserve`）与 `frameRateLimit`（`60 / 30 / 0`），`cs2_config_status` 返回相同字段及既有恢复状态。只有 Host 解析配置路径、应用设置与保存恢复记录；命令不接受路径或控制台文本。进行中的启动、受管理游戏或待恢复记录阻止修改选项。旧 `preserveQuality` 本机偏好迁移到对应画质及默认 60 帧／秒，不增加公开数据字段。

默认监听 `127.0.0.1`，生产网页与 WebSocket 由同一本地服务提供。非回环访问必须显式设置 `LOCAL_WEB_LAN_MODE=1` 和精确 `LOCAL_WEB_ALLOWED_ORIGINS`；局域网模式禁止控制写入，即使来源在允许列表中。

普通本机修改要求回环监听与有效本机 Origin，不另建普通操作令牌；GSI 认证、验收专用控制令牌与赛事平台凭据相互独立，不混用。高影响操作不离线排队后静默执行。

WebSocket 校验 Origin、子协议和消息大小，通道仅服务端向客户端发送；收到客户端业务消息以 `1008` 关闭。压缩关闭，心跳与缓冲区有界。浏览器按当前页面来源选择 `ws:` 或 `wss:`。

令牌和底层密钥不进入浏览器返回值、公开输出或诊断导出。配置入口与实现见[本地服务源码](../apps/companion/src/)。

### Gameplay 手动门槛与结束提示

`program-scenes` 的 available.gameplay 由新鲜正式输入决定，手动选择不建立赛事绑定；自动编排和非 Gameplay 场景仍受既有可信证据门槛约束。Director 的可选 gg 为 `{ mapEpoch, remainingMs }` 或 null，表示当前自动 Gameplay 的可信单图结束过渡。消费者只在当前场景/执行匹配时显示 GG，不自行推导获胜事实或启动 3 秒倒计时。
