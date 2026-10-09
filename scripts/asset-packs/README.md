# 官方 EPL 数据包

本模块独立读取现有默认 EPL 素材，不编译 Core、不修改旧随包内容。包内 `pack-manifest.json` 的解析入口是 [resource-pack-contract](../../packages/resource-pack-contract/index.mjs)，唯一格式为本工具输出的确定性 ZIP32。ZIP 使用固定时间、普通文件、无扩展字段；JSON 数据使用 DEFLATE，已压缩的视频和图片直接存储。解包器拒绝其它 ZIP 变体、符号链接、目录、名称冲突、越界与过量解压。

```sh
node scripts/asset-packs/cli.mjs build /tmp/epl-pack 1.0.0
node scripts/asset-packs/cli.mjs verify /tmp/epl-pack/Mizar-official-epl-default-1.0.0.zip 1.1.0
```

构建要求素材来源已提交，来源 SHA 等于 checkout。相同输入、版本及 Node/zlib 工具链产生相同归档字节。升级工具链后必须重新记录实际摘要，不能假设不同压缩库输出相同。输出目录包含归档、内置清单的副本与大小/真实耗时报告；均不是签发证据。禁止在归档内部放置归档自身摘要。

`verifyPackBytes(Buffer, { coreVersion, expectedArchive })` 返回 `{ manifest, manifestSha256, archive: { format, bytes, sha256 }, entries: Map<path, Buffer> }`，证明内容完整性与原子同步绑定。需要来源授权的消费方调用 [verifyResourcePublication](../qualification/resource-provenance/verify.mjs)，不能把本函数返回结果直接标记为可信。

路径与旧 Web URL 一致：`fixtures/epl-inferno-{video,opening,final-round}/…`、`fixture-media/epl-s24/…`；来源说明在 `provenance/`。Store 可将核验后的 `entries` 写入隔离 staging，再原子激活；HTTP 层仅允许 manifest 中的只读路径。归档解析不直接写入本机路径。版本目录、安全生效时机、取消与回滚由 Store 拥有，本模块不创建第二套缓存状态。

首版包含三个同步回放、默认视频、十个视频头像、十二个比赛展示资产和现有来源说明。保留源文件原位。仅固定摘要的已有 NAVI SVG 可进入数据包，其余 SVG、JS、HTML、EXE 等主动或可执行资源拒绝；读取方仍应为数据与图片设置准确 Content-Type 和 `nosniff`，不把 JSON 当脚本执行。

EPL 视频、Steam 头像与队伍标识的来源说明不构成新的再分发许可。现有来源没有明确授权新公开 CDN 再分发；本模块只生成本地验收产物，公开分发前由发布负责人核对许可，不修改权利归属。
