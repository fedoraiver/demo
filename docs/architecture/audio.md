# 音频运行时架构

源码入口见 [audio/](../../src/audio/mod.rs)。

## 声音请求与播放

`SoundRequest` 连接声音事件与播放端。当前 UI 发送 `MenuHover / MenuConfirm / MenuCancel`。真实焦点变化产生悬停反馈，集中请求入口只对已接受的语义操作发送确认或返回反馈。音量拖动期间合并采样，在释放且数值改变时汇总确认。

`GameAudioPlugin` 安装 Kira，管理音频加载、播放、混音与设备输出。当前菜单声音通过 `UiTrack` 接入。Mix 处理加载错误、选择有效混音并同步实例增益，Playback 消费请求并处理退出。跨功能顺序见[调度与模拟边界](game_flow.md#调度与模拟边界)。排队实例计入并发限制；当前菜单事件的冷却使用 `Time<Real>`，暂停期间仍能反馈。

## 音量预览与混音

UI 在 Style 阶段发布 `AudioPreview.settings`，设置页分类切换保留预览，离页时清空。音频功能读取预览及 `GameSettings.audio`，当前 UI 通道的有效增益为默认基准增益 × 素材清单音量 × Master 音量 × UI 音量；正在播放和排队的实例均同步当前增益。零增益使用 `Decibels::SILENCE`，静音请求不占冷却与并发，恢复后不补播。主入口禁用 Bevy 内建音频，设备输出统一由 Kira 管理。

新增素材、事件与通道的接入要求，以及制作、来源与检查入口见 [音频管线](../assets/audio/README.md)，无窗口检查见 [音频验证](../testing/audio.md#音频无窗口验证)。

事件与素材映射见[声音事件](../assets/audio/events.md)。
