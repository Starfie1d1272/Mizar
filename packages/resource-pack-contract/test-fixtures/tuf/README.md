# 离线 Sigstore 回归证据

`targets.json`（版本 14）与精确字节的 `trusted_root.json` 来自 2026-10-09 此执行环境由真实 Sigstore SDK TUF 验证取得的公开缓存。目标的长度和 SHA 由签名的 targets metadata 绑定，targets 签名验证从 `@sigstore/tuf@5.0.0` 随包的固定 Sigstore seed（root v15）开始。测试不提供替换生产根或私钥。

证书、透明日志与实际签名使用仓库既有正式 v1.0.0 回归样例；该样例证明真实密码学和离线根验证，不冒充新资源包已签发或已完成首次安装。

三份 `first-install-*.tuf` 是 2026-10-10 从 Sigstore 公共 TUF 仓库经现有 SDK 在线校验后保存的原始 timestamp、snapshot、targets 字节。它们与已有 trusted_root.json 使用同一固定 seed；没有新签名或替换信任根。测试冻结时间在真实有效期内，并在到期边界验证首次安装拒绝与历史缓存继续可用。这是 SDK 回归材料，不是新 Core/资源已发布或真实离线安装合格的证据。
