# RC 与发布检查清单

本清单用于把一个确定版本交给真实 Windows + CS2 + OBS 验收。操作说明见 [快速开始](quick-start.md)，验证模型见 [开发验证](development-validation.md)。当前代码完成、某次 CI 成功、资源自洽和实机 PASS 是不同证据，不能相互替代。

## 候选版本的准备顺序

1. 完成拟发布的功能、美术与必要操作文档，合入候选主线。
2. 从确定的完整 git SHA 构建 exact RC，核对该版本所需 CI 与资源证据。
3. 用同一包完成真实 Windows + CS2 + OBS 验收，发现问题后修复并重验受影响场景。
4. 根据实际结果冻结 README、已知限制和发布说明，再按发布流程统一版本、运行最终 CI、生成发布包与 tag。

文档初稿可以先完成。默认 HUD 或节目场景重绘后，先同步预览图、默认外观描述和实际改变的按钮／行为，再生成最终候选包。美术变更也需要检查 1080p / 1440p、OBS Browser Source、真实回放、长文本、缺失媒体、暂停、换边、C4、减少动效和场景转场；保留共享数据边界与预设保存／启用语义。

若已做过 RC 验收，后续重绘产生的新包须记录与前一包的差异，并重验相关画面与流程；不能把旧包 PASS 直接记到新 revision 上。

## 构建与资源核对

- [ ] 从干净 checkout 的完整 SHA 构建，不使用 dirty 包或只做结构检查的包。
- [ ] 核对该 SHA 的 CI 运行链接、各必要检查与结果；PR 的选择性 CI 不一定生成 Windows 包。
- [ ] 通过现有 Release Qualification workflow 指定完整 SHA，或在 Windows x64 干净 checkout 使用 `node scripts/qualification/build.mjs`；正式候选使用默认 `release` desktop profile。
- [ ] 核对 `resources/metadata/artifact.json`、`resources/metadata/SHA256SUMS` 和产品运行诊断中的版本身份与摘要；记录 ZIP 文件 SHA-256，并明确它与包内内容摘要不同。
- [ ] 包含 `Mizar.exe`、bundled Node、Web、脚本与配置；从含空格的可写路径干净解压和启动。
- [ ] 确认十张 C4 数值地图和上游 `LICENSE`、`NOTICE`、`CREDITS.md` 随实际包交付；核对 [第三方说明](../THIRD-PARTY-NOTICES.md)。
- [ ] 复用现有验证器在**实际解压包**上执行：`node scripts/qualification/verify-c4-resources.mjs <bundle-root>/resources/app`。它需要仓库验证脚本和可用 Node，属于构建／验收人员步骤，不要求普通使用者执行。
- [ ] 核对 portable smoke、GUI cold-start 与合成 soak 的证据。它们各有用途，均不表示真实 CS2 / OBS 已通过。

安装到开发 checkout 后执行验证器，只证明开发依赖可加载。十图校验也不证明真实伤害精度、全部地图 positive path 或未来 CS2 build 兼容。

## 交给实机验证者

用下表记录每次 RC；无法获得的字段填「待生成」或「不可用及原因」，不填写推测值。

| 信息       | 记录内容                                                              |
| ---------- | --------------------------------------------------------------------- |
| 候选身份   | 完整 git SHA、包内 app/runtime 版本、desktop build profile            |
| 包身份     | 文件名、下载／CI 链接、ZIP SHA-256、包内 artifact 摘要                |
| 自动化证据 | 对应 SHA 的 CI、portable/GUI smoke、资源验证与合成 soak 报告          |
| 实机环境   | Windows、WebView2、CS2 build、OBS 版本、分辨率、DPI、显示器和输入方式 |
| 验收范围   | 独立模式必验；连接模式适用时另记接管／恢复及云端链路                  |
| 限制       | 尚未完成场景、已知问题及其 issue；PASS / FAIL / INCONCLUSIVE 分开     |
| 结果       | 场景步骤、发生时间、报告路径／完整性哈希、脱敏诊断包及复现说明        |

实机验证至少覆盖：

- [ ] 原故障 Windows 机器与正常机器的完整桌面 cold start；不能仅用 HTTP health 判断桌面就绪。
- [ ] 准备中心 → 比赛 → GSI → OBS → 预览 → 进入现场 → 隐藏／恢复 → 结束制作 → 完整退出。
- [ ] 真实 10 人 HUD、雷达、换边／换图、暂停／回合历史；默认与拟发布赛事预设的可读性、保存／启用／重载。
- [ ] `.mizar-hud.json` 导入生成副本、导入不改变节目、启用与无效文件恢复。
- [ ] C4 在至少一张支持地图的正向展示、开关持久化、最后十秒窗口，以及数据／地图／资源不可用的隐藏；记录所用 CS2 build，真实 HP 保持不变。
- [ ] 自动节目流程、手动接管／恢复、OBS 失败后的恢复、BP 播放与收起。
- [ ] Browser Source reload、Companion restart、CS2 restart、接近比赛时长的真实 soak，且 Workspace／Assist 私有信息不进入节目。
- [ ] 原生诊断另存为、取消／失败重试、浏览器备用下载和启动失败日志路径。

最终真实验收范围与判定由 [Production Acceptance #35](https://github.com/Starfie1d1272/Mizar/issues/35) 管理，原机启动复验关联 [#112](https://github.com/Starfie1d1272/Mizar/issues/112)。不在这里建立第二份现场报告体系。RivalHub 连接恢复的适用缺口另见 [#121](https://github.com/Starfie1d1272/Mizar/issues/121)。

## 发布前冻结

- [ ] 按实测结果完成 [发布说明草案](release-notes-draft.md)，列出限制和恢复步骤；功能表述与最终包一致。
- [ ] README、快速开始、包内 README、按钮、默认外观与最终截图一致。
- [ ] 审查自定义预设和旧 state 的适用格式，不承诺未实现的升级迁移；保留旧包和数据备份作为恢复资料。
- [ ] 通过适用实机验收后统一最终 app 版本，运行最终 revision 的 CI 并记录与已验收 RC 的对应关系；不能把依赖 `cs2-c4-damage@0.1.0` 当作 Mizar app 版本。
- [ ] 最终包名、完整 SHA、摘要、许可证和下载链接就绪后才创建正式 tag／发布。

最终版本、tag 与发布由 [Release Closure #90](https://github.com/Starfie1d1272/Mizar/issues/90) 统一追踪。操作文档可以先移交；真实验收与最终发布文案须继续更新到实际交付状态。
