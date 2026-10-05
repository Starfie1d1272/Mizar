# Mizar Pulse 实际渲染复核

本轮按用户提供的定稿评审重做现有默认 Gameplay；前版基准是 PR #124 的 `b2b739b`，而非最初的 `7b2896d`。图 1–4 按四套内置视觉 EWC、IEM、Perfect World、ESL 对照；用户粘贴文件未含四张图片原文件，因此这里重新渲染仓库已有四套 renderer，不宣称复原了外部原图。

## 核对条件与证据

所有截图统一 Chromium、1920×1080、同一 Program 投影、Steam 头像与 Ancient 地图缩略图背景。Radar 使用同一 dense-utility 记录辅助核对图形，不是与当前回合同步的雷达录制。live / freeze / pause / death / technical 来自真实回放提取的 Program fixture；满装备、长英文昵称与中文混合昵称是布局边界合成样例。截图关闭非必要动效，单独浏览器断言检查目标动画与 reduced motion。未执行真实 Windows / CS2 / OBS 验收。

| 画面 | 新版 | 上一版与新版 | 五套同条件 |
| --- | --- | --- | --- |
| Live | [原尺寸](mizar-native/pulse/current-live.webp) | [前后](mizar-native/pulse/compare-live.webp) | [五套](mizar-native/pulse/five-live.webp) |
| Freeze | [原尺寸](mizar-native/pulse/current-freeze.webp) | [前后](mizar-native/pulse/compare-freeze.webp) | [五套](mizar-native/pulse/five-freeze.webp) |
| Pause | [原尺寸](mizar-native/pulse/current-pause.webp) | [前后](mizar-native/pulse/compare-pause.webp) | [五套](mizar-native/pulse/five-pause.webp) |
| 多人死亡 | [原尺寸](mizar-native/pulse/current-death.webp) | [前后](mizar-native/pulse/compare-death.webp) | [五套](mizar-native/pulse/five-death.webp) |

另有 [Focus 裁切](mizar-native/pulse/current-focus.webp)、[满装备](mizar-native/pulse/current-full-equipment.webp)、[长英文](mizar-native/pulse/current-long-names.webp)、[长中文/中英文混合](mizar-native/pulse/current-long-zh.webp)、[技术暂停](mizar-native/pulse/current-technical.webp)、[左右选手卡原尺寸裁切](mizar-native/pulse/current-cards.webp)。参考单套原尺寸截图与上一版原尺寸截图保存在同目录。

## 四套参考的取舍

| 参考 | 吸收 | 不采用 |
| --- | --- | --- |
| EWC / 图 1 | 强比分、左右阵营区分、统一状态轮廓 | 大白斜切、每张卡独立形状装饰 |
| IEM / 图 2 | 五人固定行位、紧凑清晰的武器和数字、规整镜像 | 整列饱和蓝色块与纯列表感 |
| Perfect World / 图 3 | stacked cards 的成熟骨架、身份/战斗分层、死亡收面减重 | 完全中性的灰黑模板；不复制其正文/头像尺寸 |
| ESL / 图 4 | 字体读数的品牌力度、材质、明暗节奏与状态强化 | 绿色主调、大头像和高躁度纹理；不把定妆照优势当布局优势 |

Mizar 自身语言由连续深黑蓝壳、冷白读数、蓝能量前沿、暖金节点与短脉冲组成。比分从白盒转为深色连续核心；侧栏从浅色战斗带转为深壳亮字和武器，不增加更多独立信息盒。头像贴合边端，小圆角收外轮廓，死亡仍固定原行。Focus 降至 72px，暂停和历史用同一深壳扩展。

## 人工检查结果

已查看 Live、暂停、多人死亡、长英文、中文混合及满装备截图。比赛数字、姓名和当前武器没有被纹理遮盖；地图队标保留完整 22px 槽；雷达默认外框调整为 368px 正方形，底部 y=484 距统计行 y=492 保留 8px，避免经济/道具统计被覆盖；Focus 弹药区增宽至 72px，两行数字上下至少 8px 留白；长昵称按既有策略省略，比分队名可换行。原五人行位、CT/T 事实换边、目标安全区和旧 Focus 外框仍由自动断言覆盖。静态对照可以核对造型与层级，不代替真实视频中扫读和动效的人工验收。

[雷达与统计间距裁切](mizar-native/pulse/current-radar-spacing.webp) 与 [Focus 弹药留白裁切](mizar-native/pulse/current-focus.webp) 是本轮用户追评后的实际渲染。

## 设计系统 PR 检查

- 属于播出画面；产品和诊断界面不改色。
- 复用既有字体、resolved Theme、renderer、配置开关和 Program/Radar owner；无新共享 React 组件。
- 九个新值按统一变量层级定义，明确服务默认 Gameplay 的固定美术；不新增运行时颜色入口或用户主题。
- 字体、危险/目标/阵营语义留在既有 Theme；四套参考文字状态色冻结。
- 无新交互控件，键盘/焦点边界不变；新增 reduced motion 与事实目标模式动画断言。
- 截图只使用 Program-safe 资料；无 Assist 资料，不改 projection 或比赛精度。

自动验证结果在 PR 中记录，真实环境验收仍未完成；不将截图或自动检查通过写成审美已获用户认可。

## 本轮自动验证

最终单元测试 1288 通过、2 个既有跳过；workspace 构建、类型检查、lint、格式检查通过，最终 web 构建通过。`design:check` 的 100 项契约与 13 项浏览器组件样例通过。全浏览器回归首次 58/59 通过，诊断导出状态等待超时；之后连同最终 10 项默认 HUD 检查一起复跑，14/14 通过，未修改诊断导出实现。最终雷达定位和动效另有 2/2 检查通过。截图生成用临时脚本，已移出验收目录。
