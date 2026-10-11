# OBS PR #328 最终横幅条件验收

源提交：`52ddc95120ac5fd324cb11caf459ab7b1dcc0802`。本分支仅保存审查附件，不用于合并功能代码。

该 exact head 在独立工作树重跑 Chromium 用例通过，真实浏览器渲染采用模拟 IPC / OBS，不等同于 Windows 实机采集。节目或捕获有主要提示时隐藏绿色配置成功横幅；无异常时原提示恢复。回归覆盖目标不可选、恢复、折叠、展开与无横向溢出。截图不包含用户支持包、凭据或用户数据。

- `obs328-collapsed-52ddc95.png`：83264 bytes，SHA-256 `e9e2eece8c922ed078e9e5223c4edad7c1a08c57986da5da2cd57f088bcf3e4f`
- `obs328-expanded-52ddc95.png`：119855 bytes，SHA-256 `2d410832364bc2721ff491e54119d1931a79cf331f8fad9db29e52a901423d36`
