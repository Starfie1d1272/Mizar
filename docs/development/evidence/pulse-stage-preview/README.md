# Pulse 阶段标签视觉预览（未合并）

源码提交：`87408dbe6ea2667b522b55d2aa24d1f907b12f2d`。基于 main `383707a35a84b9bef035c91df200990fc0a33c2b`，保留全部已完成 OBS 修复。隔离分支 `preview/pulse-stage-label`；不合并、不发布、不操作用户 Windows。

只调整默认 Pulse 的比分条上方标签。沿用现有字体与颜色，不加卡片、不改变队名或本图比分区域；其他四套 HUD 的样式未修改，渲染条件仅适用于 current。

## 来源边界

截图由真实 Chromium 页面渲染：1920×1080 全画面、880×160 比分条裁图。暂停仓库内 Inferno 视频在 8 秒作为视觉背景，叠加显式合成的 HUD 数据；背景、雷达和游戏事实未同步，不作为真实比赛/OBS 捕获证据。

网站当前仅提供 stageLabel，没有赛前胜负战绩。PLAY-IN 的 1–0/0–0 是明确 preview fixture 的共同赛前 record，渲染器没有接通战绩链，没有把系列胜场/当前图比分当赛前战绩；仅显示一份，不带 R2。中文/未知阶段只显示原阶段，不补 MATCH；缺资料本地比赛不显示标签或虚构 0–0。

长阶段限定在比分条宽度内，以省略号结尾，DOM/title 保留完整名称。完整数据契约、轮次分类与真实战绩输入等待父任务调查，本分支不抢先实现或合并。

## 图集

| 场景 | 全画面 | 比分条 |
|---|---|---|
| playin-10 | [1920×1080](playin-10-full.png) | [880×160](playin-10-score.png) |
| playin-00 | [1920×1080](playin-00-full.png) | [880×160](playin-00-score.png) |
| bo3 | [1920×1080](bo3-full.png) | [880×160](bo3-score.png) |
| semifinal | [1920×1080](semifinal-full.png) | [880×160](semifinal-score.png) |
| third-place | [1920×1080](third-place-full.png) | [880×160](third-place-score.png) |
| grand-final | [1920×1080](grand-final-full.png) | [880×160](grand-final-score.png) |
| long | [1920×1080](long-full.png) | [880×160](long-score.png) |
| unknown | [1920×1080](unknown-full.png) | [880×160](unknown-score.png) |
| local-missing | [1920×1080](local-missing-full.png) | [880×160](local-missing-score.png) |

## 核验

- 九种场景：单份阶段标签，水平居中，在比分条上方且没有越过画布顶部；0–0、BO3 的当前图比分和系列方块互不挤占。
- 长中文队名的可见文本槽与系列方块，两侧各保留 24px 间距；长阶段截断，无布局溢出。几何结果见 [geometry.json](geometry.json)。
- Web 类型检查、修改文件 lint/format、30 项既有展示/fixture 测试、完整 design:check 通过。
- 此为视觉讨论；不证明网站完整字段链、Windows/OBS 或真实直播通过。

复现：在仓库根运行 `VITE_VISUAL_FIXTURES=1 pnpm --filter @mizar/web exec vite --host 127.0.0.1 --port 4197`，再运行本目录 `capture.mjs`（须已有 Playwright Chromium）。

## PNG SHA-256

- `bo3-full.png` `fa03eff9ac72e0e91996742bee92099eec44ce095b56024884fe74537cf7f30a`
- `bo3-score.png` `8f7cf26f9db9d12c20affc2a411aa74adbc45db3a9676ff66f2b3e9294b09b62`
- `grand-final-full.png` `48bda27ed8fd07ab56a9d843c49323d924f73180f3fce4b0285d46736dc8ae91`
- `grand-final-score.png` `7ec300ec0f78ea72ab972b2ac298dd285f584cbba2e33a54350377f947618c6c`
- `local-missing-full.png` `d43e0b9dac181a1a1b278e99fa426842f130e1a5ff009927f0488fd0d1e8d530`
- `local-missing-score.png` `bf73077b2951fffc3b1826a1fdfb864752f4c062e06d46c7951c4ad0f7cba8f5`
- `long-full.png` `f4584b7be37abab0b7de8a8be0c1d0103a79c5b5e6229ceb9e9a65e784ac45ad`
- `long-score.png` `e7a53aa8fb19e809e350c0592290f1b5e1ad17244efd6da009052aebba1ab502`
- `playin-00-full.png` `cd406430768c8f56281840d16089fbbc4d9ba5cb632f427c517931a14847bc5f`
- `playin-00-score.png` `b898ede391c55ba2675a3256fdd1071f479494595e9780815dd48cb3b9a5b110`
- `playin-10-full.png` `63ae0535057dc9a8ae7318f13a1d33c5c907e9aa56722015c226b86f73d25819`
- `playin-10-score.png` `8a9121d82f6c13660c03e92ed33ce1fcda8527cb2435cbd20c3e58f6b4e3b5e9`
- `semifinal-full.png` `e721669219ef3c4fcc9fdcb55268542574bd5e2d5af31658fdcf333738992171`
- `semifinal-score.png` `6d951a9df02b3735d173cc52b75bfaa6a65cb54b78af2238cb37ea7de7049c19`
- `third-place-full.png` `aa5eddf62fb9510809f925b41c59af38275e58ea0524566069a829e8b1f89d8d`
- `third-place-score.png` `5477cca8ee5178ea01b6d5e342acf72633ee6825ada79981e0ccf80cd3c5b3c2`
- `unknown-full.png` `dbafd8829b6b09661d367425dff94e51b1f5d2a1739cae9d89248710a46cff47`
- `unknown-score.png` `f4a81563d1f0a2db9a9478ff248d1ec04996967005a189089c89ae5b891d380a`
