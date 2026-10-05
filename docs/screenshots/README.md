# 当前画面预览

本页展示当前生产渲染器在浏览器中的效果。图像是示例画面，不是 Windows 实机或正式赛事的转播截图。

## 默认 HUD 与编辑器

![默认 HUD 预览](hud.png)

![HUD 编辑器](hud-editor.png)

HUD 使用编辑器的“示例比赛 → 实战 · 完整 5v5”与默认预设。局内选手/雷达来自真实采集派生样例，赛事图条与队名含独立 Rivals 展示资料；两者不代表同一场比赛。背景是静态 Ancient 地图缩略图，不是同步游戏视频。

## 半场与单图结果

![半场数据页](halftime.png)

![单图结果页](map-result.png)

这些页面来自节目预览的默认样例，调用实际节目渲染器；赛事名称、地图计划与统计用于展示版式，不作为真实赛果发布。

## 来源与重现

- 截取日期：2026-10-05。
- 产品源码：`5fd37023d5ff5c3e455e8b0a850ee190a946b9ba`；本次仅修改文档，未改渲染器。
- 环境：Linux、Chromium、Vite 开发预览，`VITE_VISUAL_FIXTURES=1`；未连接真实 CS2、OBS 或直播平台。
- 半场：`/program/halftime?preview=1&variant=default&background=map`。
- 单图结果：`/program/map-result?preview=1&variant=default&background=map`。
- HUD 编辑器：`/operator/hud`；HUD 单图直接截取 `.hud-console__canvas-frame`，没有重绘或修改画面内容。
- 节目页视口 1920×1080；编辑器视口 1920×1400。等待字体与内容加载后截取；样例源码见 [program/fixtures](../../apps/web/src/program/fixtures/)。

准备依赖与构建见[开发验证](../development-validation.md#本地运行)，再运行：

```sh
VITE_VISUAL_FIXTURES=1 pnpm --filter @mizar/web exec vite --host 127.0.0.1 --port 4173
```

浏览器检查覆盖页面加载、预览选择、HUD 编辑器、首页导航和错误记录；不证明自动切场或 Windows 制播流程通过。

## RC 后补充 Windows 实机图

先生成 RC，再在 [#35](https://github.com/Starfie1d1272/Mizar/issues/35) 实测时补图，记录 RC SHA/包摘要与环境：

- 完整桌面工作台：真实 CS2、左侧大雷达、比赛信息和下方制作控制。
- OBS 真实节目输出与工作台画面确认，验证私有控制不会进入播出。
- 实际 OBS 推流、B 站开播状态与正常/异常提示。
- 同场比赛的开场、HUD、半场与结果画面或短视频，以及拟发布 HUD 风格。

优先用同一场实际比赛形成连贯展示；避免暴露推流密钥、令牌、私人路径或无关窗口。真实截图补齐后可替换 README 示例，并保留来源记录。

## 文件记录

| 文件 | 像素 | SHA-256 |
| --- | --- | --- |
| `halftime.png` | 1920×1080 | `aa1ae6055160ea83467959860723fd2c6935586ecd080285d025ae830af20562` |
| `hud-editor.png` | 1920×1401 | `2e51279cb5ce0db9a48a2ed82ebb603a00d91a29c5238777d00ca3193321f1c4` |
| `hud.png` | 1444×812 | `375e5143503cb550e6cdf67a63b496e169caad02ac4c312f5df51c47f1bb2314` |
| `map-result.png` | 1920×1080 | `9f9c1a85d05df5a0dfa3418202bb3a38d657fc1a2815bf65c587bc86b309f19a` |
