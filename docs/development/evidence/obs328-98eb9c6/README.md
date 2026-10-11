# OBS PR #328 复审后视觉验收证据

源提交：`98eb9c6997a04b2fffa2ea67a74261b505fe73ad`。本分支仅保存附件，不用于合并功能代码。

在该 exact head 的独立 detached worktree 运行 Chromium 用例 `OBS Program diagnostics distinguish packaging, capture evidence and an offline preparation`，结果通过，折叠与展开截图均经检查。真实浏览器渲染采用模拟 IPC / OBS 状态，不等同于 Windows 真实 OBS / CS2 验收。截图没有用户支持包、凭据、私人窗口标题或用户数据。

本次源提交只修改后台取证的独立截止期限与回归测试，UI 与前一版保持一致。正常隐藏/零尺寸不被断言为黑屏故障。

- `obs328-collapsed-98eb9c6.png`：88312 bytes，SHA-256 `05f3b03edd30fc7bb69421a0284e2aeb0a57b9daf9f5a2048600d066b7d928f6`
- `obs328-expanded-98eb9c6.png`：125405 bytes，SHA-256 `b444f1b0a01befe087b9b45c8426f7038dba512036afdf80dbe1a4535952f7ce`
