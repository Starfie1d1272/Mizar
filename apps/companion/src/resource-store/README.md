# 官方素材缓存

`ResourceStore.open(options)` 持有独立持久目录的单个写入租约。Windows 默认目录为 `%LOCALAPPDATA%/Mizar/assets`，调用方不得把它放入 NSIS 管理的程序目录。`close()` 在没有安装或读取任务时释放租约。

Companion 的 App 在启动钩子打开唯一 Store，安装器桥通过 `app.getDecorator<() => ResourceStore | undefined>('getResourceStore')()` 获取同一实例。关闭 App 取消并等待安装后释放写入租约。状态与只读路由注册到现有 Fastify 服务，不创建监听器。

Server 使用独立持久目录，并从已通过 Core 内容身份校验的 bundle 内可选 `resource-policy.json` 读取固定策略；`coreVersion` 必须匹配当前 Core，不能用镜像 receipt 推导策略。缺少固定策略时拒绝缓存授权，保留旧 Full 随包 URL。该文件可携带经同一 Core/bootstrap 授权的 `cacheHistory`，供离线旧版恢复；未批准的历史版本不能仅凭 receipt 自报身份进入允许列表。独立素材更新的策略必须由认证的 bootstrap/catalog 提供，不能写入未签镜像字段。

原 `fixtures/epl-*` 和 `fixture-media/epl-s24` URL 在有活动缓存时通过 Store 验证读取；活动缓存的错误或缺失成员明确失败，不混入 Full 的另一个版本。没有活动缓存时继续使用原 Full 随包素材。制作中的下载只准备；激活与 production 的 enter/hide/finish/shutdown、Host 更新共用互斥区，并在提交期间阻断场景切换。

## 接入边界

- `verifyTrustedPack({packId, directory, receipt, signal, purpose})` 由官方 manifest / provenance 模块提供，返回 `TrustedPack`。`purpose` 为 `install | cache | legacy | rollback`，外部模块据此区分新安装、缓存和授权历史来源。Store 不解析另一套 manifest，不推断签发身份。适配器必须认证签发者、来源、版本及兼容性，并让可信发行声明绑定完整文件清单。镜像自带摘要不构成授权。
- `prepare({directory, signal, onProgress})` 下载并有界解包到空目录，返回可序列化 receipt；须遵守取消信号及自己的归档/网络限制。Store 不接受浏览器指定 URL 或任意本机路径。
- receipt 上限 2 MiB，和授权文件的私有副本一起持久化。**缓存命中时验证器必须离线复验 receipt 并恢复被授权清单**，不调用下载器。清单可放在 receipt 中，但必须被签名声明绑定；只签整个归档摘要而不保留可离线复验的清单证明不足以使用此适配器。版本内容目录只复制授权数据文件，未列出的归档成员不会生效。
- `activateWhenSafe(commit)` 必须在整个 commit 期间持有既有制作状态的互斥保护，返回值表示是否调用且完成 commit。直播时返回 false。缺少此接口只准备素材。不能通过先查询直播状态再异步 commit 代替制作状态锁。
- `createManifestVerifier(consumer, coreVersion)` 将外部真实 `verifyReceipt` 与 `resource-pack-contract` 的 `parsePackManifest`、`assertResourcePath`、`assertCompatibility` 对接到 Store。这里只做类型映射，外部模块仍唯一维护清单与身份规则。

## 调用接口

`list()` / `getStatus(packId)` 是唯一状态入口，阶段为 `missing | downloading | verifying | ready | failed | incompatible`。状态包含已下载字节、active / prepared / rollback 版本及受限错误码。`ready` 表示验证完成；`activeVersion` 为空时素材尚未激活。更新失败可以同时存在 `failed` 和仍可读取的 `activeVersion`。

`installVerified(packId, prepare, {packVersion?, signal?, force?})` 默认复验并复用 active；请求不同版本时必须传 `packVersion`。`repair` 强制重新准备。`cancel(packId)` 取消正在运行的安装。并发安装/删除/切换明确拒绝，不创建并行状态机。

`reuseActive(packId, createActivePolicyVerifier(currentPolicy), {signal?})` 是原生安装桥的离线重装入口。现有互斥保护覆盖当前 active 的 receipt、本次认证策略和全部文件复验，期间安装/回退不能切换身份。没有 active 返回 null；通过返回 `{status, identity: {packId, packVersion, sourceSha, promotionSha, manifestSha256}}`，没有下载器或网络调用。身份与实际字节不符明确拒绝，不能仅凭 activeVersion 相等复用。该原生回调不暴露给 renderer。

安装流程为临时目录 → 外部授权 → 逐文件尺寸/摘要校验并复制 → 对实际副本复验授权 → 同文件系统版本目录 rename → 原子持久化指针。活动版本和上一个版本保留，失败不会删除现有内容；重启清除未发布的临时目录。启动复验发现活动版本损坏时，恢复仍能通过完整复验的上一版并保留失败诊断。`activatePrepared` 在安全制作时机切换，`rollback` 经同样的外部复验和制作锁回退。历史文件保留供恢复，`removeOptional` 只允许显式配置为 optional 的素材，且须安全切换；默认 EPL 素材不可删除。

`reuseLegacy(packId, {directory, receipt}, options)` 仅复制经外部授权及逐文件校验的旧内容，不修改原随包文件。集成层提供已有 v1.1 素材的授权证据，不能用旧目录自算摘要冒充来源验证。

## 只读资源

`read(packId, relativePath, range?)` 返回独立字节快照，限定 manifest 中的相对路径及数据媒体类型。文件以只读 fd 打开；同一次读取核对完整摘要、尺寸及变化，并收集请求的 Range 字节。全部校验完成前没有响应字节离开 Store，避免验证后重新打开路径的竞态。最多八个读取、合计 128 MiB 返回缓冲区；视频 Range 仍复验完整文件，性能应在真实素材上测量。

`resolveReadOnlyPath` 仅供原生集成检查已验证路径；路径返回后仍可能被本机其它进程改动，HTTP 必须用 `read`，不能将此路径重新交给静态服务打开。

路由为 `GET /local/v1/resources`、`GET /local/v1/resources/:packId`、`GET /local/v1/resources/:packId/files/*`。只提供查询和读取；没有 renderer 下载/删除控制面。视频支持单 Range、后缀 Range、HEAD；多 Range 或越界请求返回 416。资源类型允许列表、`nosniff` 和禁止执行的 CSP 共同约束数据资源，不支持脚本、HTML 或可执行程序。SVG 必须经过外部 manifest 契约的固定路径与摘要授权；Store 不复制另一套 SVG 发布身份规则。

## 验证边界

`apps/companion/test/resource-store/store.test.ts` 使用明确标注的假授权对象验证缓存/状态与文件系统拒绝行为、取消/并发、断电残留、直播准备/回退、旧素材复制、TOCTOU 和 Fastify Range。它不证明正式签名通过。`app-integration.test.ts` 用真实 SDK 和公开 TUF snapshot 验证离线密码学拒绝且不调用网络，并验证真实 App 单例/Full 回退、异步制作互斥和原 URL 的 Range/损坏拒绝。原 URL 的活动版本正例是明确的 HTTP 授权 fixture，不是正式签名通过证据。正式签名正例仍须用真实发布包跑安装与离线重启；Windows 路径、持久目录和实机直播保护也需要真实环境证据。

跨分支接线可执行 `pnpm --filter @mizar/companion exec tsx test/resource-store/verify-real-pack.mts <Pack/Trust-checkout>`。该脚本使用实际 producer、shared parser 和运行时 SDK，把真实 EPL 的未签反例送入 Store；必须到达 bundle/签名拒绝才通过，TUF 网络初始化失败明确不能冒充密码学拒绝。它不声明新资源包的正式签发成功，也不代替签名 receipt 的离线缓存验证。
