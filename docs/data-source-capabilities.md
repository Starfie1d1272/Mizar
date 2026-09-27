# 数据源与功能能力矩阵

本文定义 Mizar 在不同比赛数据源条件下的**功能边界、降级方式和正式运行方案**。它主要回答：

> 当前拿到什么数据源时，HUD、Radar、制播工作区、网站实时数据、`ProgramCue` 和 Observer Assist 分别能做到什么？

本文是数据源能力的统一说明。具体的数据解析、连续性和证据规则继续由 `docs/telemetry.md` 定义；Program / Assist 隔离继续由 ADR-0004 定义。

关联：Issue #86、ADR-0004、RFC-0001。

---

## 1. 当前优先服务的真实环境：完美平台直连 GOTV

当前需要优先完整服务的真实赛事环境，是完美平台后台生成的直连 GOTV（Direct GOTV）观战地址，例如：

~~~text
connect 101.35.25.49:27026;password 1
~~~

当前赛事运营经验中，同一场比赛会提供一对地址：

~~~text
较早 / 无延迟地址
  例如 ...25

Program / 解说地址
  例如 ...26
  约 120 秒观战延迟
~~~

后台直接复制出来的通常是较早地址；过去的实际流程是由有后台权限的工作人员把端口加一后，再把延迟地址发给解说。

这些端口关系属于**完美平台当前的部署和地址派生规则**，不是通用 CSTV 协议规则。后续若自动派生地址，应把它放在完美平台专用配置中，并允许高级设置手动覆盖。

### 1.1 直连 GOTV 与 HTTP 广播流不是同一种输入

~~~text
直连 GOTV
  connect IP:port;password ...
  → CS2 观战客户端

HTTP 广播流（HTTP Broadcast）
  http(s)://.../
  → HTTP 分片读取
  → 例如 cs2parser HttpBroadcastReader
~~~

只有直连 GOTV 的 `IP:port` 时，**不能据此推导或假定存在 HTTP Broadcast URL**。

因此，当前 `cs2parser` 的 `HttpBroadcastReader` 是可选的数据源适配方式，不是完美平台 Program V1 的运行前提。

---

## 2. 完美平台 Program V1：以 GSI 为主

当前正式 Program 数据链路确定为：

~~~text
完美平台延迟 GOTV
        ↓
真实 CS2 观战客户端
        ↓
CS2 GSI
        ↓
Broadcast Runtime
├─ ProgramProjection
├─ RadarFrame
├─ 制作控制 / 制播工作区
├─ 本机 Program / OBS
└─ RivalHub 公开实时数据
~~~

这里的“实时”表示 Mizar 收到 Program GSI 后立即更新；它仍然跟随约两分钟延迟的 Program 时间轴。

因此，公开网站如果消费同一份 Program-safe（可公开播出的 Program）数据：

- 与 OBS 和解说当前看到的比赛时间轴一致；
- 不会提前泄露无延迟比赛结果；
- 后续若需要真正无延迟的后台比赛事实，应使用单独的数据源能力，不能从 Program GSI 假装获得。

---

## 3. 能力状态

本文使用四种状态：

| 状态 | 含义 |
| --- | --- |
| **基础可用** | 当前运行方案能够可靠提供，属于 V1 正常能力 |
| **增强可用** | 有额外精确事件数据源时提供；缺失时不影响主产品 |
| **保守降级** | 精确信息缺失时，使用已有且证据充分的较低信息量展示 |
| **当前不可用** | 当前运行方案没有足够信息，默认关闭，不进行猜测 |

---

## 4. 当前功能能力矩阵

| 产品能力 | 完美平台 Program V1：27026 → CS2 → GSI | Program + 精确事件增强 | 后续 Lookahead | HTTP Broadcast 数据源 |
| --- | --- | --- | --- | --- |
| 地图 / 比分 / 回合 / 阶段 / 时钟 | **基础可用** | 基础可用 | Program 侧基础可用 | 取决于是否同时提供 Program 状态数据 |
| 10 人有效阵容 / Steam64 / 阵营 / 观察位 | **基础可用** | 基础可用 | Program 侧基础可用 | 由解析能力和数据提供方决定 |
| HP / 护甲 / 头盔 / 钳子 / 金钱 / 装备价值 | **基础可用** | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| 武器 / 弹药 / 当前武器 | **基础可用** | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| K/A/D / 回合击杀 / 爆头 / 回合伤害 | **基础可用** | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| ADR / 回合伤害累计 | **基础可用** | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| Radar 玩家位置 / 朝向 | **基础可用** | 基础可用 | Program Radar 继续使用 GSI | 不是当前完美平台 V1 路径 |
| Radar C4 | **基础可用** | 基础可用 | Program Radar 继续使用 GSI | 不是当前完美平台 V1 路径 |
| Radar 手雷 / 烟 / 火 | **基础可用** | 基础可用 | Program Radar 继续使用 GSI | 不是当前完美平台 V1 路径 |
| C4 携带 / 掉落 / 下包 / 已下包 / 拆包 | **基础可用** | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| 下包 / 拆包 / 爆炸计时 | **基础可用** | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| 致盲 / 烟雾 / 燃烧状态 | **基础可用** | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| 通用掉血残影 | **基础可用**：来自连续 GSI HP 变化 | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| 死亡提示 | **基础可用**：来自连续 GSI 存活状态 | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| 低血量提示 | **基础可用** | 基础可用 | Program 侧基础可用 | 不是当前完美平台 V1 路径 |
| HE 专属命中特效 | **保守降级**：使用通用受伤反馈 | **增强可用** | 精确事件数据源可提供 | 精确事件数据源可提供 |
| Zeus 专属命中特效 | **保守降级**：使用通用受伤反馈 | **增强可用** | 精确事件数据源可提供 | 精确事件数据源可提供 |
| 狙击枪专属命中特效 | **保守降级**：使用通用受伤反馈 | **增强可用** | 精确事件数据源可提供 | 精确事件数据源可提供 |
| 精确 `player_hurt`：攻击者 / 武器 / hitgroup | **当前不可用** | **增强可用** | Lookahead 事件数据源可提供 | 可用时进入 `GameEventObservation` |
| 精确 `player_death`：助攻 / modifiers | **当前不可用** | **增强可用** | Lookahead 事件数据源可提供 | 可用时进入 `GameEventObservation` |
| `weapon_fire` / 原生手雷 / C4 事件 | **当前不可用** | **增强可用** | Lookahead 事件数据源可提供 | 可用时进入 `GameEventObservation` |
| `FutureKillCue` / Observer Assist | **当前不可用** | 当前不可用 | **目标能力** | 只有存在独立的较早时间轴时才成立 |
| 公开网站 Program-safe 实时数据 | **基础可用**，跟随 Program 延迟时间轴 | 基础可用 | future 信息仍禁止公开 | 取决于公开 Projection 的数据来源 |

---

## 5. 为什么 HUD / Radar V1 不依赖 Program CSTV

当前代码依赖审计结论如下。

### Radar

Radar 的玩家、C4、手雷、烟火、位置和朝向来自 Program GSI / Runtime Projection。当前 Radar Renderer **不订阅 Program CSTV 实时 GameEvent**。

因此，完美平台没有 HTTP Broadcast 地址时，Radar 主能力不受影响。

### HUD 主体

以下能力来自 GSI / Runtime：

- Top Score Bar；
- Player Rails；
- HP、护甲、金钱、武器和道具；
- K/A/D、ADR、回合伤害；
- C4 状态和目标计时；
- 致盲 / 烟雾 / 燃烧；
- 掉血残影；
- 死亡提示；
- 低血量提示。

### `ProgramCue`

当前 `ProgramCue` 是独立的短时增强通道。现有用户可见的直接消费主要集中在 HE / Zeus / 狙击枪三类武器专属命中特效。

因此：

~~~text
Program 比赛数据正常
+
精确事件增强未启用
=
Program 仍然正常
~~~

制作控制和制播工作区不能把“精确事件增强未启用”显示成“比赛数据故障”。

---

## 6. GSI 降级边界

允许：

~~~text
HP 80 → 43
→ 显示通用受伤反馈

alive → dead
→ 显示死亡提示
~~~

因为这些语义可以直接由 Program 当前状态证明。

禁止：

~~~text
附近 HE 消失 + 某人掉血
→ 猜测 HE 命中

某人当前拿 AWP + 另一人掉血
→ 猜测狙击枪命中
~~~

这类推断在多人交火、切枪、范围伤害和同一采样窗口多事件时会制造错误事实。

原则：

> 能可靠证明较低信息量的事实时做保守降级；无法证明精确事件类型时关闭精确增强。

---

## 7. 四种长期运行方案

### 方案 A：完美平台 Program V1

~~~text
27026 直连 GOTV
→ 真实 CS2 观战客户端
→ GSI
→ Program
~~~

这是当前 V1 的正式生产方案。

### 方案 B：Program + 精确事件增强

~~~text
27026 直连 GOTV
→ 真实 CS2 观战客户端
   ├─ GSI → Program 状态
   └─ 可选精确事件适配器 → ProgramCue
~~~

未来可以由 HLAE、其它可信事件适配器或数据提供方事件接口补充精确事件。它属于增强能力，不重新成为 Program 是否可用的前提。

### 方案 C：后续 Lookahead

~~~text
27026
→ Program CS2 / GSI
→ Program

27025
→ 无头 Direct CSTV 客户端
→ Lookahead GameEventObservation
→ 时间轴对齐
→ ObserverAssistProjection
~~~

目标仍然是只运行一个承担 Program 画面渲染的 CS2。

**无头 Direct CSTV 客户端后续新建独立仓库研发和维护。** 本仓库不实现 Direct CSTV 网络协议本身，只保留：

- Lookahead 数据源接入边界；
- `GameEventObservation`；
- 数据源角色、连接世代和健康状态；
- Program ↔ Lookahead 时间轴对齐；
- `ObserverAssistProjection` 和 Observer Assist 产品能力。

独立仓库成熟后，通过明确的版本化接口接回 Mizar。其研发进度不阻塞 Mizar V1、制播工作区、Program HUD 或 Radar。

### 方案 D：HTTP Broadcast 数据源

~~~text
HTTP Broadcast URL
→ packages/telemetry-cstv
→ cs2parser HttpBroadcastReader
→ GameEventObservation
~~~

该方案继续服务真正提供 HTTP Broadcast 的数据提供方，也可以用于离线验证、现场验收参考和未来兼容。

---

## 8. Program 与 Lookahead 的安全边界

无论底层接入方式如何变化：

- Lookahead 的未来事件证据不进入 `ProgramProjection`；
- Lookahead 不进入公开网站的 Program-safe 实时数据；
- Lookahead 不能作为 Program 的备用数据源；
- Program 精确事件增强与 Lookahead 事件数据源使用不同的数据源角色；
- Program 精确事件增强故障只移除对应短时特效；
- Lookahead 故障只关闭 Observer Assist。

这些边界由 schema / Projection 保证，而不是靠 CSS、OBS 裁剪或窗口位置保证。

---

## 9. 产品与诊断用语

状态页应优先表达制作人员真正关心的能力：

~~~text
比赛数据        正常
Radar           正常
播出画面        正常
事件增强        未启用
观察辅助        未启用
~~~

不要因为某个可选 CSTV 事件数据源未配置，就把整个 Program 显示成黄色或红色故障。

---

## 10. 后续研发边界

Mizar V1 / 制播工作区继续完成：

- Program HUD / Radar；
- Gameplay / BP / 赛前 / 赛中 / 地图结束 / 比赛结束工作区；
- OBS 预设；
- 本机 Program Overlay；
- 网站 Program-safe 实时数据。

Lookahead 作为独立后续能力推进；无头 Direct CSTV 客户端在**新的独立仓库**研发。Mizar 侧后续只负责：

- 接入独立客户端输出；
- 时间轴对齐；
- `FutureKillCue`；
- Observer Assist。

两条路线通过既有 `GameEventObservation` 以及数据源角色、连接世代和健康状态边界汇合，不要求制播工作区为 Lookahead 重构。
