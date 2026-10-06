# RC 与发布流程

**先生成候选版本 RC，再把同一构建包交给 #35，在 Windows + CS2 + OBS 上实测。** RC 可以带有明确的待验收项；实机通过是正式发布的门槛，不是生成 RC 的前提。

```text
功能、默认视觉与操作说明收敛
  → 选定源码 SHA，构建并移交 RC
  → #35 Windows + CS2 + OBS 实机验收
  → 修复问题，必要时构建新 RC 并重验
  → 冻结已知限制、实机截图与发布说明
  → 最终版本、检查、构建身份与正式发布
```

总体状态由 [Release Closure #90](https://github.com/Starfie1d1272/Mizar/issues/90) 维护，现场场景、结果和证据由 [Production Acceptance #35](https://github.com/Starfie1d1272/Mizar/issues/35) 维护；不在仓库再复制一份现场报告。

## 构建 RC

- [ ] 操作入口、默认视觉、随包说明与拟发布功能一致。
- [ ] 从干净 checkout 的完整 SHA 构建，核对该 SHA 的适用 CI。
- [ ] 用 Release Qualification workflow 指定 SHA，或在 Windows x64 执行 `node scripts/qualification/build.mjs`，正式 RC 使用默认 `release` 桌面构建配置，并指定发布名称（如 `--label RC0`）。
- [ ] 包含桌面 EXE、Node、Web、脚本、配置、素材与许可；核对解压启动及适用自动化报告。
- [ ] 核对包内 `resources/metadata/artifact.json` 和 `SHA256SUMS`，核对自动生成的外层 `.zip.sha256` 与 `release-manifest.json`；ZIP 摘要与包内内容摘要含义不同。
- [ ] 在实际解压包执行 `node scripts/qualification/verify-c4-resources.mjs <bundle-root>/resources/app`，检查 C4 地图与许可完整性。

产品 ZIP 与维护者 evidence ZIP 分开交付；Windows 资格构建另生成 LZMA2 solid 自解压包，运行实际提取器到带空格的新目录，逐文件核对路径和 SHA-256，并在该提取包执行产品与 GUI smoke。`distribution-manifest.json` 记录独立下载摘要、工具和提取器身份及与原始 ZIP 的内容关系；晋级核对身份、摘要和 provenance，不重新压缩。自解压只是分发形式，不减少安装后体积或替代实机验收。公开预发布前统一 Desktop 的应用版本。用户完整解压产品 ZIP 到可写目录后运行 `Mizar.exe`。

资源校验、GUI 启动检查和合成长时测试的证明范围见[开发验证](development-validation.md#便携包自动化)。检查通过后即可作为明确标记的 RC 移交，不填写尚未进行的实机结果。

## 移交与实测

每个 RC 的记录至少包含：完整源码 SHA、包名与获取链接、ZIP 摘要、包内身份、桌面构建配置、自动化报告、已知问题和待验收范围。字段未生成就明确注明，不填推测值。

验证者在 #35 记录 Windows、WebView2、CS2、OBS 版本、分辨率/DPI/显示器、场景步骤、时间和结果。原故障机器启动复验关联 [#112](https://github.com/Starfie1d1272/Mizar/issues/112)；平台连接的适用恢复测试关联 [#121](https://github.com/Starfie1d1272/Mizar/issues/121)，不自动扩成纯独立模式的新门槛。

实测使用同一 RC，不用开发服务器或手工改过的包替代。修复或美术修改后形成新构建身份，记录差异并重验受影响场景；旧包通过不自动转移到新包。

## 截图与正式发布

- [ ] 按[截图来源与待补清单](screenshots/README.md)补 Windows 工作台、真实 CS2 与 OBS 画面；保留与 RC 的对应关系。
- [ ] 用实际验收结果完成[发布说明草案](release-notes-draft.md)，明确适用场景和已知限制。
- [ ] 核对 README、操作手册、包内说明和画面与最终交付一致。
- [ ] 统一最终应用版本，运行最终修订的适用检查，记录与已验 RC 的差异和验证关系。
- [ ] 下载链接、包身份、许可证和升级说明齐全，正式发布所需实机门槛满足后创建正式标签并发布。

当前仅有浏览器预览的截图不作为实机证据；C4 依赖版本不作为 Mizar 应用版本。用户安装与诊断操作只维护在[操作手册](quick-start.md)。

## 版本与已验产物晋级

Cargo.toml 的 package.version 是应用版本权威；Tauri config 为镜像，`app-version.mjs` 在 CI 与构建时强制核对。修改版本同时更新镜像；产品 metadata/manifest 的 appVersion 及 EXE `--app-version` 必须一致。Node runtime 版本与 Windows x64 archive SHA-256 一并固定于 qualification contract，升级时经 PR 更新。

Release Qualification 成功后使用 Release Promotion，输入成功 run ID 与精确应用版本标签。流程下载原始 product/evidence，验证 provenance、源码、ZIP、内容、EXE 版本及标签一致，创建 draft 并上传全部资产后发布。晋级不运行 build；已有不同身份的 tag/release 拒绝修改，同身份重复执行不变更。该流程同时支持 RC 和正式版本；正式发布的人工环境门槛仍需先满足。

依赖 test/tests/__tests__ 目录按名称递归删除的策略已移除，以避免破坏包入口；声明、source map、构建缓存与 runtime npm/Corepack 仍按已有明确规则裁剪。大小与启动测量随 final candidate evidence 提供，不因理论优化修改全量 hash 策略。

当前没有代码签名证书，unsigned 1.0 为明确发布例外；证书与发布主体另在 1.0.x 解决，见发布说明草案。GitHub public repository 支持 qualification provenance，验证使用 gh attestation verify；immutable release 在流程配置与实测后记录实际启用状态，不把 GitHub 支持误写成已启用。
