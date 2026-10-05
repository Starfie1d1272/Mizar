# ADR-0020：Program-safe C4 站立伤害预测

> 编号勘误：原与“制作提示与平台直播状态”同为 0019，现独立编号 0020；决策内容与历史语义未变。

状态：接受。对应 #52，固定消费 cs2-c4-damage@0.1.0。

Companion 按当前地图加载并校验内置 field，缓存最多两张地图；Core 创建并复用 standing predictor，并只消费当前 Program-safe runtime 与同代 active lineup。浏览器不导入算法或地图场。结果为独立 bombDamage derived set，随当前 Program snapshot 发布，不进入 Objective timer 状态机，不扩展外部 LiveSnapshot 或 Radar。

只允许 fresh、当前 accepted sequence / generation / mapEpoch、当前活人和完整位置/朝向/HP/炸弹输入。异步资源返回只触发当前上下文重新投影，不保存旧快照预测。换图、回合结束、断流、重连时当前投影立即不可用。预测包括 availability/reason、逐人 eligibility、站立估算、模型与资源身份；不覆盖 observed HP，不提前宣告死亡。

Program schema 升为 8；配色和开关仍由 HUD 配置 owner 管理。预测默认开启，独立纹理覆盖当前血量，支持关闭、保存和重载。内置 maps 与 NOTICE/CREDITS 通过普通生产依赖进入 portable app，安装后逐图加载验证。Windows/CS2/OBS 实机验收归 #35。
