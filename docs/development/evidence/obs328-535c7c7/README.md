# OBS PR #328 视觉验收证据

源提交：`535c7c7ee65c4abd6c3f413c343ef3f5eb027241`。本分支只存放审查附件，不用于合并功能代码。

在该 exact head 的独立 detached worktree 运行 Chromium 用例 `OBS Program diagnostics distinguish packaging, capture evidence and an offline preparation`，结果通过。真实浏览器截图采用模拟 IPC / OBS 状态，不代表 Windows 真实 OBS / CS2 验收。截图仅含合成状态，没有支持包、凭据、私人窗口标题或用户数据。

- 折叠：1366×854，诊断默认关闭，保留目标不可选的一条操作提示。
- 展开：1366×1015，捕获来源类型中文化、显示目标/启用/活动/尺寸；不从零尺寸判定黑屏故障。

- `obs328-collapsed-535c7c7.png`：88312 bytes，SHA-256 `05f3b03edd30fc7bb69421a0284e2aeb0a57b9daf9f5a2048600d066b7d928f6`
- `obs328-expanded-535c7c7.png`：125405 bytes，SHA-256 `b444f1b0a01befe087b9b45c8426f7038dba512036afdf80dbe1a4535952f7ce`
