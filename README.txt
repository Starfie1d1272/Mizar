Mizar 2026-10-17 分支与实验归档

这是 Git 历史归档，不是正式发行，不改变已有版本标签或 Release。
main、Draft #246 和 #367 保持原样。#169 订阅优化与 Pulse 阶段标题预览只是暂停保存，未完成、未合并。

22 个归档标签：archive/2026-10-17/<原分支名称>；全部固定指向归档前原始 HEAD。
恢复：git fetch origin refs/tags/<归档标签>:refs/tags/<归档标签>
然后：git switch -c <恢复分支名> <归档标签>^{commit}
若需推回原分支，先确认远端名称仍为空，再 git push origin HEAD:refs/heads/<原分支名称>。
不要移动已有归档标签，也不要把旧研究分支整枝合并进当前 main。

branches.json 记录完整 SHA、tree、直接PR、最近run、触发条件审查及每项恢复命令。
results/ 保存从原 CI artifacts 取回的必要 JSON、身份/计时与两张托管 runner 原生安装器图片，result-files.json 记录原路径和 SHA-256。没有复制原始日志、用户配置、凭据、签名下载 URL、产品二进制或完整运行状态。

固定旧版实验：
Full/Core packaging: run 38171789314；两种首跑顺序、各三轮。
Core preparation: run 38151097384；serial/parallel，各两样本。
Extraction: run 38126836816；PowerShell/native/native/PowerShell 的原ZIP对照。
Provenance: run 38128068885；原1.3.0证明远程/bundle对照及四个拒绝控制。
专项证据：真实1.3.2→1.3.3升级38313176748、真实1.3.3安装/资源/断网缓存38316105136、原更新早启动竞态38195474752、真实Zlib中断恢复38040507228。
以上是各自固定源码/载荷的历史结果，不能作为当前1.4.0或未来版本实机通过证明。没有重跑实验或发布版本。

链接审查：检查386条Issue/PR正文、267条Issue/PR会话评论及main文档，没有发现待删除分支名称形式的blob/tree/raw附件链接；既有#328/#338截图已用固定commit链接。归档tag保持其对象可达。未更改两个Draft正文或状态。

archive/issue-66-default-v1-exploration-2026-09-23
c6414d856eb3d18c6ca2d56ccafbfc43f592d43f
archive/2026-10-17/archive/issue-66-default-v1-exploration-2026-09-23
git fetch origin refs/tags/archive/2026-10-17/archive/issue-66-default-v1-exploration-2026-09-23:refs/tags/archive/2026-10-17/archive/issue-66-default-v1-exploration-2026-09-23
git switch -c archive/issue-66-default-v1-exploration-2026-09-23 archive/2026-10-17/archive/issue-66-default-v1-exploration-2026-09-23^{commit}
关联：
处理依据：早期 Default V1 探索与视觉基线，163 个历史独有提交、215 路径；与 #73 tree 不同，不能逐行宣称全部合并。后续 #73/#77/#78/#124 已重构演进，保留旧方案历史，不整枝回并。关联 #66/#73，非直接 PR。

codex/formal-web-installer
1f0a39cc41a3671ae0b97d73d8e66e2fccf7ceeb
archive/2026-10-17/codex/formal-web-installer
git fetch origin refs/tags/archive/2026-10-17/codex/formal-web-installer:refs/tags/archive/2026-10-17/codex/formal-web-installer
git switch -c codex/formal-web-installer archive/2026-10-17/codex/formal-web-installer^{commit}
关联：https://github.com/Starfie1d1272/Mizar/pull/255, https://github.com/Starfie1d1272/Mizar/actions/runs/38011178301
处理依据：直接 PR #255 已关闭未合并，正文明确由 #257/#259 整合替代。17 路径，7 路径当前同字节/同删除状态，其余已演进；旧 POC/临时接口不重入。

codex/handoff-installer-20261010
ab9b3b102ac3f3d5f394a6f89a15b7d73c136905
archive/2026-10-17/codex/handoff-installer-20261010
git fetch origin refs/tags/archive/2026-10-17/codex/handoff-installer-20261010:refs/tags/archive/2026-10-17/codex/handoff-installer-20261010
git switch -c codex/handoff-installer-20261010 archive/2026-10-17/codex/handoff-installer-20261010^{commit}
关联：
处理依据：无直接 PR；#255 的后续 Box 资源 reader/native identity WIP，24 路径、720+/357-。主功能由 #257/#259 接管，但不证明未审阅 checkpoint 逐行等价；完整快照先保存。

codex/handoff-release-20261010
3c3ba26d6839abaf2034ba60c1f68eaf4729ffdb
archive/2026-10-17/codex/handoff-release-20261010
git fetch origin refs/tags/archive/2026-10-17/codex/handoff-release-20261010:refs/tags/archive/2026-10-17/codex/handoff-release-20261010
git switch -c codex/handoff-release-20261010 archive/2026-10-17/codex/handoff-release-20261010^{commit}
关联：
处理依据：无直接 PR；整合 #255/#256 的未审阅发行 WIP，43 路径、2440+/868-。主线 #257/#259 改用 machine-metadata 原字节载体；旧 release-envelope/evidence ZIP 不应重新合入，保留残余 checkpoint。

codex/issue-149-native-presentation-fix
14b1268d3478a33ba5f8dcf2649b806c74183186
archive/2026-10-17/codex/issue-149-native-presentation-fix
git fetch origin refs/tags/archive/2026-10-17/codex/issue-149-native-presentation-fix:refs/tags/archive/2026-10-17/codex/issue-149-native-presentation-fix
git switch -c codex/issue-149-native-presentation-fix archive/2026-10-17/codex/issue-149-native-presentation-fix^{commit}
关联：https://github.com/Starfie1d1272/Mizar/pull/173, https://github.com/Starfie1d1272/Mizar/actions/runs/37670093115
处理依据：直接 #173 已关闭未合并；Host geometry/WebView visibility 被 #176 吸收，进程隔离实机无收益且增内存，明确舍弃。保留失败实测交接文档。

codex/issue-149-rc25-measurement-review
355d0ca326858360b038a583cd894aeb83e85efb
archive/2026-10-17/codex/issue-149-rc25-measurement-review
git fetch origin refs/tags/archive/2026-10-17/codex/issue-149-rc25-measurement-review:refs/tags/archive/2026-10-17/codex/issue-149-rc25-measurement-review
git switch -c codex/issue-149-rc25-measurement-review archive/2026-10-17/codex/issue-149-rc25-measurement-review^{commit}
关联：https://github.com/Starfie1d1272/Mizar/pull/169, https://github.com/Starfie1d1272/Mizar/actions/runs/37651769198
处理依据：直接 #169 已关闭未合并；4 路径，useRadarAvailability 优化当前 main 仍未实现。关闭评论明确非 blocker；只在新 profiler 证据支持时提取最小优化，旧 RC25 诊断规格不回灌。

codex/release-artifact-cleanup
5c04ecacc1c8d7d65506af7317037c67926ecb21
archive/2026-10-17/codex/release-artifact-cleanup
git fetch origin refs/tags/archive/2026-10-17/codex/release-artifact-cleanup:refs/tags/archive/2026-10-17/codex/release-artifact-cleanup
git switch -c codex/release-artifact-cleanup archive/2026-10-17/codex/release-artifact-cleanup^{commit}
关联：https://github.com/Starfie1d1272/Mizar/pull/256, https://github.com/Starfie1d1272/Mizar/actions/runs/38011186046
处理依据：直接 #256 已关闭未合并，正文明确由 #257/#259 取代。20 路径；公开 evidence ZIP/release-envelope 被 machine-metadata 取代，不能为清理而复活旧方案。

diagnostics/1.3.4-box-connection
f91d24a41e169abf296c7b2a4e9f0cdf5b7e7f35
archive/2026-10-17/diagnostics/1.3.4-box-connection
git fetch origin refs/tags/archive/2026-10-17/diagnostics/1.3.4-box-connection:refs/tags/archive/2026-10-17/diagnostics/1.3.4-box-connection
git switch -c diagnostics/1.3.4-box-connection archive/2026-10-17/diagnostics/1.3.4-box-connection^{commit}
关联：https://github.com/Starfie1d1272/Mizar/actions/runs/38527407778
处理依据：无 PR；2 路径，一次性 Box read-only ABBA probe 及替换工作流，未合并。唯一 run 38527407778 成功；当前 Box 生产流程不引用此分支，不应以诊断流程覆盖生产同步。

docs/product-value-closure
cfbbff1a735809d571c85ae5ffa6bbcb3f2bbf0c
archive/2026-10-17/docs/product-value-closure
git fetch origin refs/tags/archive/2026-10-17/docs/product-value-closure:refs/tags/archive/2026-10-17/docs/product-value-closure
git switch -c docs/product-value-closure archive/2026-10-17/docs/product-value-closure^{commit}
关联：https://github.com/Starfie1d1272/Mizar/pull/115, https://github.com/Starfie1d1272/Mizar/actions/runs/36982952191
处理依据：直接 #115 关闭未合并，正文明确由 #123/#126 产品表达取代。只改 README；其‘编排属未来’等现已过时。

docs/program-renderer-host-boundary-final
b2a1a1d3dbe3be687310615338ac36e9c3c1945c
archive/2026-10-17/docs/program-renderer-host-boundary-final
git fetch origin refs/tags/archive/2026-10-17/docs/program-renderer-host-boundary-final:refs/tags/archive/2026-10-17/docs/program-renderer-host-boundary-final
git switch -c docs/program-renderer-host-boundary-final archive/2026-10-17/docs/program-renderer-host-boundary-final^{commit}
关联：
处理依据：无直接 PR；完整 tree 199e56157bd5a810611c30c1904c3941c54fb064 与 main 历史 293f97a95245709485676d3168dbfdf4e97f9e7b 完全一致，净 diff=0。6 个非祖先提交并非未合并内容。

evidence/obs328-535c7c7
7f80a8984b5481fc6641267ff4a78b5414846aa7
archive/2026-10-17/evidence/obs328-535c7c7
git fetch origin refs/tags/archive/2026-10-17/evidence/obs328-535c7c7:refs/tags/archive/2026-10-17/evidence/obs328-535c7c7
git switch -c evidence/obs328-535c7c7 archive/2026-10-17/evidence/obs328-535c7c7^{commit}
关联：
处理依据：无直接 PR，关联已合并 #328。28 路径含其旧代码和三轮截图/README，截图链接在 #328 正文直接指此 SHA。未合并实质是附件，不是待开发 OBS 修复；需先迁移/保存附件并核对链接。

evidence/obs338-b567d3f
7224b7ecaa53d80a83144cb8668d97fcafa4f7a8
archive/2026-10-17/evidence/obs338-b567d3f
git fetch origin refs/tags/archive/2026-10-17/evidence/obs338-b567d3f:refs/tags/archive/2026-10-17/evidence/obs338-b567d3f
git switch -c evidence/obs338-b567d3f archive/2026-10-17/evidence/obs338-b567d3f^{commit}
关联：
处理依据：无直接 PR，关联已合并 #338，并继承 obs328 附件。31 路径；新增 2 张浏览器截图及说明，#338 正文指此 SHA。保存附件和原 source identity，不把模拟 Host 拒绝截图称 Windows 安装结果。

evidence/update-start-race
cc132a161b44fd432defbff29aa20e47d8ea2982
archive/2026-10-17/evidence/update-start-race
git fetch origin refs/tags/archive/2026-10-17/evidence/update-start-race:refs/tags/archive/2026-10-17/evidence/update-start-race
git switch -c evidence/update-start-race archive/2026-10-17/evidence/update-start-race^{commit}
关联：https://github.com/Starfie1d1272/Mizar/actions/runs/38195474752
处理依据：无 PR，关联已合并 #354。仅 2 个新增文件：一次性 reproducer 和 push 分支专用 workflow。run 38195474752 成功；这是唯一当前仍存在显式旧分支触发引用的附加 workflow，文件只在该分支，不在 main。

evidence/workspace-exit-without-obs
c16bb1695120c9d04c8617faf5b3165201544f88
archive/2026-10-17/evidence/workspace-exit-without-obs
git fetch origin refs/tags/archive/2026-10-17/evidence/workspace-exit-without-obs:refs/tags/archive/2026-10-17/evidence/workspace-exit-without-obs
git switch -c evidence/workspace-exit-without-obs archive/2026-10-17/evidence/workspace-exit-without-obs^{commit}
关联：
处理依据：无直接 PR，关联已合并 #348。28 路径，原修复 patch-id 在 main 命中；额外日志、截图、owner-chain harness 和依赖锁文件未进入 main。必须先保全可复现证据，不能当作新的产品功能。

perf/release-final-verification
cc57b05ab6482c2da64a65ba44b8629b88a08acb
archive/2026-10-17/perf/release-final-verification
git fetch origin refs/tags/archive/2026-10-17/perf/release-final-verification:refs/tags/archive/2026-10-17/perf/release-final-verification
git switch -c perf/release-final-verification archive/2026-10-17/perf/release-final-verification^{commit}
关联：https://github.com/Starfie1d1272/Mizar/actions/runs/38040507228
处理依据：无直接 PR，关联已合并 #266。Thin LTO/Zlib、并行资格与测时进主线；19 路径中 research-real-zlib-recovery.mjs、临时 research CI 与真实 writer 诊断保留在分支，末次 38040507228 成功不等于正式整链验收。

preview/pulse-stage-label
6f2acf0ed2f5efc5356b3c658e33c4f9e304f657
archive/2026-10-17/preview/pulse-stage-label
git fetch origin refs/tags/archive/2026-10-17/preview/pulse-stage-label:refs/tags/archive/2026-10-17/preview/pulse-stage-label
git switch -c preview/pulse-stage-label archive/2026-10-17/preview/pulse-stage-label^{commit}
关联：
处理依据：无 PR；35 路径中 4 个代码/fixture 修改、31 个截图与 capture/geometry 文件。当前 main 缺 current 设计的 stage-caption 条件块与 CSS，确有未合并视觉功能；未见近期 CI，不应标已完成或自动并入。

qualification/1.3.3-published-chain
7d20d6b949ddb965b08e798cfb1b6cc6f561c52d
archive/2026-10-17/qualification/1.3.3-published-chain
git fetch origin refs/tags/archive/2026-10-17/qualification/1.3.3-published-chain:refs/tags/archive/2026-10-17/qualification/1.3.3-published-chain
git switch -c qualification/1.3.3-published-chain archive/2026-10-17/qualification/1.3.3-published-chain^{commit}
关联：https://github.com/Starfie1d1272/Mizar/actions/runs/38316105136
处理依据：无 PR；3 路径，一次性真实已发布安装器/Core/资源/断网缓存验收与原生控件 driver，替换 ci.yml。末次 run 38316105136 成功；历史 1.3.3 专项证据，不证明 1.4.0 同样实测。

qualification/1.3.3-real-upgrade
359535390f40c15574681f8efba4c55416ee67c3
archive/2026-10-17/qualification/1.3.3-real-upgrade
git fetch origin refs/tags/archive/2026-10-17/qualification/1.3.3-real-upgrade:refs/tags/archive/2026-10-17/qualification/1.3.3-real-upgrade
git switch -c qualification/1.3.3-real-upgrade archive/2026-10-17/qualification/1.3.3-real-upgrade^{commit}
关联：https://github.com/Starfie1d1272/Mizar/actions/runs/38313176748
处理依据：无 PR；2 路径，一次性原 1.3.2 helper→真实 1.3.3 NSIS 的占用/接力验收，替换 ci.yml。末次 run 38313176748 成功；先保存证据，不留作日常 CI 替代。

recovery/box-1.3.1-windows
c317078e0e459d4a5a26fdb6b44c67d567bf9b21
archive/2026-10-17/recovery/box-1.3.1-windows
git fetch origin refs/tags/archive/2026-10-17/recovery/box-1.3.1-windows:refs/tags/archive/2026-10-17/recovery/box-1.3.1-windows
git switch -c recovery/box-1.3.1-windows archive/2026-10-17/recovery/box-1.3.1-windows^{commit}
关联：https://github.com/Starfie1d1272/Mizar/actions/runs/38137287904
处理依据：无 PR；仅 box-sync.yml 临时 Windows runner/caller deadline 恢复。run 38137287904 成功，生产主线已有后续 #326/#357/#377；不需要长期恢复分支。

release/rc0-qualified-transfer
f701db14eefabbfa51e4a782c413656484254f28
archive/2026-10-17/release/rc0-qualified-transfer
git fetch origin refs/tags/archive/2026-10-17/release/rc0-qualified-transfer:refs/tags/archive/2026-10-17/release/rc0-qualified-transfer
git switch -c release/rc0-qualified-transfer archive/2026-10-17/release/rc0-qualified-transfer^{commit}
关联：https://github.com/Starfie1d1272/Mizar/actions/runs/37295535587
处理依据：无 PR；仅旧资格 workflow 改为一次性原资产上传 prerelease。run 37295535587 成功；不是当前 Qualification/Promotion 依赖，旧写入流程不可重入 main。

release/rc1-qualified-transfer
08b0c27a974fd2db12a371d477199de39471a0ac
archive/2026-10-17/release/rc1-qualified-transfer
git fetch origin refs/tags/archive/2026-10-17/release/rc1-qualified-transfer:refs/tags/archive/2026-10-17/release/rc1-qualified-transfer
git switch -c release/rc1-qualified-transfer archive/2026-10-17/release/rc1-qualified-transfer^{commit}
关联：https://github.com/Starfie1d1272/Mizar/actions/runs/37301019379
处理依据：无 PR；仅旧资格 workflow 改为一次性 RC1 原资产上传。run 37301019379 成功；非长期发布分支，不应重跑或代替当前发布流程。

starfie1d/pr73-visual-design
4dc3477be4ce466668a8c4853b08102a9b8eae11
archive/2026-10-17/starfie1d/pr73-visual-design
git fetch origin refs/tags/archive/2026-10-17/starfie1d/pr73-visual-design:refs/tags/archive/2026-10-17/starfie1d/pr73-visual-design
git switch -c starfie1d/pr73-visual-design archive/2026-10-17/starfie1d/pr73-visual-design^{commit}
关联：
处理依据：无直接 PR，关联已合并 #73（其 head 分支另名）。31 提交、157 路径，视觉/Radar 方案早期备份；与 #73 merge tree 尚有 89 路径差异，多为后续主 PR 增补/规范化，不能称完全同 tree。保留旧样例/方案，当前 Pulse/Radar 已历多次重构，不整枝回并。
