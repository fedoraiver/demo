# Agent Note: Bevy 原生日志装配

Status: implemented

## Problem

应用用项目插件包裹 Bevy 日志，维护独立的文件队列、控制台队列、会话元数据和退出操作。保留每次启动的独立日志文件和原有格式只需要接入文件输出。

## Decision

使用 `DefaultPlugins` 中的 Bevy `LogPlugin`。通过 `custom_layer` 接入同步文件输出，目录、文件命名和结构化格式沿用现有约定。

## Changes

[共享文件层](../../../apps/log_file/mod.rs)为三个入口准备独立日志文件。原有项目日志插件、后台队列、会话反射资源、启动及退出专用记录和自定义 panic hook 已删除。[无窗日志验收](../../testing/app-acceptance.md#会话日志)从驱动记录的子进程输出核对业务事件，正常关闭使用进程退出码。

## Alternatives considered

使用 Bevy 默认日志输出并由调用者重定向终端，可进一步精简程序，但每次启动的独立日志依赖启动方式。保留后台写入则继续承担队列、线程关闭和异常刷新逻辑。

## Consequences

文件层加锁同步写入，磁盘延迟会传给日志调用方。目录或文件无法创建时启动失败。写入错误在 stderr 报告。原生 panic 处理输出到终端。

## Verification

[日志验证](../../testing/session_log.md)覆盖独立启动文件隔离、原有格式、终端与文件过滤和业务初始化日志。无窗日志验收覆盖配置、场景装配及正常关闭。
