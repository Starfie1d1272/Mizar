# 普通观众初始化对照

2026-10-18，固定官方 engine2.dll SHA-256 `6456df18d8f954394024c2c07da8c848df15a5ace74ce7390d78970ceb39ee21`。从 Valve 匿名内容下载取得同一 depot/manifest；本轮使用 Ghidra 12.1.4 批处理直接分析并保存项目。地址与结果摘要见 [索引](evidence/initialization-static-index.json)，原始反编译文本仅留研究环境。

## CONNECTED 必须先应答

`0x18007edd0`（CNetworkGameClientBase::Connect）建立通道后调用 SetSignonState，参数为 CONNECTED=2、spawn count=`0xffffffff`。`0x180060310` 排队发送相应 CNETMsg_SignonState。服务器 `0x1800c4a30` 在 CONNECTED 应答后才发送 ServerInfo 和初始 spawn groups。

因此等待 ServerInfo 后才允许首次 CONNECTED 应答会形成循环等待。驱动现已在连接响应后、ServerInfo 尚未到达时发送该 CONNECTED 应答；未知 spawn count 仅在这一阶段使用 `0xffffffff`，其后仍核对 ServerInfo 的真实 server_count。

可靠通道使用 tag 1、初始 tick 上下文零及 GNS flags=8。networksystem 构造路径 `0x1800bba50` 在 `0x1800bbf4b` 将 `+0x8dbc/+0x8dc0` 同时清零；`0x1800be510` 在发送前复制上下文，`0x1800be6e0` 写入可靠帧并设置 SDK flags=8。驱动测试核对在 ServerInfo 为空时已发送准确的 CONNECTED/-1 消息，NEW 尚未实现的应答仍保持关闭。

## 零 CRC 的完整表路径

`0x18005ff20` 取得本地/缓存 send-table CRC，缺少可用缓存时保留零，并发送当前 server_count、普通客户端角色及 Steam account id。`0x1800c9390` 将 ClientInfo 的 CRC 保存至连接对象。

`0x180120fa0` 只有在 CRC 非零且与本地匹配时才走复用路径；CRC 为零进入完整 send-table 发送分支，再调用 `0x1800c5fb0` 发送 sign-on 数据并推进 PRESPAWN。零值在此表示请求完整表，而不是伪造已有缓存。ClientInfo 编码默认使用零；非零值仅适用于已有匹配缓存。

## 后续顺序

`0x180061460` 在 NEW 阶段安装并调用已有字符串表回调，发送 ClientInfo，再发送 NEW 应答。服务器收到该应答后才提供下一阶段的表/sign-on 数据。初始化应按各阶段实际输入推进，完整实体快照不能无条件作为首次 CONNECTED 应答的前提。

本轮修改复用既有握手与 LiveDecoder 边界测试，27 项通过。尚需实现后续表/实体处理并完成普通观众连接；这些检查没有连接真实服务器。

## SpawnGroup manifest 与当前 Windows 构建

同一官方 engine2 的 `0x180082da0` 处理 Load、`0x180083690` 处理 ManifestUpdate；manifest 经 `0x1803f7d40` 解出资源名。外壳为 1 bit 压缩标志、24 bit 字节长度；压缩内容使用 LZSS。内层先保存三个 uint16 计数及扩展名/目录字典，随后按目录索引、名称和扩展名索引组成资源项。`resource_manifest.py` 独立实现有界格式读取；资源名仅保存在内存，不作为文件路径执行。

既有公开 Demo 的 8 个实际 SpawnGroup 包解出 47 项资源名，覆盖压缩、未压缩及空资源列表；[记录](evidence/resource-manifest-offline.json) 包含输入摘要和数量。LiveDecoder 保存各组及后续 manifest 片段。加载完成消息仍由后续世界初始化负责，不能把资源名解码当作场景已加载。

当前 SDK 桥已使用固定 Valve Proton SDK 1.65 头文件、官方 CS2 `steam_api64.dll` 的导入符号和 LLVM MinGW 交叉编译为 Windows x64 DLL，13 个当前 C ABI 导出均存在，包括启动失败码。[构建记录](evidence/windows-native-build.json) 包含工具、大小和 SHA-256；Windows 原生启动与在线持续接收尚待执行。
