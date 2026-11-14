# 设置架构

源码入口见 [settings/](../../src/settings/mod.rs)。

## 设置草稿与持久化

保存设置前校验与序列化完整 `GameSettings`，然后在根 `tmp/settings-save/` 写入唯一临时文件、同步并关闭句柄，再用 `rename` 替换目标文件。替换失败时保留原文件并清理临时产物；临时文件与设置及会话日志各自管理。菜单步进范围不收紧 JSON 的有效范围，打开设置保留有效自定义值，实际调整相应字段后才进入菜单范围。

音量的 `SetVolume` 只更新草稿，`FinishVolumeEdit` 在释放且数值改变时汇总反馈。读取边界专门忽略旧配置的 `audio.sfx_volume`，当前运行资源与保存文件包含总音量和 UI 音量。其他未知字段仍报错。字段、默认值、步进与缺省兼容见 [设置](../player-guide.md#设置)。

## 渲染限帧

渲染限帧与 [固定模拟](game_flow.md#时钟与运行条件) 分别管理。`SettingsPlugin` 将 `WinitSettings` 的前台与后台模式统一设为 `UpdateMode::Reactive`，以 `1 / max_fps` 为近似更新间隔，关闭设备、用户与窗口事件触发的提前更新；输入缓冲到下一次更新。计时、等待和超时处理由 Bevy 原生窗口循环负责，启动与生命周期切换可强制更新，不保证任意相邻帧的严格最小间隔。`AutoNoVsync` 独立控制呈现方式，仍可能被平台回退。

`PrototypeConfig` 与设置字段 `SettingKey` 分别归属 [prototype.rs](../../src/settings/prototype.rs) 和 [draft.rs](../../src/settings/draft.rs)；角色、物品、场景和 UI 消费这些数据契约。
