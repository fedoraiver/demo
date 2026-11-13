# 设置架构

源码入口见 [settings/](../../src/settings/mod.rs)。

## 设置草稿与持久化

`GameSettingsPlugin` 注册 `GameSettings` 的反射类型，再安装 Bevy 原生 `SettingsPlugin`。Bevy 在构建阶段加载 `game` 设置组。范围校验由字段的 Serde 转换负责，越界值回退到对应默认值并记录警告。

`Apply` 校验草稿后更新运行中的 `GameSettings`，再提交 `SaveSettingsSync::Always`。Bevy 同步保存并记录写入错误。音量的 `SetVolume` 只更新草稿，`FinishVolumeEdit` 在释放且数值改变时汇总反馈。配置路径、默认值和菜单步进见[设置](../player-guide.md#设置)。

## 渲染限帧

渲染限帧与 [固定模拟](game_flow.md#时钟与运行条件) 分别管理。`GameSettingsPlugin` 将 `WinitSettings` 的前台与后台模式统一设为 `UpdateMode::Reactive`，以 `1 / max_fps` 为近似更新间隔，关闭设备、用户与窗口事件触发的提前更新；输入缓冲到下一次更新。计时、等待和超时处理由 Bevy 原生窗口循环负责，启动与生命周期切换可强制更新，不保证任意相邻帧的严格最小间隔。`AutoNoVsync` 独立控制呈现方式，仍可能被平台回退。

`PrototypeConfig` 与设置字段 `SettingKey` 分别归属 [prototype.rs](../../src/settings/prototype.rs) 和 [draft.rs](../../src/settings/draft.rs)；角色、物品、场景和 UI 消费这些数据契约。
