# ADR-0024：OBS 独立进程与桌面启动职责

状态：Accepted

## 背景

Companion 启动 OBS 时，OBS 会继承 Windows Runtime Job。退出 Mizar 的受控清理可能连带终止 OBS，下一次启动出现未正确关闭提示。OBS 是独立制作软件，不属于服务回滚的所有进程。

## 决策

Companion 继续唯一管理 OBS 路径配置、发现、连接和场景控制。受本地 Origin 保护的操作接口仅解析启动目标，不返回密码。桌面界面将目标交给 Runtime Job 外的 Host 启动；Host 仅允许绝对路径的现有 obs64.exe，不接受任意命令或启动参数，使用程序目录作为工作目录。浏览器操作保留既有 Companion 启动入口。

Runtime Job 的归属、回滚与关闭规则不放宽，OBS 生命周期独立于 Mizar。原生验收检查通过产品按钮启动 OBS 后，退出 Mizar 不终止 OBS；连接和实际捕获分别验证。
