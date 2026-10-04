# ADR-0018：共享雷达展示包与双端适配

- 状态：Accepted
- 日期：2026-10-03
- 关联：#117、ADR-0002、ADR-0007、ADR-0011

## 决策

`@mizar/radar` 继续唯一拥有 world → overview 坐标、楼层选择、地图支持与 calibration revision。新增 `@mizar-hud/radar-view` 拥有归一化坐标上的 Canvas、插值、缩放、楼层编排、标记、烟雾、火焰和局部效果。它不读取 Raw GSI、Runtime、LocalChannelClient、HUD registry 或 RivalHub 内部状态，不建立联网、身份或比赛事实 owner。

Mizar Web 的 adapter 用既有 geometry API 投影本地 RadarSnapshot，再把已知的观察编号、HP、闪光、武器和运动证据作为可选展示信息提供。公共 consumer 直接使用 LiveSnapshot 的 overview 坐标、facing、utility、effectTime 和 flames；缺失本地增强字段不妨碍显示，不反算 world position，也不要求伪造本地 envelope。公共输入不是玩家和 C4 的最低共同子集。

`RadarViewFrame` 是展示接口，不是新 wire schema。它的 boundary、sequence、可选 sampleSequence 来自 host 已完成接收校验的数据。Host 拥有 freshness、authority、wrong-match 和 old-source 判定；null 清理，paused 冻结最后已接受画面，presentationRevision 明确重置。公共 2 Hz lane 不冒充连续 GSI sequence。共享模型限制历史、轨迹、外推和集合大小；unknown/null 不补造当前位置。Mizar 的本地 stationary effect / death anchor 保留策略由适配器显式选择，公共明确缺失位置清理。

地图和图标继续由 `@mizar/cs2-assets` 唯一生成。展示包在构建时从既有 domain 与 asset owner 生成小型展示 manifest：资源路径、calibration revision、楼层和已投影的展示半径；不包含 world origin、z threshold 或 world projection runtime。资源按原 content hash 校验并复制进 npm 产物，附 provenance、LICENSE 与第三方 notices。Host 显式指定 `assetBaseUrl`，可部署在网站子路径或 CDN。

包使用独立 semver，标准 ESM + declaration + CSS + assets 产物，只以 React 为运行时 peer。内部 workspace 包只作为构建依赖，不进入消费端运行图。Mizar 安装同一 workspace 包；外部网站通过普通 registry 版本或固定 tarball 与 lockfile 安装，不用源码 alias、跨仓 deep import 或 workspace 链接。发布本身独立于 PR，不在 PR 验证中自动 publish。干净 tarball 不含 workspace 构建依赖或生命周期脚本；独立 consumer 验证与 npm 发布使用同一打包入口。专用 radar-view 版本标签触发 OIDC 发布，要求精确提交 CI 成功，校验版本后仅发布已安装验证的 tarball；首次 npm scope/建包权限由维护者配置，具体操作见包 README。

## 验证与边界

本地真实 capture 衍生回归覆盖 utility、烟雾、火焰、轨迹、死亡、射击和回放重置；公共 contract 测试覆盖既有 wire fixture、2 Hz 插值、重复/乱序、代际与楼层变化、缺失位置和不兼容地图。独立临时项目实际安装 tarball，检查声明、ESM、SSR 与 assets；提供可对 RivalHub 实际 `projectPublicLive` 运行的最小 consumer 验证。

提取完成不代表 RivalHub 整个公开 Live 页面完成，也不替代 Windows + CS2 + OBS 的真实环境验收。发布渠道、后续网站布局与连接策略仍由各自 host 管理。

类ESL 作为可选 appearance 仅调整地图原色、标记、烟火与 C4 装饰脉冲。参考方向/开火图案随包复制并附来源，不替换 cs2-assets 地图/游戏图标 owner，不新增输入事实或协议。字体由 host 的类ESL 样式本地加载。
