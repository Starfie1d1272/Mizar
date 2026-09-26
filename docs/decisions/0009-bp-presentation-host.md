# ADR-0009：BP 全屏播出场景、本地制作与播放会话

- 状态：Accepted
- 日期：2026-09-26

## 决策

BP 是 Program presentation family 中独立的全屏不透明 `/program/bp` Browser Source，逻辑画布 1920×1080。OBS 将该地址作为完整赛前/图间场景装载；它不切换 `/program` Gameplay，也不是 HUD widget。`/operator/bp` 是来源、状态、本地填写和预览共用的工作台，预览复用同一 renderer。未来 Waiting/Result 仍是独立工作，不引入 scene engine。

本机需要看 BP 时直接打开同一地址，与 OBS 同步读取同一会话；各 Host 是否可见由窗口/OBS 控制，不增加另一份播放状态。本轮不实现私有 observer overlay 的独立 BP 开关。

Core 从已绑定 MatchContext 派生有限、Program-safe BP projection。不存在遥测时仍允许赛前播放；身份 mismatch 或 BP 事实冲突时禁止输出。参赛实体固定左 A 右 B；地图卡只显示真正执行 SIDE_PICK 的队伍和选择边，缺失 actor 时不显示选边。BO5 决胜图采用 knife round，不产生选边行；决胜图不标选图方。

Companion 独占内存 Presentation session，状态 hidden / revealing / shown / hiding，不写 RuntimeState、SeriesProgress、MatchContext 或磁盘。基于 monotonic clock，默认每 1600 ms reveal，360 ms exit；不使用客户端时钟续播。HTTP `/local/v1/bp` 仅返回有界当前 baseline，客户端串行轮询，不补离线步骤；重连/reload 首份 baseline 无入场动画。断连/超时隐藏，服务重启 hidden，比赛/BP 内容变化或 mismatch 清空会话。

`POST /operator/bp-command` 仅接受 play/hide 和预期 revision；沿用 loopback + 精确 Origin 校验，LAN 禁写。并发/旧请求返回冲突，不排队重试。只读响应采用独立版本 schema 与 ETag，不更改现有四个 snapshot channel。

## 比赛来源与本地 authoring

已绑定的 RivalHub MatchContext 是 connected 路径的唯一官方来源。本轮不创建 JSON 导入产品流程或 fixture 普通 UI，也不伪造当前 RivalHub `main` 尚未提供的 BroadcastManifest HTTP endpoint。

没有比赛 binding，或当前 BP 缺失、不完整、有冲突时，制作人员可在 `/operator/bp` 用结构化字段填写地图/选边。已有 RivalHub binding 时，比赛、赛事、队伍、赛制和队标字段锁定；LocalBpDraft 以当前 Manifest 为基线，只替换 BP 字段，保留 match/competition/entry IDs、名单、解说、比赛状态和其他赛事元数据。已完成地图行原样保留；会改变已完成地图身份、选图方或起始边的 BP 被拒绝。写入仍经过同一 validator → MatchContextController → ProjectionCoordinator → BP projection 路径，并进入同一 `match-context.json` LKG。有效 BP 已就绪时不显示本地补录入口。

当前本地比赛可编辑赛事显示名、阶段、赛制、队名与队标，但稳定保留 matchId、competitionId、entryIds、名单和解说；已完成地图行仍受保护。没有 binding 的独立填写才生成新的 match/competition/entry IDs 和空名单。不存在平行的 LocalBPState；失败时现有 binding 不变，成功时 source 切到 local 且播放 session 收起。

服务重启后，从同一 LKG 恢复比赛上下文并向普通 UI 标记为“本地缓存”；session 仍从 hidden 开始。在线 source 后续恢复时只能成为待确认候选，工作台显示赛事、阶段、赛制和双方队名，不公开内部 ID、队标或名单；制作人员显式确认后才切回 RivalHub。active selection、在线候选获取、本地保存和候选激活共享 latest-wins generation。候选激活同时校验 active context revision 与候选 revision，旧请求不得清除更新候选。JSON 和内部 revision 不进入普通工作台。
