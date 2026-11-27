# 版本与发布

本文说明 Mizar 的版本规范、发布流程与实机验收要求；具体工作流以 [Release Qualification](../../.github/workflows/release-qualification.yml)、[Release Promotion](../../.github/workflows/release-promotion.yml) 和 [Box Sync](../../.github/workflows/box-sync.yml) 为准。

## 版本与兼容性

- 应用版本遵循 `MAJOR.MINOR.PATCH`，正式标签为 `v<版本>`，预发布可使用 `-alpha.N`、`-beta.N`、`-rc.N`（从 `.1` 开始）。
- 单一权威版本在 [Cargo.toml](../../apps/desktop/src-tauri/Cargo.toml) 的 `package.version`，[tauri.conf.json](../../apps/desktop/src-tauri/tauri.conf.json)、[installer/Cargo.toml](../../apps/desktop/installer/Cargo.toml)、[update-release.json](../../scripts/qualification/update-release.json) 与 [CHANGELOG.md](../../CHANGELOG.md) 须保持一致。

| 变化  | 版本选择原则                                         |
| ----- | ---------------------------------------------------- |
| Patch | 兼容既有契约的缺陷、安全或小型展示修正               |
| Minor | 向后兼容的新能力与较明显的体验改进                   |
| Major | 公开契约不兼容变化，或进入需要独立评估迁移的重大阶段 |

## 正式发布不变量

1. **构建身份唯一**：可晋级产物只从 `main` 触发 Release Qualification 生成，Promotion 直接发布该次冻结的原资产与 Sigstore/TUF 来源证明，不在晋级时重编。
2. **先验证再晋级**：通过 CI 与对应风险的 Windows / CS2 / OBS 实机验收（安装、升级、卸载、带空格/中文路径、制播保护与用户资料保留）。
3. **保留证据**：发布页与元数据保留源码 SHA、SHA-256 与构建证明链接。

## 精简 Windows 制播实测矩阵

发布前在目标 Windows 候选包上按受影响范围核对：

| 场景             | 核对要点                                                                    |
| ---------------- | --------------------------------------------------------------------------- |
| 安装、迁移与回退 | 全新安装（含中文路径）、覆盖重装、自动回退、卸载保留 `%LOCALAPPDATA%\Mizar` |
| 制播与输出       | CS2 / OBS 启动、游戏捕获、音轨、切场、暂停恢复与安全退出                    |
| 音乐、运镜与提示 | 选段播放、私有提示、HUD/雷达/网站数据隔离与同机负载                         |

## 发布过程

1. **准备版本与更新日志**：先在 [CHANGELOG.md](../../CHANGELOG.md) 编写合法的 `## [Unreleased]` 或目标版本日志（预发布 `RC` 记录本轮增量；正式版 `Stable` 需由人工或 Agent 汇总上一正式版以来的累计变化），再执行 `pnpm release:prepare <version>`（例如 `pnpm release:prepare 1.14.0-rc.1` 或 `pnpm release:prepare 1.14.0`，支持 `--dry-run` 预览）。该命令仅同步更新本地版本文件并做自检，不会自动执行 `git commit`、`git tag` 或 `git push`。
2. 在 `main` 触发 `Release Qualification`（输入 `tag`、`ref`、`resource_pack_version`、`resource_sequence` 或复用 `resource_source_run`）。
3. 资格通过后自动触发 `Release Promotion` 创建并公开 GitHub Release（生成并签发 `update-manifest.json`、`update-publication.json`、`update-index.json` 与 `machine-metadata.json`）。
4. 稳定版晋级完成后自动触发 `Box Sync` 同步兼容元数据与 `Diagnostics Release`。

## 分发、镜像与应用内更新

- **GitHub Releases** 是完整正式资产与可信元数据的公开入口；**Box** 仅保留旧客户端兼容元数据（`/Updates/latest.json` 与 `/Runtime/v<版本>/machine-metadata.json`）。
- 客户端更新先通过 Sigstore / TUF 验证签名索引与发布来源，再校验安装包大小与 SHA-256；`<= 1.11.27` 旧架构超出 `minimumVersion` 时自动提示用户从发布页下载新版安装包手动覆盖迁移。

## 更新日志与发布正文

[CHANGELOG.md](../../CHANGELOG.md) 是更新说明的唯一来源，版本按新到旧排列（标题格式 `## [1.12.0]`）。

- 当前版本与非空 `## [Unreleased]` 按「新增功能、体验改进、问题修复、升级提醒」顺序分组，空分组省略；`pnpm release-notes:check` 会校验标题与分组格式。
- 正文仅使用 `###` 标题、段落、列表与行内基础格式（不用图片、HTML、表格或代码块），由 `scripts/qualification/release-notes.mjs` 提取为 GitHub Release 正文与客户端纯文本更新说明。
