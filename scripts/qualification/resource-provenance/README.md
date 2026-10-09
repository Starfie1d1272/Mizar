# 官方资源发行授权

包内清单负责逐文件完整性，包外 `mizar.resource-publication.v1` 声明绑定归档摘要、大小、版本、兼容范围、素材源码、晋级源码、发行序号与有效期。声明没有自带可替换信任根，镜像不决定 signer 或源码身份。

[verifyResourcePublication](verify.mjs) 是发行侧 CLI 的真实授权入口，输入：

```js
await verifyResourcePublication({
  statementPath,
  publicationBundlePath,
  archivePath,
  archiveBundlePath,
  policy: { packVersion, sourceSha, promotionSha, coreVersion, minimumSequence, now: Date.now() },
});
```

这些 policy 值必须来自受信任安装器/已认证 Core 清单或控制面；不能把未签镜像声明里的值复制成 policy。安装阶段的 `minimumSequence` 持久保留已接受最高序号，允许同序号修复，拒绝降序安装；精确版本及两份源码固定可防止同序号替换。首次启动的受信任资源描述符和后续更新目录仍需由发行集成提供。声明过期时拒绝新安装/升级；已有核验缓存的正常启动与已管理版本回退使用下述离线 receipt 入口。

返回 `{ statement, manifest, manifestSha256, archive, entries }`。`entries` 是被内容与来源校验实际冻结的字节；消费方安装这些字节，不重新打开原下载路径，避免校验与使用间替换。输入有字节上限，全部复制到私有临时目录后执行现有 `releaseAttestationArgs`，不允许注入假可信验证器：

- 归档证明：`release-qualification.yml@refs/heads/main`，`source-ref = refs/heads/main`，`source-digest = sourceSha`。
- 发行声明证明：`release-promotion.yml@refs/heads/main`，`source-ref = refs/heads/main`，`source-digest = promotionSha`。

两步实际调用 `gh attestation verify`，复用现有 GitHub/Sigstore 根、SLSA 默认判定及既有 signer@main。不新增密钥，不读取 Box 凭据，不把资格签名独自当成发行授权。资源 `packVersion` 可与 Core 版本不同，素材源码与后来批准它的晋级源码分别绑定。

```sh
node scripts/qualification/resource-provenance/verify.mjs \
  resource-publication.json publication-provenance.json \
  Mizar-official-epl-default-1.0.0.zip pack-provenance.json trusted-policy.json
```

CLI 总是使用当前系统时间；需支持 `gh attestation verify` 的 GitHub CLI。本地旧 CLI、离线信任根不可用或无有效证明时失败关闭，不把工具缺失当授权成功。

[create.mjs](create.mjs) 提供晋级方声明构造命令，严格要求既有 main 晋级环境及精确 checkout，先核验归档资格证明和源 SHA 的完整 CI。参数文件仅包含 `sequence`、`issuedAt`、`expiresAt`（UTC 秒精度，最长 366 天）。输出仍未签，发行集成必须以既有晋级工作流 attestation 签发，并随原始归档、两份证明公开。`makePublication` 是未签声明构造辅助函数，绝不返回可信授权。

```sh
node scripts/qualification/resource-provenance/create.mjs \
  pack.zip pack-provenance.json publication-parameters.json resource-publication.json
```

本模块不改 CI/Release 工作流，不签发生产资产，不改 Stable/Box。现有工作流尚未调用资源 producer 或签发声明，因此本地生成包不能宣称真实发行已完成。Store/Installer 接线、受信任描述符的发布与下载域/重定向限制由对应模块和父会话统一落实。完整性测试使用真实 EPL；安全测试中的自制声明与无签名证明必须在真实 gh 校验中拒绝，测试不伪造有效生产签名。

## 无外部 CLI 的运行时入口

Store 使用 `@mizar/resource-pack-contract/runtime` 的 `verifyResourcePublicationBytes`，传入同一策略、应用持有的持久 `tufCachePath` 和四份下载字节：`statementBytes`、`publicationBundleBytes`、`archiveBytes`、`archiveBundleBytes`，可另传 `signal`。返回 CLI 的内容与授权结果，以及下述持久化 `receipt`。输入在 await 前冻结，双证据始终经过 Sigstore 真实签名、证书 issuer、固定 main signer、CT 与 tlog 门槛，再核对 SLSA subject、main ref 和精确源码。生产入口不接受外部 verifier，不运行子进程或依赖用户安装 `gh`。

正式 v1.0.0 的现有签名与公开根样例独立验证真实密码学成功和反例；它们不冒充新资源包的已签发行声明。新资源的完整签发与首次安装仍须父会话集成。`attestation` 子入口提供与现有 `StableSource` 相同的证据判定，便于父会话将既有更新入口提取共用；当前本分支不越界修改 Companion。

证书的来源仓库、SHA 和 main ref 通过 Sigstore `certificateOIDs` 绑定，同时核对签名的 SLSA 源码依赖。通用 OID 的短 DER UTF8String 编码依据 [Fulcio 规范](https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md)。Sigstore 5 的 signer identity 选项按正则处理，因此资源入口将固定 URI 转义并加首尾锚点，避免相似 URI 或 main 后缀被接受。既有更新入口后续共用该策略时可同步获得此精确匹配约束。

## Store 的离线 receipt 接线

`verifyResourcePublicationBytes` 在新安装阶段返回额外的 `receipt`，并要求应用持有的持久 `tufCachePath`。receipt 的 JSON 总字节数限制为 2 MiB，包含原始 manifest、发行声明、两份签名证明，以及可独立认证的 Sigstore TUF 公开证据；不包含 ZIP。激活前会先真正执行离线 receipt 验签，无法保留有效离线证据时安装失败并保留旧版本。

Store 将 `.receipt` 原样持久化，并让 `createManifestVerifier` 的外部消费者调用：

```js
verifyReceipt: ({ receipt, purpose, signal }) =>
  verifyResourceReceipt({
    receipt,
    policy: trustedPolicyForThisVersion,
    purpose,
    tufCachePath: applicationTrustCache,
    signal,
  });
```

入口位于 `@mizar/resource-pack-contract/runtime`。返回已授权 manifest；如果 Store 单独保存原始 manifest 文件，可另传 `manifestBytes: Buffer`，它仍必须等于签名声明的 `manifestSha256`。省略时使用 receipt 内的原始 manifest 字节。不要通过重新序列化 manifest 重建已签字节。Store 随后继续按返回的 `files` 逐文件核对本地大小与 SHA；receipt 不替代实际文件复验，也没有任何 `trusted: true` 或未签自报 hash 的授权捷径。授权文件应作为 Store 私有元数据保存，不暴露为任意本机读路径。

`purpose` 必须由 Store 调用路径决定，不能读取镜像/receipt 的自报字段：

- `install`、`legacy`：当前有效期、已接受序号、身份、Core 兼容与双签名仍必需；刷新当前 Sigstore TUF 根，网络失败关闭。升级同属 `install`，旧随包素材首次迁移同属 `legacy`，不能冒充缓存。
- `cache`、`rollback`：只用于已管理版本目录的启动/完整回退，不重新下载 ZIP或初始化在线 SDK。历史发行声明到期和高于旧版的最新序号不撤销已有数据；仍检查精确版本/源码/签发身份、当前 Core 兼容、未来 issuedAt、声明内部合法有效期、双签名、manifest 绑定和随后 Store 的真实文件摘要。

policy 的版本身份来自先前已认证的版本描述符/可信目录；最低序号和当前 Core 版本来自应用控制面。不要从未签 receipt 的自报字段获得新安装授权，也不要让外部请求选择 `cache` 用途。

离线根材料认证从 `@sigstore/tuf@5.0.0` 随包的固定 Sigstore seed 开始；receipt 携带连续、双重签名的 TUF root 轮换链和 root 授权的 targets 签名，后者绑定精确 `trusted_root.json` 长度与摘要。没有可替换根、镜像 URL 或 keySelector 输入。公开证据在首次在线核验后捕获并持久化；安装时最多捕获 32 次连续根轮换，超过范围应更新受信任 Core/Sigstore 基线后重新资格确认。缓存验证将它作为历史签名证据使用，不借元数据到期回退联网；新安装仍执行在线 freshness。

SDK 的 `tufForceCache` 在损坏/到期时仍会回退网络，所以本入口不以该名称冒充离线保证。实际离线测试禁止 fetch，并把日期推进到 2040 年，仍可核验现有真实 Release 的签名、CT/tlog 与证书/source，且篡改根证据、target 或 subject 拒绝。该既有样例不代表新的 EPL 资源发行声明已生产签发；新包的完整安装/断网重启正例仍需父会话签发和 Store 接线验收。
