# @mizar/radar-view

Mizar 与网站共用的 React Canvas 雷达。只接收已投影数据，不连接比赛服务，不计算赛事事实。支持玩家、C4、双层地图、投掷物轨迹、烟雾、效果时间和投影后的火焰；观察编号、闪光、伤害和射击等本地增强信息可选。

## 安装与资源

生产消费者固定精确版本与 lockfile。审查未发布版本可正常安装 PR 构建的 tarball：

```sh
# Mizar 根目录
pnpm --filter @mizar/radar-view... build
node scripts/radar-view/pack.mjs /tmp/radar-package

# RivalHub / 独立 consumer
pnpm add --save-exact /tmp/radar-package/mizar-radar-view-0.1.0.tgz
```

包只有 React 19 peer；不需要 `@mizar/core`、protocol、私有 workspace 包或源码 alias。包版本与 wire schema 独立；不兼容展示 API 提升 minor（1.0 前），兼容修复提升 patch。正式发布后用 `@mizar/radar-view@精确版本` 替代 tarball。审查 artifact 应同时记录 git SHA 与 tarball SHA-256，不把同名可变文件当作版本锁定。

将安装包的 `dist/assets/` 整个目录复制到网站静态目录，例如 `public/vendor/radar/0.1.0/`。保留内部 `assets/cs2/...` 路径。`dist/radar-provenance.json`、`dist/icon-provenance.json` 与 `dist/THIRD-PARTY-NOTICES.md` 记录来源和 hash。资源包由现有 cs2-assets pipeline 产生，不热链第三方。

```tsx
import { RadarView, fromPublicRadar } from '@mizar/radar-view';
import '@mizar/radar-view/radar.css';

const frame = fromPublicRadar(live.radar, {
  boundary: JSON.stringify([
    live.matchId,
    live.delivery.authorityRevision,
    live.delivery.generation,
    live.delivery.epoch,
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
/>;
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

## npm 发布

统一通过 `scripts/radar-view/pack.mjs` 从已构建产物生成干净 tarball：只保留公开包元数据、React peer、ESM/声明、CSS、资源、README 与许可证，删除构建专用 devDependencies 和生命周期脚本。不要直接对 workspace 目录执行 `pnpm pack` 或 `npm publish`。CI 的独立 consumer 与发布流程使用同一打包入口；发布前验证的 tarball 原样上传，不再次打包。

首次发布需要维护者拥有 npm 包 scope 的权限。仓内名称不证明拥有 npm 的 `@mizar` scope；若无权限，先统一改为实际控制的 scope，再构建和验证。不要在聊天中提供密码、OTP 或 token。

首次建包：从当前通过 CI 的 `radar-view-<SHA>` artifact 下载并解压，在自己的终端执行：

```sh
sha256sum --check SHA256SUMS # macOS 可用 shasum -a 256 -c SHA256SUMS
npm login
npm publish ./mizar-radar-view-0.1.0.tgz --ignore-scripts --access public --tag latest
```

首次发布完成后，在 npm 包 Settings → Trusted publishing 添加 GitHub Actions：

- Owner：`Starfie1d1272`；Repository：`Mizar`。
- Workflow filename：`publish-radar.yml`。
- Environment：`npm-publish`。
- 启用 **Allow npm publish**（仅允许 stage publish 无法执行本流程）。

后续发布修改包版本、通过完整 CI，再创建并推送 `radar-view-v<package.version>` 标签。`.github/workflows/publish-radar.yml` 使用 GitHub-hosted runner、Node 24、固定 npm 12.2.0 与 OIDC，无长期 NPM_TOKEN；生成 provenance。它校验标签和包版本完全相符，并要求该精确提交最近一次 push/PR CI 成功；重新执行外部安装、类型与 production build 验证后发布。稳定版本使用 `latest`，预发布版本使用 `next`。失败需先修复原因再重跑；已经发布的版本不可覆盖，内容变化必须升版本。

标签发布不要求合并 PR，也不会合并 PR。普通 PR CI 只上传安装包，不执行 registry 写入；首次人工发布的 0.1.0 不要再次用标签重复发布。仓库管理员可对 `radar-view-v*` 设置 tag ruleset 以限定发布者。npm 发布与 Mizar 桌面发行版独立。
