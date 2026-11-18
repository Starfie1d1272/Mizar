# 本机 Demo 试播生命周期

Host 使用同一 Companion、同一 ProgramRuntime 与 OBS 场景控制器试播真实本地 Demo。文件选择、路径能力、受管 CS2 退出与视频恢复由 Host 持有；接口不接收文件路径、不建立 Demo 库或示例数据源。

Host 私有接口为 `POST /operator/runtime/demo-test`，必须提供本次运行的 `x-runtime-token`，任何 `Origin` 都被拒绝。严格请求结构：

- `begin`：`{action:"begin",requestId:<UUID>,teamAName?:string,teamBName?:string}`，名称默认 A/B，最多 128 字符。
- 后续：`{action:"playing"|"finish"|"complete"|"cancel",requestId:<UUID>}`。

成功返回 200，与 `GET /local/v1/demo-test` 相同：`{active,phase,requestId,teamAName,teamBName,dataReady}`；phase 为 idle / starting / playing / stopping / recovery。参数错误 400、认证失败 403、互斥、未满足前提或事务失败 409；参数与生命周期错误返回 `{error:<稳定机器码>,stage,operationId:<UUID>,requestId?:<试播 UUID>,message:<中文提示>}`；认证拒绝仅返回权限错误码。事务异常的响应与 Companion 日志共享 operationId / requestId，底层原因经现有脱敏记录。Native 仅保留有界机器标识与 UUID，不按中文提示白名单判定，不记录任意响应正文。相同活动 begin/playing、已完成 requestId 的 complete/cancel/finish 可重试。

begin 只在原制作生命周期 preparation、无升级、无素材激活、无资料写入、OBS 已连接且未推流时接受。先 flush 正式 checkpoint，再原子写入本机资料目录的 `demo-test.json`，最后隔离输出、切换唯一 Runtime 的 session/source generation、建立无赛事 BO1 空名单临时 binding。该 binding 不写 LocalTournamentStore / Manifest LKG，临时 Runtime 不读取或写入正式系列 checkpoint。正式资料与后台平台刷新、claim、模板修改、资源激活和更新操作被隔离。

starting 丢弃 GSI；Host 确认受管 CS2 正在运行且本次播放请求已提交后调用 playing，原 production owner 进入 live。只有新鲜地图且存在 spectator allplayers coverage 的真实 GSI 才令 dataReady 为真，并自动执行一次成功的手动 Gameplay Take。试播保持 Director manual；允许现有手动场景操作（等待可随时切换，其余需 playing 和数据就绪），自动恢复操作被拒绝。空名单不伪造选手或比赛归属；没有自动名单采集承诺。

初次 Gameplay Take 的异常与失败结果记录 `initial_gameplay_take` 阶段和脱敏原因；失败后的自动尝试至少间隔 5 秒，避免随 GSI 帧重复切场和刷日志，手动场景操作仍可使用。试播临时绑定不能取得本地比赛退出资格；结束后旧正式凭证因上下文修订与 source generation 改变失效，持久恢复仍要求 Host 重新确认。

finish 先停止 Demo GSI，使在途自动 Gameplay Take 失效，回到制作准备状态，再核对等待画面。Host 根据原生会话记录关闭受管游戏并恢复视频设置，再用最新 requestId 调用 complete。OBS 暂未确认时，complete 在原标记确认本机恢复，并返回 recovery 和 `localRestored`。工作台可以离开，正式制作和服务停止仍按原门槛核对。等待画面、资料和输出都恢复后移除标记，记录已完成的 requestId。下次明确进入制作才开放正式 GSI。cancel 仅允许未开始的 starting。

Companion 在组合 Runtime 和投影前读取标记。重启发现标记时进入 recovery 并隔离 GSI 与正式资料。完整标记沿用原 ID。损坏或不可读标记采用本次 Companion 的新 UUID，Host 通过 GET 取得当前恢复身份。等待画面、正式资料、输出恢复或删除标记出错时保留隔离和重试入口。

公开 structured live snapshot、可靠事件和 delivery continuity 在试播期间停止生成；试播画面只使用既有本地节目投影。隔离时等待已有可靠 outbox 操作结束；已发送的正式网络请求无法撤回，新的 cloud snapshot 发送在执行时重新核对当前 session 和隔离状态。

活动试播（包括 recovery）拒绝直接停止 Companion。Host 正常退出先切安全画面、清理游戏并完成配置恢复，完成 complete 后才停止服务；EXE `--stop` 复用既有 Host 退出请求通道。外部强停或服务断线仍保留 marker 与 Host journal，重新启动后恢复。

用户诊断包保留 Native `demo_test` 的实际 phase、OS / JSON / HTTP 证据，以及 Companion 各试播阶段的异常链、operationId 和 requestId；未知合法机器码与阶段仍可导出。重复 Native 请求的聚合不把每次新的 operationId 视为新事故。

Host 播放通过会话专用的 `mizar_demo_<requestId>.cfg` 执行：先持久化恢复记录，再以 `create_new` 创建已验证路径的 `playdemo` 命令，启动 Steam 时只传 `+exec` 和固定 UUID 文件名。CS2 14190 的启动 `+playdemo` 在实机停留于 `DELAYED COMMAND`；同一样本通过 CFG 可以进入播放并提供地图及 10 名选手的 GSI。每次会话文件不覆盖已有 CFG；游戏退出后只清理与记录字节完全一致的文件，发生外部修改时保留文件及恢复记录。原观战 CFG、个人键位和 Demo 隔离边界不变。

会话播放 CFG 的清理所有权转存到独立的逐 UUID 记录。外部修改、部分写入或清理失败仅保留文件与诊断，不阻断核心画质/帧率恢复及 Demo complete；可通过「重试清理试播文件」单独重试。转存失败时仍恢复核心配置，但保留原 journal，直到所有权证据安全转存后才清除，避免丢失恢复依据。
