# OBS 未运行时更新：Chromium 界面证据

源码：b567d3fc9fd712f3810729ecb17250505980b172。截图来自真实渲染，API/IPC 使用受控模拟；没有操作真实 Windows/OBS 或执行安装器。

OBS 状态为 unavailable，启动目标为 null；检查、下载、提交安装请求均不启动 OBS。ready 图是可更新页面；另一图的“更新未完成”是模拟 Host 故意拒绝安装请求，用于证明已进入安装接力并验证错误出口，不证明真实安装失败/成功。

- update-without-obs-ready.png SHA-256 `192922e34ab906d7197ce228fbf74e909e31ca7389556de585b706cce6e6efc4`
- update-without-obs.png SHA-256 `0cafe4d5492f3157e47a98c0aa5ef8a7ebc860211f523300ccedde3f22ac6f66`
