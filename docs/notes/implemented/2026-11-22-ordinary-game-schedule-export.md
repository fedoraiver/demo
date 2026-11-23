# Agent Note: 普通游戏调度导出与入口参数

Status: implemented

## Problem

[应用入口拆分](2026-11-22-app-entrypoints.md)提供了普通游戏与检查器两种调度图，正式架构图只需普通游戏的调度。四个应用入口已有固定启动方式，用户要求删除帮助入口。

## Decision

调度导出使用普通游戏装配。正式架构提取使用固定的导出构建配置，检查器继续由独立应用启动。普通游戏、检查器和 BRP 验收采用无参数启动，调度导出要求 `--output <directory>`。

## Changes

各入口删除帮助参数分支，参数错误在装配 Bevy 前返回。[架构提取](https://github.com/fedoraiver/demo/blob/054f6fdf596d2f6b4c9c0ce9ce6999250e28da4f/tools/rustc-analysis/runner/src/host.rs)与[快照校验](https://github.com/fedoraiver/demo/blob/054f6fdf596d2f6b4c9c0ce9ce6999250e28da4f/docs/diagrams/src/debugdump-input.mjs)使用相同的普通游戏配置。后续装配归属见[应用入口装配与外部验收工具](2026-11-22-app-assembly-and-acceptance.md)。

## Alternatives considered

保留检查器导出需要继续维护独立构建组合、快照验证和架构图展示约定。固定普通游戏配置可从导出入口直接确定所用装配。

## Consequences

当时同一 Cargo 构建同时选择多个包会合并共享库的 feature，导出器在初始化前拒绝混入诊断的配置。后续的独立编译见[四个应用独立装配](2026-11-22-independent-apps.md)，导出命令见[调度导出边界](https://github.com/fedoraiver/demo/blob/054f6fdf596d2f6b4c9c0ce9ce6999250e28da4f/docs/diagrams/maintenance.md#调度导出边界)。

后续的启动参数约定见[移除应用入口的参数检查](2026-11-22-remove-app-argument-checks.md)。

## Verification

在 Windows 实跑普通导出，核对 `debugdump` 构建配置、主应用与渲染子应用调度及 DOT 哈希。四个程序的无效参数与导出器的混合诊断配置均在初始化前返回错误。无参数验收启动通过原有五套 BRP 用例，并验证共享设置恢复。架构工具回归覆盖普通快照校验、导出入口选择与图表展示。
