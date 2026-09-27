# ADR-0001：项目定位与权威边界

- 状态：**Accepted**
- 日期：2026-09-12

## 背景

RivalHub 已拥有 Match、CompetitionEntry、Roster、BP、Schedule、Stage、官方赛果等赛事事实。现有 CS2 HUD/Manager 项目通常又维护一套本地 Team / Player / Match 数据，导致真实赛事中需要重复配置，并产生身份、比分和 BP 漂移风险。

同时，本项目需要承担 GSI、HUD、Radar、scene、临时统计、OBS 输出和本地诊断等低延迟工作；这些运行态不适合直接塞进 RivalHub 主站 domain。

## 决策

### 1. 独立仓库

Mizar 作为独立仓库和本地制播 runtime 演进，不作为 RivalHub Web 主仓中的一个页面模块。

### 2. 产品定位

项目定义为 **Mizar：面向 RivalHub 深度集成的 CS2 制播 Runtime**，而不是通用 HUD Manager。

Gameplay HUD 只是完整节目流程中的一个 scene。

### 3. Authority

```text
RivalHub
  = official tournament context / canonical truth

Mizar
  = local realtime observation / presentation runtime

DAK
  = post-match Demo evidence / analysis

OCR
  = platform-specific post-match evidence / fallback
```

Mizar 不建立第二套 Team / Player / Match / BP 官方数据库。

### 4. Integration

Mizar 只通过版本化 contract 与 RivalHub 集成，不直连 Supabase/生产表，也不 import RivalHub 内部页面或数据库实现。

RivalHub 主仓未来即使重构 Match Runtime，只要公开 integration contract 保持兼容，Mizar Core 不应随之重写。

### 5. Observation 与 Official Fact 分离

GSI / enhanced telemetry / local accumulator 产生的是 observation 和 provisional facts。

Mizar 可以发送 live projection、boundary event 和 result candidate；是否自动形成 canonical result，由 RivalHub 自己的 Match Runtime / reconciliation policy 决定。

## 后果

正面：

- 同一赛事事实只维护一次；
- Mizar 可以离线/本地优先；
- RivalHub 与 Mizar 可独立升级技术栈；
- GSI parser、renderer、OBS、桌面壳都能作为边缘适配器替换；
- Wrong Match 可以在 integration boundary fail closed。

代价：

- 必须认真设计并版本化 integration contract；
- 本地 runtime 要承担 cache、identity resolution、reconnect 和 diagnostics；
- 不能通过“直接读写主站数据库”快速绕过协议设计。

## 本 ADR 没有决定

- Node/Bun；
- Fastify/其他 HTTP server；
- 一个还是两个物理 WebSocket；
- Electron/Tauri/普通 launcher；
- BroadcastManifest 具体字段；
- 网站使用 SSE/WebSocket/Realtime；
- server game event adapter；
- LHM compatibility。

这些内容后续单独决策。
