# 参与 Mizar 开发

欢迎提交问题、改进文档或贡献代码。了解项目用途可先读[产品定位](docs/guide/product.md)，查找其他资料可从[文档目录](docs/README.md)开始。

## 提交问题或建议

先搜索已有 Issue。报告问题时，请提供 Mizar 版本、运行环境、复现步骤，以及预期和实际结果；截图或日志只附与问题有关的部分，注意移除凭据和私人信息。

较大的功能或架构调整，建议先通过 Issue 讨论目标和取舍。小修复和文档改进可以直接提交 PR。

## 准备开发环境

从最新的 `main` 创建分支。Node 和 pnpm 版本见 [package.json](package.json)，依赖安装与更新见[依赖维护](docs/development/dependency-maintenance.md)。

在 PowerShell 中运行：

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:GSI_TOKEN = "mizar-local-preview"
pnpm dev
```

本地服务地址、GSI 配置和 Windows 开发说明见[开发验证](docs/development/development-validation.md#本地运行)。

## 修改与验证

让一次修改聚焦一个问题，优先复用现有模块。涉及模块职责时查阅[架构](docs/reference/architecture.md)，接口与游戏数据分别参考[协议](docs/reference/protocol.md)和[数据语义](docs/reference/telemetry.md)；界面改动遵循[设计系统](docs/design/README.md)。

按[改动范围](docs/development/development-validation.md#验证层次)运行必要检查，优先使用已有测试，只补关键风险缺少的覆盖。Windows、CS2、OBS 和安装更新行为需要相应的实机验证；缺少环境时，在 PR 中说明未验证的部分。

行为变化时同步负责该内容的文档，写作和归属见[文档维护](docs/README.md#写作与维护)。涉及架构决策时，按[决策记录](docs/decisions/README.md)保留理由和取舍。

## 提交 PR

说明解决的问题、修改后的行为、关联 Issue 和实际验证结果。有待讨论或尚未完成的工作可以使用草稿 PR，准备好后再请求审查。

维护者根据审查结果、最新提交的 CI 和必要验收决定是否合并。只有达到对应 Issue 的验收条件时才关闭；未完成的部分写明原因和下一步。版本发布另见[发布流程](docs/development/release-readiness.md)。
