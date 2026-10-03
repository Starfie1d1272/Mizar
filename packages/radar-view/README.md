# @mizar/radar-view

Mizar 与网站共用的 React Canvas 雷达。只接收已投影数据，不连接比赛服务，不计算赛事事实。支持玩家、C4、双层地图、投掷物轨迹、烟雾、效果时间和投影后的火焰；观察编号、闪光、伤害和射击等本地增强信息可选。

## 安装与资源

生产消费者固定精确版本与 lockfile。审查未发布版本可正常安装 PR 构建的 tarball：

```sh
# Mizar 根目录
pnpm --filter @mizar/radar-view... build
npm pack ./packages/radar-view --ignore-scripts --pack-destination /tmp/radar-package

# RivalHub / 独立 consumer
pnpm add --save-exact /tmp/radar-package/mizar-radar-view-0.1.0.tgz
```

包只有 React 19 peer；不需要 `@mizar/core`、protocol、私有 workspace 包或源码 alias。包版本与 wire schema 独立；不兼容展示 API 提升 minor（1.0 前），兼容修复提升 patch。正式发布后用 `@mizar/radar-view@精确版本` 替代 tarball；此 PR 不执行 registry publish。审查 artifact 应同时记录 git SHA 与 tarball SHA-256，不把同名可变文件当作版本锁定。

将安装包的 `dist/assets/` 整个目录复制到网站静态目录，例如 `public/vendor/radar/0.1.0/`。保留内部 `assets/cs2/...` 路径。`dist/radar-provenance.json`、`dist/icon-provenance.json` 与 `dist/THIRD-PARTY-NOTICES.md` 记录来源和 hash。资源包由现有 cs2-assets pipeline 产生，不热链第三方。

```tsx
import { RadarView, fromPublicRadar } from '@mizar/radar-view';
import '@mizar/radar-view/radar.css';

const frame = fromPublicRadar(live.radar, {
  boundary: JSON.stringify([
    live.matchId, live.delivery.authorityRevision,
    live.delivery.generation, live.delivery.epoch,
  ]),
  sequence: live.delivery.sequence,
  current: acceptedAndAvailable,
  bomb: live.bomb,
});

<RadarView
  snapshot={frame}
  paused={status === 'stale'}
  presentationRevision={reconnectRevision}
  assetBaseUrl="/vendor/radar/0.1.0"
/>
```

父容器提供雷达尺寸（通常为正方形）。`assetBaseUrl` 也可为 `https://cdn.example/radar/0.1.0`。CSS 独立导入，保留宿主控制权；颜色可通过 `--mizar-side-ct`、`--mizar-side-t`、`--mizar-hud-objective-bomb` 覆盖，缺失时使用原雷达默认值。组件默认响应 `prefers-reduced-motion`，也可显式传 `reducedMotion`。Canvas 只读，无键盘焦点或禁用操作；连接提示、加载失败说明与文字替代内容由页面提供。

## 数据与连续性

- `fromPublicRadar` 接受结构兼容的 LiveSnapshot/public Live 雷达，不依赖协议包。坐标、facing、楼层、火焰均直接复用，未提供的本地字段保持缺失。
- 网站传顶层 `bomb` 以保留 carried/planting 的单一视觉 owner；没有状态时只显示已有位置，不猜倒计时。
- `current` 来自 host 的接收/新鲜度判断。`null` 清理；`paused` 冻结已接受画面及临时效果时间，不继续外推。初次挂载即 stale 时保持空画面，直到合法 fresh baseline。
- reconnect、seek 或 host 接收边界变化时增加 `presentationRevision`。比赛、authority、generation、epoch 放进 `boundary`；地图及 calibration revision 另外自动参与重置。不兼容资源 calibration fail closed。
- 本地高频 consumer 可使用 `RadarViewSource` 同步订阅最新 frame，无需每个 tick 触发 React 重绘。`getSnapshot()` 在值未变化时应返回同一引用；不积压历史。
- 公共默认采样间断阈值 1500 ms，容纳 2 Hz lane；最多外推 100 ms。页面的 stale deadline 仍由页面判断。可通过 `sampleGapMs` 按实际采样周期配置。
- 原始公共 null 位置不会由旧位置修补。本地 adapter 可显式开启已建立烟雾/死亡 anchor 的保留行为。公开没有速度时显示有位置的 utility，不伪造速度。

## 可复现验证

```sh
pnpm --filter @mizar/radar-view... build
node scripts/radar-view/consumer-smoke.mjs ../RivalHub
```

脚本在 workspace 外新建临时项目，用 npm 安装 tarball，检查 ESM、严格 TypeScript 声明、SSR、utility/flames 和打包地图。传入 RivalHub 路径时直接执行其当前 `projectPublicLive`，并用其真实 `PublicLiveMatchProjection` 类型编译 [最小组件](examples/RivalHubRadar.tsx)。不修改 RivalHub。省略路径时 CI 使用 producer 的已提交契约 fixture。
