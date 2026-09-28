# Third-Party Notices

本文件记录 Mizar 仓库当前直接声明的第三方依赖及其已知许可证。精确依赖版本以 `pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 为机器来源。

研究参考项目不属于安装依赖，也不在本文件登记；相关内容见 [`docs/references.md`](docs/references.md)。

| 依赖 | 当前版本 | 用途 | 许可证 |
| --- | ---: | --- | --- |
| `@eslint/js` | 10.0.1 | ESLint 基础规则 | MIT |
| `@fastify/static` | 10.1.3 | Companion 静态文件服务 | MIT |
| `@fastify/websocket` | 11.3.0 | Companion WebSocket 承载 | MIT |
| `@fontsource/inter` | 5.3.0 | Program/Web 本地字体 | OFL-1.1 |
| `@playwright/test` | 1.63.0 | 浏览器与视觉回归 | Apache-2.0 |
| `@types/node` | 24.13.4 | Node 类型声明 | MIT |
| `@types/react` | 19.3.0 | React 类型声明 | MIT |
| `@types/react-dom` | 19.3.0 | React DOM 类型声明 | MIT |
| `@types/ws` | 8.18.1 | WebSocket 类型声明 | MIT |
| `@typescript/native` → `typescript` | 7.0.2 | TypeScript 7 编译与类型检查 | Apache-2.0 |
| `@vitejs/plugin-react` | 6.1.1 | Vite React 插件 | MIT |
| `cs2parser` | 2.5.0 | CSTV fragment / GameEvent source | GPL-3.0 |
| `eslint` | 10.10.0 | 静态检查 | MIT |
| `eslint-plugin-react-hooks` | 7.1.1 | React Hooks 规则 | MIT |
| `fastify` | 5.12.4 | Companion HTTP 组合层 | MIT |
| `jsdom` | 26.1.0 | 测试 DOM 环境 | MIT |
| `prettier` | 3.9.6 | 代码格式化 | MIT |
| `react` | 19.3.0 | Web 渲染 | MIT |
| `react-dom` | 19.3.0 | Web DOM 渲染 | MIT |
| `tsx` | 4.23.13 | 开发脚本运行 | MIT |
| `typescript` → `@typescript/typescript6` | 6.0.2 | TypeScript tooling API 兼容层 | Apache-2.0 |
| `typescript-eslint` | 8.70.0 | TypeScript-aware ESLint | MIT |
| `vite` | 8.3.0 | Web 构建与开发服务 | MIT |
| `vitest` | 5.0.0 | 单元与集成测试 | MIT |
| `zod` | 4.6.2 | Runtime schema validation | MIT |

## 设计系统开发依赖

| 依赖 | 当前版本 | 用途 | 许可证 |
| --- | ---: | --- | --- |
| `storybook` / `@storybook/react-vite` / `@storybook/addon-a11y` | 10.6.0 | 独立组件目录、可复用样例与无障碍审查 | MIT |
| `@vitest/browser-playwright` | 5.0.0 | Chromium 组件交互测试 | MIT |
| `axe-core` | 4.12.1 | WCAG 2.2 自动无障碍验证 | MPL-2.0 |
| `jsonc-parser` | 3.3.1 | DTCG JSON 结构与重复键校验 | MIT |
| `postcss` | 8.5.8 | 限定范围的 CSS 声明架构检查 | MIT |

这些依赖仅用于开发和验证；Storybook、axe、浏览器测试工具不进入正式产品。

## Development-time asset tooling

| 工具/来源                               |                              当前版本或来源 | 用途                                                            | 许可证/说明                                                                              |
| --------------------------------------- | ------------------------------------------: | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ValveResourceFormat / Source2Viewer-CLI | 20.0.6980+a06886f7d06049052d32a7381ec05523064a2ca0 | 从维护者提供的 CS2 VPK allowlist 提取并 decompile `vsvg_c` | MIT（工具）；reverse-engineered tooling，不是 Valve 官方 SDK |
| Counter-Strike 2 game resources         | Steam App ID 730；每次导入记录具体 build ID | `@mizar/cs2-assets` 的 SVG presentation asset 与 10+3 官方 Radar overview 底图来源 | Valve / Counter-Strike 2 origin；本条只记录工程 provenance，不作所有权、商标或再许可判断 |
| FURIA team logo                         | `https://us.furia.gg/images/brand/logotipo-white.svg` | #76 fixture-local MatchContext presentation enrichment；文件 hash 记录于 `fixtures/gsi/acceptance/ancient-round-03/team-context-enrichment.json` | FURIA origin；provenance 记录不构成所有权或再许可声明 |
| G2 Esports team logo                    | `https://g2esports.com/pages/brand-guidelines` 与官方 CDN PNG | #76 fixture-local MatchContext presentation enrichment；文件 hash 记录于 `fixtures/gsi/acceptance/ancient-round-03/team-context-enrichment.json` | G2 Esports origin；按官方 brand guidance 保持比例、不添加效果；provenance 记录不构成所有权或再许可声明 |
| Steam public profile avatars            | Steam Web API `ISteamUser/GetPlayerSummaries/v2` 返回的 `avatarfull` | #76 开发期一次性 import，写入本地 fixture asset 并记录 profile ID、source URL 与 SHA-256 | Valve / Steam profile content；仅记录来源，不作用户内容所有权或再许可判断 |

`cs2parser` 只通过 `packages/telemetry-cstv` 内部 binding 使用；其第三方类型不成为 Mizar 公共 contract。本仓库未因研究参考而复制 HOT、Boltobserv、Lexogrine HUD Manager、Obserview、Zhenhai HUD Manager 等应用的代码或图片资产。

## Adapted presentation sources

本 Issue 的 HUD presentation adaptation 只借鉴并改写下列已固定版本的 presentation source。它们不是安装依赖；本仓库不携带其 runtime、图片资产或原始数据处理逻辑。改写后的文件只消费 Mizar `ProgramPayload` / `RadarSnapshot` presentation models，并保留本节 provenance。

| 来源                      | 固定版本与改写参考文件                                                                                                                                    | 许可证                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Lexogrine `cs2-react-hud` | `7874750c97fcecd8f72eb3fad382917e035ec651`；`MatchBar.tsx`、`TeamScore.tsx`、`TeamLogo.tsx`、`SeriesBox.tsx`、`matchbar.scss`、`Pause.tsx`、`Timeout.tsx`、`Player.tsx`、`TeamBox.tsx`、`players.scss`、`src/HUD/Timers/BombTimer.tsx`、`src/HUD/Timers/PlantDefuse.tsx`、`src/HUD/Players/Observed.tsx`、`src/HUD/Players/observed.scss` | MIT                                 |
| Eon `mortenlein/eon`      | `a37326cd59d37dc6c157832ba06b01c232d878e1`；`maps-sleek` 的 HTML/CSS/JS                                                                                   | 固定版本 `package.json` 声明 ISC；该 revision 无独立 `LICENSE` 文件 |
| M3MONs `CS2-HUD`          | `4eb84e4f553f1ad685ec437e49aa2bf411606990`；Radar React + rAF loop 与 player angle / smoothing seam 参考                                            | MIT                                 |

Lexogrine MIT notice（固定版本 `LICENSE`）：

```text
MIT License

Copyright (c) 2021 Lexogrine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Eon provenance note：固定 revision 的 `package.json` 明确声明 `"license": "ISC"`，但该 revision 没有独立的 `LICENSE` 文件。下面的 ISC 文本是根据该 metadata 整理的标准许可参考，**不是该 revision 的 upstream exact notice**。本仓库当前代码只是 `maps-sleek` 的 presentation adaptation/reference，不携带 Eon runtime、图片资产或原始数据处理逻辑：

```text
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

M3MONs CS2-HUD MIT notice（固定版本 `LICENSE`）：

```text
MIT License

Copyright (c) 2023 M3MONs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## CS2 broadcast artwork

Program series-strip map scenes and CT/T side marks are Valve / Counter-Strike 2 game assets. They were retrieved from pinned community extraction repositories at the revisions recorded in [`broadcast-assets.json`](packages/cs2-assets/generated/broadcast-assets.json); that manifest records original and packaged SHA-256 values plus the thumbnail resize/encoding step. The extraction repositories are provenance sources, not the asset copyright holders. This notice does not claim Valve artwork is MIT-licensed or make a broader redistribution-rights determination.

- Scene thumbnails: [`MurkyYT/cs2-map-icons`](https://github.com/MurkyYT/cs2-map-icons), `images/thumbs/<map>_1_png.png`.
- CT/T marks: [`Juknum/counter-strike-icons`](https://github.com/Juknum/counter-strike-icons), `cs2/panorama/images/icons/ui/{ct,t}_logo_1c.svg`.

许可证参考：

- MIT: https://opensource.org/license/mit
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- OFL-1.1: https://openfontlicense.org/
- GPL-3.0: https://www.gnu.org/licenses/gpl-3.0.html
