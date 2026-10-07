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

## 来源与范围

- 截取日期：2026-10-07。五套HUD由实际OBS节目源输出，1920×1080；逐套等待界面及OBS加载后截图。
- demo由用户提供，比赛与队标核对来源：[Falcons vs. Natus Vincere / ESL Pro League Season 24](https://www.hltv.org/matches/2398745/falcons-vs-natus-vincere-esl-pro-league-season-24)。队标是赛事页面实际引用的HLTV素材，商标属于各队。
- 本地比赛资料按demo名单配置，地图顺序Inferno→Anubis→Mirage。未录入官方BP或手工补官方赛果；截图为本地回放展示，不代表官方直播。
- Steam头像使用用户授权的现有Key，由Mizar本机缓存加载；密钥与原始身份映射不入库。公开截图保留职业选手公开昵称与其实际头像。
- `provenance.json`记录具体文件、来源和校验和。其他回合、真实战术暂停、GG及赛后画面仍需补齐，不能由冻结回合图替代。
