# 上海 / 类 Perfect World HUD 展示参考包

解压后直接双击 `index.html`。不需要安装 Node、启动 Mizar 或后端，也不会访问网络。预览使用 Mizar 的实际 React renderer 和固定 Program/Radar 样本；计时不会自行推进。可切换实战、下包、拆包、阵亡、冻结期、暂停、头像和低血量状态。C4 呼吸动画遵循系统的减少动态效果设置。

`preview.css` 是实际合并样式，`markup/` 是相同 renderer 生成的 DOM 示例，`fixtures.json` 是预览使用的展示样本。页面也支持导出当前 DOM 和数据。颜色、字体、几何和左右镜像规则保留当前实现；不要翻转整张选手卡，只翻转武器图标叶节点。默认画布为 1920×1080。

`source/` 保存对应源码用于阅读和移植，不是可直接独立编译的 npm 包。构建时仅为离线预览将资源路径改为相对路径，字体和 SVG 蒙版内嵌以适配本地文件浏览；生产代码保持原样。远程队伍 Logo/头像会回退为空，本地头像和合成展示头像随包提供。真实比赛样本与 Rivals BP 的组合是视觉验收输入，不代表同一场赛事。

Vue 移植可以按这些位置对应：

| Vue 展示组件      | Mizar 源码                                                                     |
| ----------------- | ------------------------------------------------------------------------------ |
| RoundInfo         | apps/web/src/program/widgets/match-header/TopScoreBar.tsx、ObjectiveCenter.tsx |
| PlayerCard        | apps/web/src/program/widgets/player-rails/PlayerCard.tsx                       |
| CurrentPlayerCard | apps/web/src/program/widgets/focused-player/FocusedPlayer.tsx                  |
| Radar             | packages/radar-view/src、apps/web/src/program/widgets/radar/adapter.ts         |
| 上海专属样式      | apps/web/src/program/designs/perfectworld/                                     |
| 颜色与布局        | packages/hud-config/src/presets/perfectworld.ts                                |

先对照 `markup/` 和 CSS 搭建自己的 Vue template，再用自己的数据 adapter 接入；不要复制 Mizar 的实时连接或将固定样本当作数据 SDK。`.mizar-hud.json` 仅用于 Mizar 预设导入，不能独立渲染。雷达实际画面由 Canvas 绘制，HTML 示例不能替代其绘制实现。

代码沿用根目录 `LICENSE` 的 AGPL-3.0；第三方来源和资源许可见 `THIRD-PARTY-NOTICES.md`、随附字体 OFL。赛事风格是非官方参考。分享与复用请保留这些文件。`manifest.json` 记录源提交、是否包含未提交修改及每个文件的 SHA-256。

仓库内重建：先运行 `pnpm build`，再运行 `node scripts/hud-reference/build-perfectworld.mjs [输出目录]`。构建需要 `zip` 和可用的 Playwright Chromium（可用 `CHROMIUM_PATH` 指定），输出目录默认 `.agent-tmp/hud-reference`。

如果浏览器或企业策略禁止访问本地文件，在解压目录执行 `node serve-preview.mjs`，然后打开终端打印的本机地址。这只是静态文件预览，不连接 Mizar 后端。构建环境的 Chromium 策略禁止 `file://`，因此自动化检查使用本机 HTTP；已检查全部场景与资源加载，没有外部网络请求。
