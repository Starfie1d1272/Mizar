# ADR-0007：Gameplay HUD presentation invariants

- 状态：**Accepted**
- 日期：2026-09-23
- 关联：Issue #66、PR #73、ADR-0003、ADR-0004

## 背景

Default V1 的视觉收敛经历了多轮布局、Radar、多楼层、Player Rails、Focused Player 与 Objective 方案试验。大量中间方案只用于寻找合适的视觉结构，不应成为长期设计规范；但其中暴露出的若干失败模式会直接破坏数据 ownership、状态稳定性或后续可维护性。

本 ADR 只冻结这些长期 presentation invariant 与已验证的反模式。颜色、字体、材质、装饰、具体品牌语言和其它纯美术选择仍可继续演进。

## 决策

### 1. 物理位置按 entrant 稳定，side 只改变状态

Default gameplay 中 entrant A 保持左侧物理位置，entrant B 保持右侧物理位置。半场换边只改变 CT/T accent 与 side-bound facts，不让两支队伍在画面上交换位置。

不得再用“左边固定 CT、右边固定 T”的 presentation ownership。

### 2. 状态变化优先替换内容，不改变外框几何

alive / dead、avatar present / missing、freezetime / live、objective / pause 等状态应在固定 component envelope 内切换内容。

不得因为头像缺失、summary 隐藏、死亡态或 objective 状态改变外框尺寸，亦不得让上游 transient block 推动下游 player card baseline。

### 3. 镜像只属于 layout，不复制组件结构

左右 Player Rail 使用同一套 presentation model 与同一套 PlayerCard 结构，通过 physical-side layout 镜像。

不得维护 left/right 两套不同 DOM 或业务逻辑；视觉差异不能演化为两套 semantic implementation。

组件内部同样遵循这一约束：physical side 显式决定队名、倒计时、剩余次数、装备栏位与外侧色边的位置，gameplay side 只决定阵营事实和颜色。外框换侧不代表内部已镜像；使用同一 DOM 的命名 grid area 交换栏位，不依赖父级 RTL 或整块 `scaleX(-1)`。枪械朝向只在素材叶节点处理，文字、头像和库存组不翻转；底板、C4 预测等独立形状仍可按自身几何镜像。浏览器验收检查左右内部坐标、色边与可见武器的实际翻转次数。

### 4. 一项事实只有一个主要视觉 owner

Top Score、Series Strip、Player Rails、Focused Player 与 Radar 可以共享同一 Program truth，但不应为了“信息更满”重复显示同一事实。

alive 时优先显示仍能影响当前回合的战术信息；dead state 可以把稳定统计提升为主要信息。Focused Player 只强化当前 POV 的独有信息，不复制完整 team/inventory 面板。

Team Summary 的经济信息属于回合开始决策上下文：freezetime 完整显示，并在进入 live 后保留 5 秒；剩余道具属于持续战术信息，live 回合中常驻显示。live 道具总数只聚合当前存活且 weapons evidence 可用的选手；life state 或存活选手 inventory 证据不完整时 fail closed。

### 5. Transient presentation 使用预留 slot，不参与重排

Team Summary、timeout、objective progress、alive XvY 等 transient presentation 必须使用已经预算的稳定区域，显示/隐藏不能导致其它核心组件跳位。

### 6. Radar 只有一套坐标 owner

`packages/radar` 的 canonical world-to-overview calibration 是唯一坐标真值。Web Renderer 可以做 presentation viewport / composition，但 map artwork、player、C4、utility 与 transient 必须共享同一 transform。

C4 的 Radar presentation 保持单一主要视觉 owner：`carried / planting` 通过 carrier player marker 的 objective 色表达，不再在选手圆点旁追加第二个 C4 图标；`dropped / planted` 才使用独立 world-space C4 marker。阵营方向箭头继续保留 side 色，objective ownership 不覆盖 side identity。

明确不采用：

- alpha-bound 扫描后把地图裁紧再重新标定；
- upper/lower floor 各自独立缩放；
- 为视觉拼接建立第二套 entity 坐标；
- 地图 artwork 与 marker 使用不同 crop/scale。

多楼层的具体美术编排可以继续调整，但不能破坏上述 invariant。

### 7. Motion 不拥有 gameplay time，urgency 必须局部化

动画只消费已经存在的 semantic state / progress。Browser 不重新推算 objective countdown，也不因为视觉效果建立第二个 timer owner。

明确不采用整张卡片、整条比分条或整颗 C4 长时间高幅 pulse / blink。Planting 使用中性 presentation；planted / critical urgency 只在有证据的状态下通过局部颜色、轨道或小面积 motion 表达。Reduced-motion 必须可以稳定关闭这些 motion。

### 8. 官方素材进入受控 asset pipeline

能够从 CS2 官方资源获得的 map、side、weapon、equipment、ammo presentation asset 优先进入 `@mizar/cs2-assets`，保留 source/hash/provenance。

不得为了短期视觉方便把来源不明的手工近似素材直接变成长期 canonical asset。

### 9. 正常验收场景优先来自真实 capture replay

正常 Program/HUD acceptance fixture 应尽量从 committed capture 经 production adapter → Runtime → Projection 生成。Synthetic fixture 只用于真实 capture 难以稳定覆盖的 edge / presentation stress，并显式记录 reason。

不得用手工构造的“看起来合理”正常比赛状态替代已有真实 evidence。

Public-match real-derived capture 保留原始 Steam64、GSI player display name 和 team/clan name。Capture sanitizer 只清除凭据、本机/私有 endpoint、绝对本机路径与机器特有元数据。头像和队标是独立 presentation enrichment：必须按稳定 identity/name 关联并记录本地 asset hash 与来源；素材缺失时保持 unavailable，不生成近似身份素材。Steam Web API enrichment 仅在开发期一次性导入，Replay 与 CI 离线消费其结果。

## 已验证但不冻结为美术规范的探索

以下内容曾用于 Default V1 探索，但不形成长期 invariant：

- EWC 的具体颜色、材质、切角、字体比例与装饰；
- 某一次 Nuke lower-floor 的具体偏移或 footprint；
- dead watermark 的具体造型；
- observer endcap 的具体轮廓；
- 某一轮 avatar/body 百分比；
- 某一版 map tone、outline、trail weight。

这些可以在后续美术设计中直接重做，只要不破坏上面的 ownership、geometry stability 与 truth boundary。

## 后果

### 2026-10-04：赛事预设的暂停编排

EWC / IEM / Perfect World 的已保存比分方案决定固定 1920×1080 画布内的暂停组合；这是一种预先预算的 Gameplay presentation mode，不写回 Layout、不发起 OBS Take。普通组件与紧凑暂停组合共用现有 Program presentation joins，原版保持现有 envelope。左右暂停附加信息按 entrant A/B 映射；映射不可证明时保持中性，不能把 CT 固定当左队。暂停使用竖向历史，冻结使用横向历史；两者复用已证明的历史数据并表达未知原因、历史空缺和加时分组。五秒展示窗口只属于 presentation 生命周期，倒计时仍直接消费 accepted clock；seek/revision 与 source/map boundary 使窗口重置。

后续美术设计可以大幅调整视觉语言，而不需要重新讨论 Runtime、Program truth、entrant mapping、Radar calibration 或 fixture provenance。

如果未来确实需要改变上述 invariant，应先说明新的产品或技术证据，并通过新的 ADR supersede 对应范围，而不是在 CSS 调整中隐式改变。
