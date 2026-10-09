# 官方资源发行授权

包内清单负责逐文件完整性，包外 `mizar.resource-publication.v1` 声明绑定归档摘要、大小、版本、兼容范围、素材源码、晋级源码、发行序号与有效期。声明没有自带可替换信任根，镜像不决定 signer 或源码身份。

[verifyResourcePublication](verify.mjs) 是安装前的真实授权入口，输入：

```js
await verifyResourcePublication({
  statementPath,
  publicationBundlePath,
  archivePath,
  archiveBundlePath,
  policy: { packVersion, sourceSha, promotionSha, coreVersion, minimumSequence, now: Date.now() },
});
```

这些 policy 值必须来自受信任安装器/已认证 Core 清单或控制面；不能把未签镜像声明里的值复制成 policy。`minimumSequence` 持久保留已接受最高序号，允许同序号离线修复，拒绝回退；精确版本及两份源码固定可防止同序号替换。首次启动的受信任资源描述符和后续更新目录仍需由发行集成提供。声明过期时拒绝新安装/升级；已有核验缓存的正常启动由 Store 本地复验，不要求联网或重复验签有效期。

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
