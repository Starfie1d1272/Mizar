# 官方资源契约

[index.mjs](index.mjs) 与 [类型声明](index.d.mts) 是唯一的 Pack V1 解析与安全限制入口，供构建器、Store 与 Installer 复用。首版固定 `packId = official:epl-default`，声明式回放数据，不支持代码插件。

`parsePackManifest(value, { coreVersion })` 验证身份、兼容、逐文件路径/大小/摘要、原子必需文件与总字节，返回原清单；它不验签，也不赋予下载来源可信身份。消费方应使用完整的[发行验证入口](../../scripts/qualification/resource-provenance/README.md)。限制和字段以代码为唯一来源，避免在其它模块复制第二套 schema。

包的公开入口由 workspace 构建生成 `dist/*.js` 与声明文件，不深层导入源码：

- `@mizar/resource-pack-contract`：纯数据 schema 与路径/兼容契约。
- `@mizar/resource-pack-contract/content`：归档与原子内容验证。
- `@mizar/resource-pack-contract/runtime`：无需外部 `gh` 的真实 Sigstore 发行授权。
- `@mizar/resource-pack-contract/attestation`：固定 Mizar signer 策略与已配置验签器的公共证据判定，供现有 StableSource 后续提取复用。

运行时与既有 Companion 使用同一精确版本的 Sigstore 与相同公开 TUF 根。当前没有修改 Companion；其原有验签入口的提取/接线由父会话协调，不能让 Store 复制另一份资源 schema。构建脚本只将原生 ESM 与手写公开声明转换为仓库规定的 dist 扩展名，不编译 Core，也不产生资源副本。

`runtime` 还导出 `verifyResourceReceipt`，供无 ZIP 的缓存启动/回退。原安装结果 `.receipt` 保存签名声明、原始 manifest、双证明和从固定 Sigstore seed 认证的离线证据；没有自报可信字段。缓存用途绝不联网，首次安装/升级用途保持当前授权有效期和防重放门禁。具体接线与材料持久化见[发行授权](../../scripts/qualification/resource-provenance/README.md#store-的离线-receipt-接线)。
