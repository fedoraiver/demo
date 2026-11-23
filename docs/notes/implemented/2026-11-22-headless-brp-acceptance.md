# Agent Note: 无窗 BRP 应用验收

Status: implemented

## Problem

[原生 BRP 应用验收](2026-10-29-app-automation.md)依赖桌面窗口、焦点与玩家的配置文件。脚本动作可能与桌面交互相互干扰，普通音效也会从当前设备输出。现有游戏用例需要在独立进程中驱动真实玩法、读取状态并获取渲染证据。

## Decision

默认关闭的 `acceptance-test` feature 在游戏入口启用无窗验收。保留 Bevy 逻辑主窗口与游戏插件，使用离屏图像承接菜单与玩法相机的实际渲染。普通游戏与调度导出继续走各自的窗口和检查器装配。

## Changes

[验收接入](../../architecture/acceptance.md)将合成窗口的鼠标指针映射到离屏目标，保留键鼠动作、Picking、正常退出和截图事件的原生 Bevy 路径。这次迁移继续使用当时的五个脚本及其 25 个既有编号。原生窗口机制归[窗口策略](../../testing/window_policy.md)。“配置帧率上限”由设置和日志用例核对，游戏画面由离屏 PNG 记录。[应用验收](../../testing/app-acceptance.md)

各脚本使用独立设置目录，保留 Bevy TOML 读写及验收恢复流程。Kira 的 `UiTrack` 在验收时使用零输出增益，沿用音效加载、排队、播放和混音逻辑。设置隔离和截图接口见[验收接入](../../architecture/acceptance.md)。

音频方案后来更新为[验收启动音量](2026-11-22-acceptance-startup-volume.md)。

## Alternatives considered

隐藏真实窗口仍需桌面后端，省去渲染器会缺失游戏画面。离屏图像保留实际渲染，需要兼容的渲染适配器并将 Picking 指针与相机指向同一个目标。虚拟音频设备会引入设备选择和路由依赖，Kira 输出轨静音可以直接保留项目内音频流程。

## Consequences

无交互桌面的环境可运行游戏验收。窗口边界、系统焦点、DPI、原生最大化及屏幕呈现由对应专项覆盖。Kira 仍初始化默认设备，静音由进程内轨道增益实现。会话报告保留 PID、设置目录、视口及证据文件。

## Verification

[测试指南](../../testing/README.md#自动化启动准备)维护构建与运行入口。检查范围包含离屏目标、BRP 反射传输、设置隔离和目前的脚本化子项。每次执行的实际结果随验收报告和进程输出记录。[应用验收](../../testing/app-acceptance.md#当前驱动范围)
