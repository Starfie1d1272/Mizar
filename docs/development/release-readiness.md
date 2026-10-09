# 版本发布

发布按“候选构建 → 实机验收 → 冻结版本 → 正式资格构建 → 原产物晋级 → 下载核验”进行。具体进度与验收结果记录在 [发布总纲](https://github.com/Starfie1d1272/Mizar/issues/90)、[发布工程](https://github.com/Starfie1d1272/Mizar/issues/133)和[实机验收](https://github.com/Starfie1d1272/Mizar/issues/35)。

正式版本收尾覆盖文档、版本与发布元数据，运行时变化按影响范围复验。每次发布的源码、验收基线与执行结果保存在对应 Issue / PR 和 Release。

## 版本与构建身份

`apps/desktop/src-tauri/Cargo.toml` 的 `package.version` 是应用版本权威。修改时同步 `Cargo.lock` 与 Tauri 配置；`app-version.mjs` 核对版本一致性。正式版本使用 `1.0.0`，候选版本使用 `1.0.0-rc.N`，发布标签为 `v<应用版本>`。

Windows x64 的分发名称为：

- 安装包：`Mizar-v<应用版本>-Windows-x64-Setup.exe`。
- 便携包：`Mizar-v<应用版本>-Windows-x64.zip`。

完整源码、应用版本和内容摘要保存在 `resources/metadata/artifact.json`、`release-manifest.json` 与 `distribution-manifest.json`。包内 `SHA256SUMS` 校验文件内容，外层 `.sha256` 校验分发文件。Node 版本、Windows 运行时摘要及安装工具版本由资格构建契约固定。

## 资格构建

1. 选定干净工作树的完整源码 SHA，在该源码上执行完整 CI。手动运行 CI 可取得全部检查结果。
2. 运行 **Release Qualification**，指定源码引用与报告标签。构建先固定 SHA，以 `release` 配置生成原始 ZIP 并运行 Rust 测试。
3. 独立 Windows 任务分别验证便携包，以及从同一 ZIP 生成的中文 NSIS Setup。安装包检查包含带空格目录安装、升级、卸载、用户数据保留、逐文件摘要和桌面启动。
4. 汇总任务核对两路源码、版本和内容身份，再签发构建来源证明。产品资产与验收资料分别上传；验收资料包含两路报告、发布清单和构建计时。
5. 核对资源、许可证、产品启动与 C4 资源检查结果。各类检查的适用范围见[开发验证](development-validation.md)。

## 候选实测

向验证者提供同一候选的源码 SHA、下载链接、摘要、构建配置、自动化报告与待验范围。在 Windows、CS2、OBS 的实际环境中记录操作、结果和必要证据。修复后生成新候选，并复验受影响场景。

截图使用实际产品画面，版本、环境与素材来源集中保存在[图片来源](../screenshots/provenance.json)。产品回归样例与校验工具继续随源码维护，单次调查和实测报告由协作平台与发布资产保存。

## 正式发布

1. 核对已签收候选到最终源码的差异，统一应用版本、README、操作手册、随包说明与[1.0 发布说明](../releases/1.0.md)。
2. 对最终源码重新执行完整 CI 和 Release Qualification。
3. 运行 **Release Promotion**，输入资格构建编号和精确版本标签。流程按产品清单的源码核对最新完整 CI，验证 ZIP、Setup、版本、内容摘要和构建来源证明，再创建草稿、上传原资产并发布。
4. 晋级直接使用已验证资产。同身份重复运行保留既有发布；身份冲突时停止并交由维护者核对。
5. 下载正式资产，复核摘要、清单、包内身份与来源证明，完成安装和启动短检查。
6. 记录 GitHub Release 的实际 `immutable` 值。启用不可变发布后，修订通过新版本交付；已发布资产持续保留原身份。

1.0 采用未签名安装包分发，用户提示由发布说明维护。代码签名与后续更新体验在后续版本推进。

## 南大云盘镜像

GitHub Releases 提供完整版本历史、Setup、ZIP、校验和与构建来源证明。南大云盘复用现有 Mizar 资料库，为国内用户提供单安装包下载。

- `Stable/`：仅保留最新正式版本的一个 Setup。
- `Archive/`：私有回滚目录，保留经过使用验证的版本；人工保留项由维护者管理。
- 候选版本与历史版本通过 GitHub Releases 下载。

**Box Sync** 在 Release Promotion 成功后独立执行，并支持指定标签重试与小文件接口探测。流程重新核对正式 Release、标签、清单、安装包大小和 SHA-256，再上传原始字节；候选版本直接跳过。GitHub Actions 使用现有 `MIZAR_BOX_REPO_TOKEN`，资料库令牌仅进入镜像任务。

镜像先上传新版并下载校验，再将已核实的旧版移入 Archive。切换期间 Stable 可短暂存在两个安装包；失败后保留可下载文件，同版本重试继续核对并完成整理。同名内容冲突时停止，由维护者检查。自动流程保留 Archive 内容；维护者确认回滚保留版本后可单独清理多余条目。

同步失败可在 Actions 重跑 Box Sync，GitHub Release 继续提供下载。Token 缺失、权限错误、空间不足或上传中断时查看步骤摘要，修正后使用同一标签重试。

公开下载统一使用 [Stable](https://box.nju.edu.cn/d/91dec4c27e5d47f38fcf/)，README 与操作手册维护同一入口。每次发布完成匿名下载、摘要与只读权限核对。资料库根目录和 Archive 保持私有，上传由资料库令牌完成。
