# Agent Note: 原生玩家设置持久化

Status: implemented

## Problem

原生设置插件外的 TOML 回读与保存事务重复访问配置文件。为测试切换文件的 `SettingsFile` 也让游戏和持久化验收走了不同路径。

## Decision

由 Bevy 原生插件管理玩家设置的读写。范围约束在反序列化时按字段处理，越界时记录警告并使用对应默认值。

## Changes

[GameSettingsPlugin](../../../../src/settings/mod.rs) 注册设置类型并安装原生插件。FPS 使用保留整数格式的反射类型，使 Bevy 的逐字段加载能经过 Serde `try_from`。音量和相机使用各自的转换保留同组有效值。[菜单请求](../../../../src/ui/requests.rs)应用设置后提交原生保存命令。

## Alternatives considered

通过回读确认落盘并按结果回滚，要求应用层继续维护一套文件事务。Bevy 原生保存命令已经负责写入、替换及错误记录。

## Consequences

`Settings applied.` 确认运行设置已生效。保存失败由 Bevy 写入会话日志。同一用户的各 worktree 共用配置，持久化测试脚本负责在测试进程退出后恢复原始文件或恢复原本缺失的状态。

## Verification

无窗口测试覆盖字段反序列化、越界警告、合法同组字段保留、限帧和菜单应用。真实配置的写入、回读与恢复留给后续 automation 测试脚本。[设置测试](../../../testing/settings.md)
