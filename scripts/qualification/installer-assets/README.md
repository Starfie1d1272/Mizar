# 安装器素材

双星来自 `apps/web/public/brand/mizar-mark.svg`，保持原比例与颜色；背景使用设计变量 `color.pulse` 的 canvas、raised 和 blue。素材为本项目自有图形，沿用 AGPL-3.0-only，无新增字体或第三方图片。

`wizard.svg` 与 `header.svg` 是可编辑源，嵌入原标志；BMP 是构建输入，分别以 MUI2 标准槽位 164×314、150×57 的三倍尺寸导出为 24 位 RGB。MUI2 的 `FitControl` 在实际 DPI 下缩放图片，文字始终由原生向导绘制。两张 BMP 共约 1.6 MiB，进入 NSIS LZMA 压缩，不复制到安装目录。

重新导出可用 CairoSVG 2.9.1 与 Pillow 12.3.0；这是素材制作工具，不是构建或产品依赖。为兼容 CairoSVG 的 SVG 1.1 引用，在内存中把 `href=` 换为 `xlink:href=`（SVG 根已声明该命名空间），以三倍尺寸渲染，再以 Pillow `convert('RGB').save(..., format='BMP')` 导出。更新 `sources.json` 中所有修改文件及原标志的摘要和大小。正式构建使用已提交 BMP，不在 CI 重新栅格化。

视觉验收与单次截图记录在 Issue / PR；来源与输入摘要由 `sources.json` 和安装包分发清单跟踪。
