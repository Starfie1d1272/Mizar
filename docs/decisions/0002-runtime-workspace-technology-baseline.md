# ADR-0002：Runtime / Workspace 技术基线

- 状态：**Accepted**
- 日期：2026-09-12
- 关联：ADR-0001、`docs/product.md`、`docs/architecture.md`

## 背景

Mizar 是一套长期运行在赛事制作环境中的 local-first CS2 Broadcast Runtime。它需要同时承担：

- 接收并标准化约 10–20 Hz 的 CS2 GSI；
- 维护低延迟、不可积压的本地状态；
- 为 `/program`、`/operator`、`/debug` 提供本地 Web UI；
- 通过 OBS Browser Source 输出节目画面；
- 与 RivalHub 通过 versioned contract 交换赛事上下文、live projection 与结果候选；
- 支持 record/replay、fault injection、长时间 soak 和视觉回归；
- 首要生产目标是 Windows 11，同时应允许 macOS/Linux 开发与自动化测试。

本仓库的技术原则不是“选择最激进的新工具”，而是：

> **优先使用当前稳定、现代、生态成熟且能长期维护的技术；把实时可靠性和架构边界放在基准吞吐量之前。**

本 ADR 冻结 Runtime / Workspace 的基础技术选择。协议字段、桌面壳、最终安装包、Radar renderer、OBS 控制等仍由后续 ADR 决定。

---

## 决策 1：生产 Runtime 使用 Node.js 24 LTS

### 选择

- 生产 Runtime：**Node.js 24.x LTS**；初始化时以当前 24.21.x 为基准。
- `package.json` 使用 `engines.node = "24.x"`，并固定项目开发 runtime major。
- CI 主线使用 Node 24。
- Node 26 当前仍为 Current；可在兼容性 job / 定期 job 中验证，但在其进入 LTS 且通过真实 soak 前不升级生产基线。

### 原因

截至 2026-09-12，Node 24 为 LTS，Node 26 仍为 Current。Mizar 的实际负载只有一条本地 GSI 流、少量浏览器 consumer 和低频 cloud uplink；真正风险是长时间 backlog、listener 泄漏、重连和第三方兼容，而不是极限 socket benchmark。

Node 24 同时与 RivalHub 主仓当前 runtime major 一致，能减少开发与 CI 环境差异，但 Mizar 不因此与主仓共享源码或编译配置。

参考：

- <https://nodejs.org/en/about/previous-releases>
- <https://nodejs.org/en/blog/release>

### 为什么暂不使用 Bun 作为生产 Runtime

Bun 的 WebSocket 与 standalone executable 能力很有吸引力，也保留为未来可重新评估的方向。但当前没有证据表明 Mizar 的瓶颈会是 Node + `ws` 的吞吐量；为了单文件 executable 或更高 benchmark 吞吐提前更换 runtime，会扩大兼容性和生产验证面。

因此：

- Core 代码不得依赖 Node-only API，除非该能力明确属于 adapter；
- 不把 Bun-specific API 写入 `packages/core` / `packages/protocol`；
- 如果未来 Windows packaging、启动速度或性能数据证明 Bun 有明确收益，可以通过新 ADR 重新评估。

---

## 决策 2：TypeScript 7 + ESM-only

### 选择

- 语言：**TypeScript 7.0.x stable**；初始化时以 7.0.2 为基准。
- 仓库统一 ESM，package 使用 `"type": "module"`。
- `strict: true`。
- Node 运行包使用 `module` / `moduleResolution = nodenext`。
- Vite/Web 代码使用 bundler resolution。
- 开启 `verbatimModuleSyntax`，类型导入使用 `import type`。
- 默认开启 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等严格选项；确有外部协议兼容理由时才局部放宽。
- 避免 `enum`、namespace、parameter property 等需要额外 runtime transform 的 TypeScript-only 语法；优先普通 JS-compatible construct + literal union。
- 不使用跨 package 的 `paths` alias 伪装依赖；跨 package import 必须经过 workspace package name 与 `exports`。

### 原因

TypeScript 7 已于 2026-07-08 stable，官方说明其 native compiler 在完整 build 中通常有约 8–12x 提升，并以 TypeScript 6 的类型语义兼容为基础。对于需要频繁 replay/test/build 的多 package 仓库，这类编译性能收益是直接价值。

TypeScript 官方对现代 Node 项目推荐 `nodenext`；对真正由 bundler 处理的前端代码使用 bundler resolution。共享库默认按 Node-compatible ESM 规则编写，可以避免声明文件在下游 Node consumer 中出现“bundler 能解析、Node 不能解析”的隐患。

参考：

- <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>
- <https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options>

### Node 内建 TypeScript 支持的边界

Node 24.12 起 type stripping 已 stable，但 Node 明确不会读取 `tsconfig.json`，也不会进行 type checking。

因此：

- 可以用于仓库内少量、满足 erasable syntax 的维护脚本；
- **不得把“Node 能直接执行 `.ts`”当作生产 build 策略**；
- production app / library 仍构建为普通 JavaScript artifact。

参考：<https://nodejs.org/api/typescript.html>

---

## 决策 3：使用 pnpm 12 原生 workspace，不引入额外 monorepo orchestrator

### 选择

- Package manager：**pnpm 12.x stable**；初始化时固定 `pnpm@12.3.4`。
- 单一 `pnpm-lock.yaml`。
- 使用 `pnpm-workspace.yaml` 管理 `apps/*`、`packages/*`。
- 内部 package 使用 `workspace:` protocol。
- 共享第三方版本使用 pnpm `catalog:` 集中管理，避免各 package 漂移。
- root script 优先使用 `pnpm -r` / `pnpm --filter` 编排。
- 初版**不引入 Turborepo、Nx、Lage 等第二层任务图系统**。

### 原因

pnpm 已原生提供 first-class workspace、workspace protocol、filter、single lockfile 和 catalogs。当前仓库规模很小，引入额外 task runner 只会增加缓存、配置和 agent 理解成本。

只有当 CI profiling 证明“任务图、远程缓存或 affected-only execution”已成为真实瓶颈时，再通过独立 ADR 引入 orchestrator。

同时利用 pnpm 的严格依赖隔离与 install-script allowlist：第三方 dependency 的 lifecycle/build script 不应默认获得执行权限。

参考：<https://pnpm.io/>

---

## 决策 4：共享 package 默认不 bundle；Web 由 Vite bundle

### Shared libraries

以下 package 默认输出标准 ESM JavaScript 与 declaration：

```text
packages/protocol
packages/core
packages/telemetry-gsi
packages/rivalhub
packages/radar
packages/testkit
```

原则：

- `src/` 是源码；
- `dist/` 是 build artifact；
- package `exports` 指向 `dist/`，不直接向 consumer 暴露 `src/*.ts`；
- 默认由 TypeScript project/build graph 产生 `.js` + `.d.ts`；
- 不为了“少几个文件”预先用 library bundler 把共享库打成单 bundle；
- 真正需要独立发布的 contract package 必须拥有可检查的编译产物和兼容 fixture。

TypeScript 官方也指出：如果 library 的 bundler 不同时正确处理 declaration bundle，容易出现运行时 bundle 与 `.d.ts` module resolution 不一致；对本项目这样的小型共享库，默认不 bundle 更简单、更可验证。

### Web

`apps/web` 使用：

- **React 19.3 stable**；
- **Vite 8.2.x stable**；
- production build 由 Vite/Rolldown 完成。

不使用 Next.js / SSR / React Server Components。Mizar Web 的主要消费者是 localhost Operator 和 OBS Browser Source，没有 SEO、server rendering 或 edge rendering 需求。

React 负责 scene composition、layout 和低频结构状态；Radar marker / utility movement / clock interpolation 等高频路径允许 `requestAnimationFrame` + imperative rendering，禁止把每个 GSI tick 等价成整棵 React tree rerender。

Vite 8 已使用 Rolldown 作为统一 bundler，适合本项目这种静态 Web output + 快速迭代模型。

参考：

- <https://react.dev/blog/2026/09/09/react-19-3>
- <https://vite.dev/blog/announcing-vite8>

### 浏览器兼容原则

OBS Browser Source 的 CEF 版本不应被假定等于当日 Chrome Stable。因此：

- 不把最新浏览器 API 作为节目主路径的唯一实现；
- 对 View Transition 等增强能力使用 feature detection 与 fallback；
- `/program` 的 production acceptance 以真实 OBS Browser Source 为准，而不是仅以 Chrome/Playwright 为准。

---

## 决策 5：Companion 使用 Fastify + `ws`，但 transport 不进入 Core

### 选择

本地 Companion 第一版采用：

- HTTP：**Fastify 5.x stable**；初始化时以 5.12.x 为基准；
- WebSocket：**`ws` 8.x stable**；初始化时以 8.21.x 为基准；
- wire validation：**Zod 4.x stable**；初始化时以 4.6.x 为基准；
- structured log：沿 Fastify/Pino 体系输出结构化日志。

Fastify 负责：

- health/readiness endpoint；
- operator command endpoint；
- GSI ingress adapter 的 HTTP surface（具体路由后续 ADR）；
- static Web assets / local API composition；
- auth / validation / lifecycle hooks。

`ws` 负责本地 browser realtime transport。

### 架构限制

`packages/core` 不得 import：

```text
fastify
ws
react
vite
OBS client
RivalHub HTTP client
具体 GSI parser
```

Core 暴露的是：

```text
normalized input
state transition
SnapshotBus semantics
EventJournal semantics
command/result model
```

Fastify / `ws` 只是 adapter。

内部仍固定：

```text
Snapshot = latest-wins / bounded / droppable
Event    = ordered / deduplicated / replay when meaningful
```

首版可以用一个物理 WebSocket multiplex state + event；是否拆成多个 socket 必须由 soak/backpressure 数据驱动，不在本 ADR 里进一步固定。

参考：

- <https://fastify.dev/docs/latest/>
- <https://www.npmjs.com/package/ws>

---

## 决策 6：Protocol 使用 runtime validation，不共享 RivalHub 源码类型

`packages/protocol` 是 Mizar 内部和跨仓库 integration contract 的 owner，而不是 RivalHub domain model 的镜像。

规则：

- wire DTO 必须有 runtime schema validation；
- 当前使用 Zod 4；
- schema 必须 versioned，例如 `BroadcastManifestV1`；
- 关键 schema 提供 JSON fixture；
- 对需要跨语言/跨仓库消费的 contract，提供 JSON Schema / 等价机器可读 schema 产物；
- Mizar 不 import RivalHub 仓库源码；RivalHub 也不 import Mizar `src/`；
- 两边通过 wire contract + compatibility fixture 验证兼容。

这样 RivalHub 可以继续使用自己的 TypeScript / Next.js release cadence，Mizar 也可以独立升级 TypeScript 和 runtime。

---

## 决策 7：测试栈以“可重放生产输入”为中心

### 工具

- unit / property / integration：**Vitest 5 stable**；
- browser / visual / operator flow：**Playwright 1.63 stable**；
- replay / simulator / chaos：本仓库 `packages/testkit`；
- 真正 Windows + CS2 + OBS：发布前 production acceptance，不伪装成普通 CI 能完全覆盖。

### 原则

最重要的测试不是组件 snapshot，而是：

```text
recorded raw GSI
→ exact production telemetry adapter
→ Mizar Core
→ projection / event
→ renderer
```

同一 fixture 应可用于：

- 正常 replay；
- 加速 replay；
- packet drop；
- jitter；
- duplicate；
- reorder；
- disconnect/reconnect；
- slow consumer；
- wrong match；
- map restart。

### CI 分层

PR 快速门：

```text
typecheck
lint
architecture check
unit / contract tests
short replay regression
web build
```

随后再分层运行：

```text
Playwright / visual
long accelerated replay
Windows build/smoke
scheduled compatibility / soak
```

避免每次微小改动都运行最高成本的 production-like 测试，但 release 前必须执行真实 Windows + OBS 长时间验收。

Vitest 5 于 2026-09-03 stable；Playwright 当前 release line 为 1.63。

参考：

- <https://vitest.dev/blog/vitest-5>
- <https://playwright.dev/docs/release-notes>

---

## 决策 8：代码质量与依赖策略

### Lint / format

首版采用成熟、可组合的工具链：

- ESLint flat config；
- TypeScript-aware lint；
- React hooks lint；
- Prettier 负责纯格式化。

不同时引入 Biome + ESLint + Prettier 三套重叠工具。

如果未来 profiling 证明 lint/format 已成为明显 bottleneck，再单独评估 Biome 或其他替代方案。

### Dependency policy

- dependency 版本集中在 pnpm catalog；
- lockfile 必须提交；
- 只跟随 stable tag，不自动采用 alpha/beta/canary；
- dependency upgrade 通过显式 PR，并运行对应 replay / visual / build checks；
- 生产依赖的 lifecycle/build script 默认不信任，按需 allowlist；
- 引入第三方代码前记录许可证与使用方式到 `THIRD-PARTY-NOTICES.md`。

“使用最新稳定版”意味着主动升级并验证，而不是让生产依赖在没有 review 的情况下自动漂移。

---

## 决策 9：平台与 packaging 暂不绑桌面框架

本技术基线只冻结：

```text
Companion local process
+ local HTTP/WebSocket
+ browser-based Operator/Program/Debug
```

首要生产平台是 Windows 11。

当前不把 Electron、Tauri、Node SEA 或 Bun executable 设成架构前提。它们解决的是安装、托盘、自动更新、native integration、单文件分发等 packaging 问题，而不是 Mizar Core 问题。

在真正需要 desktop shell 前，Web UI 必须能够独立通过 localhost 运行。后续 packaging ADR 可以选择普通 portable bundle、native launcher、Electron、Tauri 或其他方案，而不重写 Core/Web contract。

---

## 初始版本基线

截至 2026-09-12，初始化时采用：

| 能力 | 基线 |
| --- | --- |
| Runtime | Node.js 24.x LTS（当前 24.21.x） |
| Language | TypeScript 7.0.2 |
| Package manager | pnpm 12.3.4 |
| UI | React 19.3.0 |
| Web build | Vite 8.2.2 |
| Local HTTP | Fastify 5.12.x |
| WebSocket | ws 8.21.3 |
| Runtime schema | Zod 4.6.x |
| Unit / integration | Vitest 5.x |
| Browser / visual | Playwright 1.63.x |

Patch 版本允许在初始化实施时采用同一 stable minor 中更新的安全/修复版本，但不得因此越过 major、采用 prerelease，或改变本 ADR 的兼容边界。

---

## 明确不采用 / 暂不采用

当前不采用：

- Node 26 作为 production runtime；
- Bun-specific runtime API 进入 Core；
- CommonJS；
- Next.js / SSR；
- Turborepo / Nx 作为初始化依赖；
- shared library 默认 bundling；
- 直接 import RivalHub 源码类型；
- 在 production 直接依赖 Node type stripping 执行完整应用；
- Electron/Tauri 作为 Core 或 Web 的前置条件；
- 一个可靠 FIFO 承载所有高频 snapshot。

---

## 后果

### 正面

- 生产 runtime 使用 LTS，降低赛事现场不确定性；
- TS7/Vite8 保持现代且有明显构建性能收益；
- workspace 很小，不因 monorepo 工具本身产生额外复杂度；
- Node/Web/contract module resolution 边界明确；
- Core 可测试、可迁移，不被 Fastify/React/OBS 绑死；
- 后续如果切 Bun、桌面壳或 transport，不需要重写 domain/runtime core。

### 代价

- 不追求第一天就生成单文件 `.exe`；
- shared package 有显式 build step；
- NodeNext 对相对 import extension 等规则更严格；
- Windows + OBS 仍需要真实 acceptance，不能只靠 Linux CI 证明生产可靠。

这些代价是有意接受的：本项目优先保证可预测性、可验证性和长期演进，而不是最少配置行数。

---

## 何时重新评估

出现以下任一事实时，新建 ADR，而不是直接修改本决定：

- Node 26 进入 LTS，并完成 Mizar soak；
- Node + `ws` 被 profiling 证明是实际性能瓶颈；
- pnpm 原生任务编排无法满足 CI 性能目标；
- packaging 明确需要 native shell / auto-update / tray / protocol handler；
- OBS Browser Source 对当前 Web target 出现不可接受兼容问题；
- shared package 开始对外发布并需要不同的 bundle/dual-package 策略；
- 现有 lint/build 工具成为可量化的开发瓶颈。
