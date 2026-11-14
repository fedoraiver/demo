# 世界检查器

源码入口见 [inspector/](../../src/inspector/mod.rs)。

`InspectorPlugin` 在默认插件后安装，内部先注册 `EguiPlugin`，再注册受 `gameplay_running` 门控的 `WorldInspectorPlugin`。检查器复用主窗口和当前相机，在 `EguiPrimaryContextPass` 直接反射 ECS 世界，不维护数据镜像。该 pass 由 `PostUpdate` 内的 Egui 驱动，可在一帧中运行多轮，不是 `PostUpdate` 之后另一个逐帧主 Schedule。

插件的 Startup 记录表示已注册，不代表主菜单显示面板。检查器仅在游戏运行时显示，主菜单与暂停时隐藏。

## 输入与反射

F3 在游戏控制与检查器操作之间切换，检查器在两种模式下均保持显示，游戏模拟继续运行。游戏模式通过主上下文的 `EguiContextSettings.input_system_settings` 关闭键鼠与输入法转发，捕获切换清除 Egui 的遗留光标位置；检查器模式恢复转发并停用玩法上下文。切换前结束输入手势的约束见 [世界检查器](../player-guide.md#世界检查器)。Esc 通过菜单动作进入暂停。

玩法组件、`PrototypeConfig` 和相机状态注册 Bevy 反射元数据，让检查器直接访问 ECS 数据。实体关系组件不开放反射修改，反向索引由 Bevy 的关系钩子维护；鼠标捕获状态不开放反射编辑。检查器编辑仅影响内存中的本次会话。
