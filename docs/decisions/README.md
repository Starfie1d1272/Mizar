# 架构决策记录

ADR 保存长期决定的背景、取舍和演变。当前规则从[架构](../architecture.md)进入，历史记录不作为第二份操作手册。

## 维护规则

- 状态使用 Proposed、Accepted、Superseded、Rejected，分别表示提出、接受、被替代与拒绝。
- 一篇聚焦可以独立演进的一组决定，记录理由与代价。
- 改变已接受决定时新增 ADR，明确替代范围；非语义勘误显式标记，不静默改写历史。
- 依赖精确版本以依赖声明与锁文件为准，同一技术路线的兼容更新通常不另写 ADR。
- 当前文档漂移时修正文档；研究参考不能覆盖已接受决策。

## 决策索引

- [ADR-0001：项目定位与权威边界](0001-project-positioning-and-authority.md)
- [ADR-0002：运行时与工作台技术基线](0002-runtime-workspace-technology-baseline.md)
- [ADR-0003：运行状态、身份与投递约束](0003-runtime-state-delivery-invariants.md)
- [ADR-0004：正式节目与观察辅助隔离](0004-program-output-and-observer-assist-isolation.md)
- [ADR-0005：产品能力边界与第一方集成可移植性](0005-product-capability-boundaries-and-portability.md)
- [ADR-0006：独立模式与 RivalHub 连接模式](0006-local-independent-and-rivalhub-connected-modes.md)
- [ADR-0007：局内 HUD 展示约束](0007-gameplay-hud-presentation-invariants.md)
- [ADR-0008：基于 Web 的便携产品与运行目录](0008-portable-web-product-runtime.md)
- [ADR-0009：BP 全屏播出场景、本地制作与播放会话](0009-bp-presentation-host.md)
- [ADR-0010：制播工作台桌面承载](0010-broadcast-workspace-desktop-host.md)
- [ADR-0011：Mizar 自有输入与结构化实时输出](0011-owned-input-and-structured-output.md)
- [ADR-0012：设计系统文档、源码职责与验证边界](0012-design-system-governance.md)
- [ADR-0013：HUD 受控组件定制](0013-hud-widget-customization.md)
- [ADR-0014：桌面准备中心与现场生命周期](0014-desktop-preparation-center.md)
- [ADR-0015：桌面启动诊断与恢复](0015-desktop-startup-diagnostics-and-recovery.md)
- [ADR-0016：有界支持包](0016-bounded-support-export.md)
- [ADR-0017：自动节目编排与有界场景展示](0017-program-direction-and-presentation.md)
- [ADR-0018：共享雷达展示包与双端适配](0018-shared-radar-view.md)
- [ADR-0019：制作提示与平台直播状态](0019-production-guidance-and-platform-status.md)
- [ADR-0020：正式节目中的 C4 站立伤害预测](0020-c4-standing-prediction.md)

ADR-0003 对 ADR-0002 第 5 节的通用事件表述和第 6 节的跨仓职责范围作出替代；原始理由与具体范围见对应正文。

## 历史澄清

### 2026-09-17：雷达职责

ADR-0003 中早期的插值和自动缩放宽泛表述，已澄清为：雷达领域拥有确定性、无状态的几何与投影；时间插值、平滑、跳变重置和自动聚焦动画属于展示层。这不改变领域与渲染分离的决定，详细原始理由见 ADR-0018。

### 编号勘误

C4 预测曾与制作提示同时使用 0019，现编号 0020。只修正索引身份，不改变决定或表示重新决策。
