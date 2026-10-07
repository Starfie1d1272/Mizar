# Windows 真实 demo 图集

本目录使用未经修改的最终 [RC22](https://github.com/Starfie1d1272/Mizar/releases/tag/v1.0.0-rc.22)、真实 CS2 demo 与实际 OBS 输出。源码 `6e84cd2eaa027ae322ad486b6b2ab31e18e2d486`；包身份、验收结果与未完成项由 [#35](https://github.com/Starfie1d1272/Mizar/issues/35) 维护。

## 五套 HUD

以下画面来自同一个 Inferno 冻结回合，比分 Falcons 0:3 Natus Vincere；截图期间暂停 demo 播放以比较版式，不表示比赛战术暂停。全部使用 demo 原始选手身份与实际 Steam 头像，未用选手照片替代 Steam 头像。控制台及底部 demo 进度条已隐藏，像素没有重绘或拼接。

![Mizar Pulse](hud-default-epl-inferno-freeze.png)

![EWC](hud-ewc-epl-inferno-freeze.png)

![IEM](hud-iem-epl-inferno-freeze.png)

![Perfect World](hud-perfectworld-epl-inferno-freeze.png)

![ESL](hud-esl-epl-inferno-freeze.png)

## 完整工作区

![Windows 完整工作区](workspace-epl-inferno-freeze.png)

工作区为实际2560×1440物理屏幕、150%缩放，通过临时OBS显示器捕获保存；包含游戏、本机HUD、大雷达、制作控制与OBS画面确认。任务栏隐藏，左栏贴底，三个区域之间没有白色缝隙。未推流、未录制，不证明公网观众端音画质量。

## 战术暂停与赛后

![Falcons 真实战术暂停](default-epl-inferno-timeout.png)

暂停来自demo中CT暂停字段明确激活的tick44700附近，显示Falcons暂停、比分1:4和剩余约29秒；实际暂停身份与倒计时来自游戏，截图时停止回放以固定构图。

![真实末局 GG](default-epl-inferno-gg.png)

![单图结果](epl-inferno-map-result.png)

末局从tick191000附近跳转后以1x自然播放，自动GG后切到单图结果，比分13:6、系列1:0。该片段用来拍摄场景，不是全图统计验收；没有把中途接入的伤害统计称作完整地图ADR。

## 来源与范围

2026-10-07 已从[赛事页面](https://www.hltv.org/events/8244/esl-pro-league-season-24)与比赛页面核对并保存真实赛事名称、EPL Logo、瑞士轮第4轮（2–1组）、晋级说明与完整7步禁选。按用户提供的EPL规则补充对手选边：Inferno由Falcons选CT，Anubis由NAVI选T；共9步，Mirage决胜图拼刀，不预填选边或开局阵营。实际demo开局另行记录，不能把实际开局冒充赛前选边。具体来源、RC22编辑器限制和核验范围见[赛事资料](epl-source.json)。上述九张截图仍为此前配置，尚待重拍，不能据此宣称图中已使用新资料。

- 截取日期：2026-10-07。五套HUD由实际OBS节目源输出，1920×1080；逐套等待界面及OBS加载后截图。
- demo由用户提供，比赛与队标核对来源：[Falcons vs. Natus Vincere / ESL Pro League Season 24](https://www.hltv.org/matches/2398745/falcons-vs-natus-vincere-esl-pro-league-season-24)。队标是赛事页面实际引用的HLTV素材，商标属于各队。
- 本地比赛资料按demo名单配置，地图顺序Inferno→Anubis→Mirage。未录入官方BP或手工补官方赛果；截图为本地回放展示，不代表官方直播。
- Steam头像使用用户授权的现有Key，由Mizar本机缓存加载；密钥与原始身份映射不入库。公开截图保留职业选手公开昵称与其实际头像。
- `provenance.json`记录具体文件、来源和校验和。冻结、真实战术暂停、GG、单图结果与工作区分别记录，不能把选景截图代替完整多图及长时验收。
