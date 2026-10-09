# 更新来源验证样例

`distribution-manifest.json` 与 `distribution.attestation.json` 来自 Mizar 正式 [v1.0.0](https://github.com/Starfie1d1272/Mizar/releases/tag/v1.0.0)，源码为 `e46dcf7ff5bf01703da2ee40491f503d1fc4d76b`，清单 SHA-256 为 `a2f5d3cdc2d6c7921aa54071f67ed687f48cbce5f3f96c394aec41dabd1587bc`。

`trusted_root.json` 为 Sigstore 公开信任材料，2026-10-09 经客户端 TUF 验证取得。离线测试使用固定真实证据验证签名、证书身份、透明日志和篡改拒绝；生产仍通过 Sigstore 的 TUF 根更新信任材料，不使用这些测试文件，也不绕过 TUF 刷新。
