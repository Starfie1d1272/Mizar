# rc29 本地赛事库兼容样例

`local-tournament.json` 由真实标签 `v1.0.0-rc.29`（`c0a2a99a11247636dab57dd1db169c19cd46c121`）的 `LocalTournamentStore.importLegacyMatch` 写出，不是当前 Store 模拟出的旧格式，也不含用户资料或凭据。

输入基于该标签的 `packages/protocol/test/fixtures/match-document-v1.json`，补入一位合成选手、一张已选地图及对应 BP，以及 `/room/123` 和 `https://example.com/room/456` 两个合成解说链接。旧版接受相对直播链接并原样保存；新版新输入应继续拒绝它。样例保留 rc29 写出的字段、当前选择及时间，不添加新版的回收站字段。

生成时仅将该标签的 `context.ts`、`bp.ts`、`match-result.ts`、`local-tournament-store.ts`、`durable-json.ts` 与 `serial-commit.ts` 在临时目录转译执行；没有修改其验证或持久化逻辑。提交前仅按仓库规范格式化 JSON，不改变字段和值。回归验证完整赛事库可恢复、无效可选链接停用、有效链接与其他事实保留，以及原始字节备份和失败重试。
