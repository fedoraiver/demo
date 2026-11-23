# 世界检查器

源码入口见 [inspector/](../../src/inspector/mod.rs)。

`demo-inspector` 在自己的入口装配窗口、玩法插件和检查器。[启动命令](../../README.md#运行) · [应用装配](game_flow.md#应用装配)

`InspectorPlugin` 在默认插件后安装，内部先注册 `EguiPlugin`，再注册受 `gameplay_running` 门控的 `WorldInspectorPlugin`。检查器复用主窗口和当前相机，在 `EguiPrimaryContextPass` 直接反射 ECS 世界，不维护数据镜像。该 pass 由 `PostUpdate` 内的 Egui 驱动，可在一帧中运行多轮，不是 `PostUpdate` 之后另一个逐帧主 Schedule。

插件的 Startup 记录表示已注册，不代表主菜单显示面板。检查器仅在游戏运行时显示，主菜单与暂停时隐藏。

## 输入与反射

检查器已装配时，F3 切换游戏控制和检查器操作，面板保持显示。游戏控制期间，主 Egui 上下文停止键鼠及输入法转发，恢复捕获时清除 Egui 遗留的光标位置。释放捕获后恢复转发。[鼠标捕获](first_person.md#鼠标捕获与输入归属) · [切换前的操作约束](../player-guide.md#世界检查器)

检查器的编译配置启用玩法诊断反射。Bevy 自动注册玩法组件、鼠标捕获、菜单、设置草稿及会话日志元数据对应的派生反射。检查器直接查看和编辑当前 ECS 世界，包括 `MouseLookState` 的捕获标志。实体关系的反向索引由 Bevy 关系钩子维护。[验收反射接入](acceptance.md) · [设置持久化](settings.md#设置草稿与持久化)
