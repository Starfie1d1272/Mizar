# ADR-0047：CS2 安装选择、发现与故障引导

状态：Accepted（2026-10-08，用户要求统一修正安装发现、手动选择和配置冲突排查）。

## 决定

补充 ADR-0026 的安装发现：Desktop Host 管理唯一的本机安装选择，GSI 安装与受管理启动复用同一发现函数。选择通过原生文件夹或程序选择框完成，不接受网页传入任意路径。经过验证的安装根目录保存到运行数据目录的 `data/cs2-installation.json`；选择本身不安装 GSI。

自动发现读取 Steam 注册信息、主库与额外库，结构化解析 `libraryfolders.vdf` 和 AppID 730 的 `appmanifest_730.acf`，按 `installdir` 定位。旧版库元数据及已知目录名称只作为兜底；候选必须同时有 `game/bin/win64/cs2.exe` 与 `game/csgo/cfg`。按安装根目录规范化去重，同一安装的旧版 cfg 不算另一份安装。真正不同的安装不自动择一。

手动选择始终可用，接受安装根目录、game、cfg、win64 或 cs2.exe，并向上最多检查六层以确定完整安装。显式选择失效时报告问题，不静默切换到另一份游戏。没有显式选择时，已有 GSI 安装记录也是启动定位依据。更换到不同安装前必须恢复原 GSI；受管理游戏或待恢复会话阻止更改安装位置。保持既有进程身份、备份及恢复边界。

GSI 状态分别表达文件缺失／变化、重复发送地址、安装记录与文件读取失败。重复地址检测列出实际配置文件；不同地址的其他软件配置保留。读取失败不被推断成配置冲突。修复操作之后重新检查，仍有问题时不显示安装成功。界面展示具体原因、冲突文件与配置文件夹入口；安装／修复自动将同地址重复配置备份到运行数据目录并移出 CS2 加载目录。备份日志在停用前原子落盘，重试复用已有记录；恢复先校验所有备份与原路径，遇到其他软件重建或修改的文件时保留双方文件并停止，不覆盖新配置。不同地址配置共存，恢复按钮撤销自动停用；失败中断后也可恢复备份。

脚本用有限错误码传递失败；Host 根据错误码提供中文处理步骤，不转发任意 PowerShell 错误文本。最近一次 GSI 操作失败记录只保存阶段和错误码。支持包新增当前问题码、候选数、冲突文件数与最近操作阶段；继续排除完整路径、任意文件名、配置内容、原始错误和凭据。状态采集等待最多八秒，分别记录成功、失败与超时；超时或不可用时状态和数量保持未知。

## 参考与取舍

[CounterStrike2GSI](https://github.com/antonpup/CounterStrike2GSI/blob/7497fe3e04dfbc7663cf2d1e99fdc915008a7217/CounterStrike2GSI/Utils/SteamUtils.cs) 与 [steamlocate-rs](https://github.com/WilliamVenner/steamlocate-rs/blob/d740b423aee82e8e742595d0cdb4edcc91c24216/src/library.rs) 提供 AppID 与清单定位参考；[CS2 Insight Agent](https://github.com/DrEAmSs59/CS2-insight-agent/blob/f05c698c755dc7806855bb13a5c823dbf6a21de6/frontend/src/pages/SettingsPage.jsx) 提供可编辑程序路径参考。复用当前 PowerShell 发现模块，不引入新的依赖或第二套状态。

## 验证边界

独立文件系统样例验证清单、自定义安装名、额外库、新旧 cfg、手动选择持久化、失效选择与配置冲突；Web 验证可操作引导、取消选择及冲突未解决时的反馈；支持包验证结构和脱敏。真实 Windows 文件选择、Steam、CS2 与 OBS 仍需指定 RC 实测。
