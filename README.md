<p align="center">
  <img src="apps/web/public/brand/mizar-app-icon.svg" width="112" height="112" alt="Mizar 标志" />
</p>
<h1 align="center">Mizar</h1>
<p align="center"><strong>让校园赛事，也有职业赛场的转播呈现。</strong></p>

<p align="center">
  <a href="https://github.com/Starfie1d1272/Mizar/actions/workflows/ci.yml"><img src="https://github.com/Starfie1d1272/Mizar/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI 检查状态" /></a>
  <a href="docs/quick-start.md"><img src="https://img.shields.io/badge/Windows-0078D4" alt="桌面平台：Windows" /></a>
  <a href="https://github.com/Starfie1d1272/Mizar/releases"><img src="https://img.shields.io/badge/Preview-E9A23B" alt="版本状态：开发预览" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--only-2563EB" alt="许可证：AGPL-3.0-only" /></a>
</p>

<p align="center">
  <a href="https://box.nju.edu.cn/d/7e069258cb8045a1a5c7/">下载 Windows 完整包</a> ·
  <a href="docs/quick-start.md">开始使用</a> ·
  <a href="docs/screenshots/README.md">画面预览</a> ·
  <a href="docs/README.md">使用文档</a> ·
  <a href="CONTRIBUTING.md">参与开发</a>
</p>

**[下载 Windows 完整包（南大云盘）](https://box.nju.edu.cn/d/7e069258cb8045a1a5c7/)** · [GitHub 备用下载与发布说明](https://github.com/Starfie1d1272/Mizar/releases)

当前推荐 RC10 开发预览版，约 46.81 MB。运行下载的自解压包，选择新的可写目录，再打开目录内的 `Mizar.exe`；完整操作见[快速开始](docs/quick-start.md)。

Mizar 是为校园与社区 CS2 赛事打造的开源制播系统。从赛前介绍到赛后定格，让比赛拥有连贯的节目流程、统一的视觉包装，以及解说和导播随手可用的现场工具。

![Mizar Pulse 半场数据画面](docs/screenshots/halftime.png)

_浏览器示例画面，更多截图与来源见[画面预览](docs/screenshots/README.md)。_

## 比赛进行到哪里，节目就呈现到哪里

赛前等待、BP 展示、对阵开场、局内 HUD、半场数据、赛后结果——Mizar 通过 GSI 读取游戏进展，结合赛事资料自动推进节目、切换 OBS 场景。少一些重复操作，多一些精力留给比赛。

需要临场调整时，随时手动接管；由你决定何时恢复自动。

## 看清比赛，也掌握播出

在 Windows 制播工作台里，同时查看真实 CS2 画面、大雷达和比赛资料。解说更容易掌握全局，导播也能通过 OBS 定期画面预览、推流状态和 B 站开播状态确认现场情况。

## 从第一张画面到最后一个比分，风格连贯

默认的 **Mizar Pulse** 包装贯穿赛前、局内和赛后，另有四套参考 EWC、IEM、Perfect World、ESL 赛事视觉的 HUD 风格。

调整组件、布局与外观，预览满意后再用于播出；也可以分享预设，让下一场赛事沿用熟悉的风格。

## 本地就能办赛，连接网站还能做更多

直接在本机创建比赛，无需依赖赛事网站。接入 **RivalHub** 后，可以复用队伍、赛程与 BP 资料，并将局内实时状态与雷达提供给网站展示；其他赛事平台也可通过公开接口适配。

从 RivalHub 的赛事运营，到 Mizar 的现场制播，再到 [DAK](https://github.com/Starfie1d1272/cs2-demo-analysis-kit) 的赛后分析，让一场比赛的台前幕后相互连接。

## 让现场操作更从容

HUD、雷达与节目使用同一份比赛信息，减少重复录入；编辑与预览独立于正式播出，调整画面时更安心。连接中断后尝试恢复当前状态，缺少数据时明确提示，帮助制作人员判断下一步。

准备开始？查看[快速开始](docs/quick-start.md)，了解环境要求与第一场比赛的设置。适用范围见[产品说明](docs/product.md)，后续计划见[路线图](docs/roadmap.md)。

## 开源与致谢

Mizar 使用 [AGPL-3.0-only](LICENSE) 许可证，欢迎试用、[反馈问题](https://github.com/Starfie1d1272/Mizar/issues)和[参与开发](CONTRIBUTING.md)。

感谢开源社区的 HUD、雷达与制播实践；CS2 资源处理使用 [ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat)。项目与相关赛事品牌无隶属或背书关系。依赖、字体和素材权利见[第三方说明](THIRD-PARTY-NOTICES.md)，研究来源见[参考项目](docs/references.md)。
