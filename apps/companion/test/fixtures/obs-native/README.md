# OBS 原生日志格式回归来源

2026-10-11 核对官方 OBS 30.2.3、31.1.2、当前稳定版 32.2.2，以及 master `7d98bebe1115b12608837b622164ea5fe6d9483a`。这是日志兼容核对范围，不声明 Mizar 已完成这些版本的 Windows 实机验收。

- [32.2.2 game-capture.c](https://github.com/obsproject/obs-studio/blob/32.2.2/plugins/win-capture/game-capture.c)，[30.2.3](https://github.com/obsproject/obs-studio/blob/30.2.3/plugins/win-capture/game-capture.c)，[31.1.2](https://github.com/obsproject/obs-studio/blob/31.1.2/plugins/win-capture/game-capture.c)，[固定 master](https://github.com/obsproject/obs-studio/blob/7d98bebe1115b12608837b622164ea5fe6d9483a/plugins/win-capture/game-capture.c)。`game-capture.json` 覆盖这四份源码中的 32 条失败 warning 格式与无冒号的 `init_capture_data failed` debug；helper 退出与 DLL/plugin hook 版本不兼容必须保留。强制共享内存模式的 warning 是配置提示，不判失败；窗口消失是停止，hook 尚未加载是重试。
- [32.2.2 d3d11-subsystem.cpp](https://github.com/obsproject/obs-studio/blob/32.2.2/libobs-d3d11/d3d11-subsystem.cpp)，[30.2.3](https://github.com/obsproject/obs-studio/blob/30.2.3/libobs-d3d11/d3d11-subsystem.cpp)，[31.1.2](https://github.com/obsproject/obs-studio/blob/31.1.2/libobs-d3d11/d3d11-subsystem.cpp)，[固定 master](https://github.com/obsproject/obs-studio/blob/7d98bebe1115b12608837b622164ea5fe6d9483a/libobs-d3d11/d3d11-subsystem.cpp)。`d3d11.json` 是四份源码所有 `LOG_ERROR` 调用的 48 种去重输出格式，包括 GDI helper 的两个实际调用者、shader/texture/swapchain/shared-handle/vertexbuffer/Device Removed 分支。动态错误参数用合成路径、文本和 HRESULT 替换；多行 shader 错误只取分类首行，不导出 shader 正文。
- [32.2.2 obs-main.cpp](https://github.com/obsproject/obs-studio/blob/32.2.2/frontend/obs-main.cpp#L1066-L1070) 明确支持 `portable_mode`、`obs_portable_mode`、`portable_mode.txt`、`obs_portable_mode.txt` 四种存在性标记。

Fixture 是静态、独立预期，维护时对照上游日志调用，不由生产 parser 生成。只用合成值，无用户原生日志或真实凭据；分类表示记录到的技术事件，不证明当前帧正常或黑屏根因。
