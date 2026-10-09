# 离线 Sigstore 回归证据

`targets.json`（版本 14）与精确字节的 `trusted_root.json` 来自 2026-10-09 此执行环境由真实 Sigstore SDK TUF 验证取得的公开缓存。目标的长度和 SHA 由签名的 targets metadata 绑定，targets 签名验证从 `@sigstore/tuf@5.0.0` 随包的固定 Sigstore seed（root v15）开始。测试不提供替换生产根或私钥。

证书、透明日志与实际签名使用仓库既有正式 v1.0.0 回归样例；该样例证明真实密码学和离线根验证，不冒充新资源包已签发或已完成首次安装。
