# 官方资源契约

[index.mjs](index.mjs) 与 [类型声明](index.d.mts) 是唯一的 Pack V1 解析与安全限制入口，供构建器、Store 与 Installer 复用。首版固定 `packId = official:epl-default`，声明式回放数据，不支持代码插件。

`parsePackManifest(value, { coreVersion })` 验证身份、兼容、逐文件路径/大小/摘要、原子必需文件与总字节，返回原清单；它不验签，也不赋予下载来源可信身份。消费方应使用完整的[发行验证入口](../../scripts/qualification/resource-provenance/README.md)。限制和字段以代码为唯一来源，避免在其它模块复制第二套 schema。

当前接口是原生 ESM，不需要 Core 编译或新增依赖。正式 workspace 包注册及消费方依赖接线由集成阶段完成；本分支不占用共享 package.json/lockfile。
