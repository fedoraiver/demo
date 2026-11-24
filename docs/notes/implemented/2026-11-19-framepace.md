# Agent Note: 渲染帧节奏插件

Status: implemented

## Problem

项目用 Winit 的更新间隔控制渲染帧率。帧间等待需要由帧节奏插件按渲染进度处理，现有设置继续提供帧率上限。

## Decision

在 Bevy 0.20.1 上采用 `bevy_framepace` 0.23.0。项目只负责将设置转换为目标帧间隔，帧间等待由插件管理。

## Changes

[设置模块](../../../src/settings/mod.rs)在固定循环之前同步运行设置，让插件读取本帧菜单应用的帧率。渲染限帧的装配、时序与窗口行为见[设置架构](../../architecture/settings.md#渲染限帧)。

## Alternatives considered

Bevy 已将帧节奏插件合入主线，项目锁定的发布版是 0.20.1。直接切换到主线需要一起核对现有插件的版本约束。 [Bevy PR #26392](https://github.com/bevyengine/bevy/pull/26392)

## Consequences

升级到包含 `bevy::render::framepace` 且与项目插件兼容的 Bevy 稳定版时，用内置模块替换当前插件依赖。上游实现将插件留给窗口入口显式装配，仍在主应用 `Update` 同步设置，在 `RenderSystems::Cleanup` 限帧。项目迁移时沿用 `Limiter::Manual` 的整数纳秒换算、Winit 前后台连续更新及现有呈现策略，继续由验收 runner 驱动无窗入口。[上游插件源码](https://github.com/bevyengine/bevy/blob/1c4460b102a6a4380319455051c0e4c6051708a6/crates/bevy_render/src/framepace/mod.rs#L46-L82) · [上游示例](https://github.com/bevyengine/bevy/blob/1c4460b102a6a4380319455051c0e4c6051708a6/examples/window/framepace.rs#L13-L26)

## Verification

无窗口测试检查帧间隔映射、同帧设置同步与固定模拟时步。前后台实际帧率沿用[窗口验收](../../testing/settings.md#窗口验收)。
