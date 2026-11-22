# 设置架构

源码入口见 [settings/](../../src/settings/mod.rs)。

## 设置草稿与持久化

`GameSettings` 及其字段类型始终派生反射，供 Bevy 原生 `SettingsPlugin` 加载和保存。Bevy 自动注册反射类型，设置插件在构建阶段加载 `game` 设置组。范围校验由字段的 Serde 转换负责，越界值回退到对应默认值并记录警告。

`Apply` 校验草稿后更新运行中的 `GameSettings`，再提交 `SaveSettingsSync::Always`。Bevy 同步保存并记录写入错误。音量的 `SetVolume` 只更新草稿，`FinishVolumeEdit` 在释放且数值改变时汇总反馈。配置路径、默认值和菜单步进见[设置](../player-guide.md#设置)。

灵敏度草稿保存原始输入文本和未修改时的角速度。切换分类保留未完成文本，应用其他字段时沿用未修改的角速度。有效的新值按 `0.01` 单位量化后换算为配置中的弧度/像素。

## 渲染限帧

渲染限帧与[固定模拟](game_flow.md#时钟与运行条件)分别管理。普通游戏安装默认插件，再在有 `RenderApp` 时安装 `bevy_framepace` 的 `FramepacePlugin`。前台和后台均使用 Winit 连续更新模式，由插件在渲染清理阶段控制帧间等待。呈现方式由 `AutoNoVsync` 请求，平台可采用回退方式。

`GameSettingsPlugin` 将生效的 `max_fps` 转换为帧间隔，写入 `FramepaceSettings.limiter`。菜单应用设置后，帧间隔在固定循环之前同步，供插件在同一帧的 `Update` 阶段读取。渲染侧通过共享值接收目标间隔，线程调度或锁竞争可能推迟新间隔的采用。[无窗验收](acceptance.md)由 `ScheduleRunnerPlugin` 驱动，保留帧率配置与初始化日志供验收核对。

`PrototypeConfig` 与设置字段 `SettingKey` 分别归属 [prototype.rs](../../src/settings/prototype.rs) 和 [draft.rs](../../src/settings/draft.rs)；角色、物品、场景和 UI 消费这些数据契约。
