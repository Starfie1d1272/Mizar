# ADR-0021：地图执行开始证据与恢复重核验

状态：Accepted

## 决策

本决策澄清 ADR-0003/0011 的可靠观测：`map_started` 是在已接受遥测时产生的当前地图执行证明，不局限于首回合边沿；不新增事件、schema 或 Core state owner。

Companion 输出 owner 在 producer/session/generation/mapEpoch、比赛/context、地图绑定、当前十人身份或平台 authority 变化，以及新鲜/可信资格丢失后恢复时，重新开放一次证明机会。仅新的有效遥测触发，context refresh、认领响应、UI refresh 或旧游标不能自行提供证明。正常稳定遥测不重复发布，地图 epoch 不因补证据而变化。

开始证明成功构造并持久化入现有有界 outbox 后才标记已发布；单个待持久化证明限制连续高频帧的重复入队。旧轮次写盘晚完成不能标记新轮次，失败允许后续新帧重新构造。普通投递重试保持事件与幂等键；重新恢复使用当前更晚游标建立新键。重启连续性恢复只保留身份，不恢复“开始证明已发布”，旧开始证明不承担重新授权。

平台 authority scope 由 RivalHub adapter 提供，仅表示当前认领身份和本机认领轮次，不含凭据，也不进入 provider-neutral wire contract。

## 原因与边界

同图断流推进 source generation 而不改变 mapEpoch；按 epoch 只发一次会让接收端丢失重新核验机会。把 checkpoint 当成已发布还会使构造/入队失败或重启永久吞掉证据。

接收端继续拥有 BP、首张待进行地图、十人首发、freshness、session/authority/context/generation、人工接管和正式结果保护。采集端的新证明只允许重核验，不授权自动覆盖人工选择或终局事实，也不凭 map_ended 恢复权限。跨仓自动回归与真实 connected rehearsal 分别记录。
