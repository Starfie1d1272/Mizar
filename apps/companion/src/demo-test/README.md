# 本机 Demo 试播生命周期

Host 使用同一 Companion、同一 ProgramRuntime 与 OBS 场景控制器试播真实本地 Demo。文件选择、路径能力、受管 CS2 退出与视频恢复由 Host 持有；接口不接收文件路径、不建立 Demo 库或示例数据源。

Host 私有接口为 `POST /operator/runtime/demo-test`，必须提供本次运行的 `x-runtime-token`，任何 `Origin` 都被拒绝。严格请求结构：

- `begin`：`{action:"begin",requestId:<UUID>,teamAName?:string,teamBName?:string}`，名称默认 A/B，最多 128 字符。
- 后续：`{action:"playing"|"finish"|"complete"|"cancel",requestId:<UUID>}`。

成功返回 200，与 `GET /local/v1/demo-test` 相同：`{active,phase,requestId,teamAName,teamBName,dataReady}`；phase 为 idle / starting / playing / stopping / recovery。参数错误 400、认证失败 403、互斥、未满足前提或事务失败 409；参数与生命周期错误返回 `{error:<稳定机器码>,stage,operationId:<UUID>,requestId?:<试播 UUID>,message:<中文提示>}`；认证拒绝仅返回权限错误码。事务异常的响应与 Companion 日志共享 operationId / requestId，底层原因经现有脱敏记录。Native 仅保留有界机器标识与 UUID，不按中文提示白名单判定，不记录任意响应正文。相同活动 begin/playing、已完成 requestId 的 complete/cancel/finish 可重试。

begin 只在原制作生命周期 preparation、无升级、无素材激活、无资料写入、OBS 已连接且未推流时接受。先 flush 正式 checkpoint，再原子写入本机资料目录的 `demo-test.json`，最后隔离输出、切换唯一 Runtime 的 session/source generation、建立无赛事 BO1 空名单临时 binding。该 binding 不写 LocalTournamentStore / Manifest LKG，临时 Runtime 不读取或写入正式系列 checkpoint。正式资料与后台平台刷新、claim、模板修改、资源激活和更新操作被隔离。

starting 丢弃 GSI；Host 确认受管 CS2 正在运行且本次播放请求已提交后调用 playing，原 production owner 进入 live。只有新鲜地图且存在 spectator allplayers coverage 的真实 GSI 才令 dataReady 为真，并自动执行一次成功的手动 Gameplay Take。试播保持 Director manual；允许现有手动场景操作（等待可随时切换，其余需 playing 和数据就绪），自动恢复操作被拒绝。空名单不伪造选手或比赛归属；没有自动名单采集承诺。

初次 Gameplay Take 的异常与失败结果记录 `initial_gameplay_take` 阶段和脱敏原因；失败后的自动尝试至少间隔 5 秒，避免随 GSI 帧重复切场和刷日志，手动场景操作仍可使用。试播临时绑定不能取得本地比赛退出资格；结束后旧正式凭证因上下文修订与 source generation 改变失效，持久恢复仍要求 Host 重新确认。

finish 在等待 OBS 之前进入 stopping 并停止 GSI；等待画面成功后清空 Core 与投影动态状态并令 production 回到 preparation。OBS 失败仍保留 stopping、正式 binding 隔离及 marker，重试 finish；等待成功前 complete 被拒绝。Host 确认受管 CS2 已退出且视频配置已恢复后调用 complete，才恢复之前正式 binding 并删除 marker。complete 后继续丢弃 GSI，下一次正常 production enter 才建立新的正式输入边界；不会自动恢复 live。cancel 仅允许未开始的 starting。正常 production finish 和 Host shutdown 也切安全画面，但保留 marker，不能替 Host 声明游戏已退出。

marker 在 Runtime / projection 组合之前同步探测。存在 marker 的重启不自动载入正式资料，不接收 GSI，phase 为 recovery。Host 先按自己的 journal 清理已知受管游戏与视频配置，再使用 GET 返回的 requestId complete。完整 marker 沿用原 ID；损坏或不可读 marker 采用本次 Companion 新 UUID 并继续隔离，Host 必须重新 GET，不能依赖旧 journal ID。recovery 的 complete 不需要 OBS 场景重试，但仍由 Host 保证游戏退出和恢复。正式状态恢复或 marker 删除失败均保留输出及输入隔离，允许重试。

公开 structured live snapshot、可靠事件和 delivery continuity 在试播期间停止生成；试播画面只使用既有本地节目投影。隔离时等待已有可靠 outbox 操作结束；已发送的正式网络请求无法撤回，新的 cloud snapshot 发送在执行时重新核对当前 session 和隔离状态。

活动试播（包括 recovery）拒绝直接停止 Companion。Host 正常退出先切安全画面、清理游戏并完成配置恢复，完成 complete 后才停止服务；EXE `--stop` 复用既有 Host 退出请求通道。外部强停或服务断线仍保留 marker 与 Host journal，重新启动后恢复。

用户诊断包保留 Native `demo_test` 的实际 phase、OS / JSON / HTTP 证据，以及 Companion 各试播阶段的异常链、operationId 和 requestId；未知合法机器码与阶段仍可导出。重复 Native 请求的聚合不把每次新的 operationId 视为新事故。

自动化证据在 `apps/companion/test/demo-test.test.ts` 与 `apps/companion/test/support-export.test.ts`，覆盖实际用户诊断包导出；Windows / CS2 / OBS 实机未验证。
