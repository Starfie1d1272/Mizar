# ADR-0016：有界支持包

状态：Accepted（Issue #108 已定稿边界）

## 决策

- 正常「设置 → 高级 → 运行诊断 / 导出诊断包」进入现有诊断工具。用户显式导出一个 JSON 文件，含版本化 manifest、中文说明、当前安全健康摘要和日志摘要；不新增长期诊断数据库。
- Companion 是 export projector。仅接收本机、通过现有 Origin policy 的 POST；LAN 模式拒绝。浏览器通过现有 Desktop commands 读取 GSI/CS2 布尔状态，缺失或失败明确 unavailable；浏览器提供的观测标记来源，不作为 Runtime truth。
- Desktop 只承接保存：`save_support_bundle` 在原生另存为对话框选择位置，只允许固定 schema、256 KiB 以内的 JSON，不接受路径参数；取消、成功与失败分别反馈。脱敏仍由 Companion 唯一负责，Desktop 的格式检查不替代脱敏。浏览器 fallback 使用普通文件下载。
- 不压缩 `state/`，不读取 credential、GSI token、OBS password、比赛库或 capture。DebugEvidenceStore 直接产生独立摘要，不先序列化 raw/normalized/RuntimeState 再删除。
- 只读取 ADR-0015 固定四类日志的当前和最近三份历史文件；每文件最多读 64 KiB 尾部和 4 KiB 头部，最多导出 32 个事件。文件必须为普通文件，拒绝符号链接；不接受客户端路径。
- 日志按事件/字段白名单投影。未知字段、自由文本 error/detail/msg/stack、hostname、请求地址、用户路径、Steam 身份一律不导出；可保留规范时间、阶段、结果、构建摘要、数值退出码及明确数值 OS error code。未知/丢弃/截断都有计数或状态。原始错误链仍只保留在本机。
- 启动会话 ID 使用带导出随机盐的 SHA-256 生成包内关联键，既能串联 Desktop → supervisor → Companion，又不导出任意原值或跨包稳定机器标识。文件记录本次读取范围、时间范围与截断情况。总文件硬上限 256 KiB，超过则拒绝导出并提供重试提示。
- 导出不轮转、清空或修改日志，上一启动失败由 ADR-0015 保留。原生启动失败提示继续给出本机日志位置；WebView 无法启动但 Companion 正常时，可从浏览器 `/debug` 导出。服务未启动时只提供日志目录和恢复说明，不宣称 UI 导出可用。

## 验证边界

自动化覆盖敏感内容不泄漏、固定读取范围/文件名、历史失败保留、未知字段、Origin/LAN 拒绝、下载与失败重试。现有 Windows artifact/GUI CI 验证打包及正常启动；真实 Windows + CS2 + OBS 仍属于 #35。本次只交付 #108 的支持包与相关使用文档，不代表全部 RC 或实机验收完成。
