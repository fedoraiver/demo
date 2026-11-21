# Agent Note: 原生 BRP 应用验收

Status: implemented — 已按菜单、设置、物理、镜头和日志分设真实窗口验收入口。

## Problem

菜单、设置、物理、镜头和日志需要在真实窗口中分别验收，并各自保存可核对的证据。设置保存验收需要验证真实 TOML 的写入，并在退出后恢复用户原始配置。

## Decision

用默认关闭的 `acceptance-test` feature 注册 Bevy 原生 BRP。主程序继续沿用原窗口入口，验收时只在主世界提供远程协议。五个脚本按对应文档子项运行和出具证据。普通游戏与调度导出保留检查器，验收构建省去检查器及 Egui 上下文。

## Changes

[验收接入](../../architecture/acceptance.md)注册脚本所需的原生类型。客户端匹配本次子进程的 PID，沿游戏输入与 Picking 消费路径驱动，按截图实体匹配像素事件并编码 PNG。

[应用验收](../../testing/app-acceptance.md)为各类别的独立脚本定义验收编号。每个脚本记录已执行的子项和可追溯证据，设置脚本在本次进程退出后核对写出的真实 TOML，再恢复原文件状态。[检查器验证](../../testing/inspector.md#世界检查器验收)维护检查器及 F3 专项。

## Alternatives considered

[Bevy 原生 BRP](https://github.com/bevyengine/bevy/tree/v0.20.1/crates/bevy_remote)已能传输原生输入与截图事件。项目镜像及专用 RPC 会增加与原状态之间的同步点。共用场景减少单次启动次数，但共享前置状态会使无关检查随一处失败而停止。

## Consequences

独立脚本需要各自启动进程。主世界固定监听端口，验收脚本串行执行。应用使用用户实际设置文件，设置备份记录与报告目录无关，遇到不明变更时保留备份。图片只作为实际帧的捕获证据，帧间连续性及呈现性能仍需相应采样。

## Verification

持续验证入口和测试范围见[测试指南](../../testing/README.md#自动化启动准备)。五类场景各自的可执行条件、待实现条件和证据要求以[应用验收](../../testing/app-acceptance.md)为准。运行环境和执行结果记录在各类别报告及本次交付记录。
