# 开发与验证

本文说明本地开发入口、验证分工与测试原则。版本发布与实机验收见[发布流程](release-readiness.md)。

## 本地运行

Node、pnpm 和命令以根 [package.json](../../package.json) 为准。云环境如有 `/workspace/.onboarding/activate.sh` 先 source。

```sh
pnpm install --frozen-lockfile
pnpm build
export GSI_TOKEN=mizar-local-preview   # PowerShell: $env:GSI_TOKEN = "mizar-local-preview"
pnpm dev
```

开发网页为 `http://127.0.0.1:4173/`，Companion 为 `http://127.0.0.1:3000/`；生产构建由 Companion 同时提供网页和协议。

| 路径                      | 用途                   |
| ------------------------- | ---------------------- |
| `/`                       | 准备中心               |
| `/operator/hud`           | HUD 编辑器             |
| `/workspace`              | 浏览器工作台预览       |
| `/operator`               | 制作控制               |
| `/program`、`/program/bp` | HUD 与 BP 播出         |
| `/debug`                  | 运行诊断               |
| `/operator/bp`            | 重定向到 BP 预览工作台 |

## 工作区构建图

工作区由 pnpm 原生任务图调度 `build → ^build`。定向构建使用依赖闭包 `...` 与 `--fail-if-no-match`（如 `pnpm --filter @mizar/companion... --fail-if-no-match run build`）。`pnpm architecture:check` 检查依赖循环、未声明导入与任务图一致性。

## 验证层次

**本地默认只跑改动相关的轻量格式（`pnpm format:prettier:check`、`pnpm format:rust:check`）、轻量静态检查（`pnpm exec eslint <改动文件> --max-warnings=0`，避免 `pnpm lint` 触发全量 `build:packages`）与必要定向测试；全量构建、测试、类型检查与 Windows 编译默认交给 CI。**

| 改动面                 | 必要核对                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| 文档                   | 链接、被引用标题与当前源码一致                                             |
| 领域逻辑、协议、持久化 | 对应现有测试、类型与 `pnpm architecture:check`                             |
| 界面或视觉             | 相关交互与失败状态、`pnpm design:check`                                    |
| 脚本、工具链、CI       | 相关脚本测试与真实入口                                                     |
| 原生宿主、安装、更新   | Windows CI 编译/clippy；真实安装、OBS、CS2 与音画交互需在 Windows 实机验收 |

### 测试职责与独立判定

- 优先复用现有测试，从生产入口验证关键副作用、持久化顺序、恢复与隔离边界。
- 不依赖内部调用顺序写脆弱测试；外部环境（Windows/CS2/OBS）缺失时明确标注未验证范围。

## 操作记录与失败可诊断性审查

关键操作需按「记录 → 保留脱敏原因链 → 持久化 → 可导出」闭环实现，不吞掉错误原因，也不将凭据、令牌或推流密钥写入日志或导出包；详细回传契约见[诊断契约](../reference/diagnostics-delivery.md)。

## CI 检查

常规 CI 由 [CI 工作流](../../.github/workflows/ci.yml) 执行：

```sh
node scripts/ci/tests.mjs scripts
pnpm build
node scripts/ci/tests.mjs product
pnpm typecheck
pnpm format:check   # Prettier、.github/**/*.{yml,yaml} 与两套 Rust workspace 的 cargo fmt --check
pnpm lint
pnpm architecture:check
pnpm local-web:production-smoke
```

涉及桌面宿主、安装器或工作流的 PR 会触发 `native build / Windows` 编译与 clippy 检查。`verify-update-recovery.mjs` 为显式 `workflow_dispatch`（`update_recovery=true`）受控验证，不在常规 PR CI 中运行。

## 桌面 IPC 与可靠输出

修改 [ipc_contract.rs](../../apps/desktop/src-tauri/ipc_contract.rs) 后，在 `apps/desktop/src-tauri` 运行 `rustc --edition=2021 ipc_generate.rs` 重新生成绑定，Windows CI 会核对生成的能力清单。

## 样例、重放与来源

真实样例验证使用只读 `pnpm fixtures:*:verify`，生成或同步使用对应 `:generate` / `:sync` 并检查 diff。回放与排练隔离生产检查点和网站快照。
