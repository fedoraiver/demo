# Agent Note: 应用入口装配与外部验收工具

Status: implemented

## Problem

[应用入口拆分](2026-11-22-app-entrypoints.md)用可执行目标区分窗口游戏、检查器、无窗验收和调度导出。各入口的应用构建仍集中在共享库。验收还依赖[独立工具](2026-11-22-portable-bevy-acceptance.md)的仓库内快照和 Demo 专用的相机标记插件。

## Decision

按运行用途在 `apps/` 下构建 Bevy `App`，应用用同一套玩法插件组，窗口类入口复用普通窗口配置。无窗入口直接依赖验收工具远程仓库的 `master`，并注册默认 UI 相机所需的工具标记。

## Changes

普通游戏的入口源码移动到 `apps/game/`，当时由根包继续提供默认二进制。[验收入口](../../../apps/acceptance/src/main.rs)安装外部工具插件，负责设置 Demo 的相机选择。[验收脚本](../../../scripts/acceptance/)保留业务场景、用户设置事务和会话日志核对。后续的包边界见[四个应用独立装配](2026-11-22-independent-apps.md)。

调度导出入口移除自身的单元测试，入口通过实际导出检查。调度快照和架构工具的回归保留在各自模块。

## Alternatives considered

保留共享应用构建函数可复用装配代码，但各入口仍要从共享库选择运行策略。保留验收工具快照可避免初次构建访问 GitHub，却增加 Rust 和 Python 源码的同步工作。

## Consequences

普通游戏的 Cargo 命令沿用现有入口。共享库的诊断 feature 继续控制游戏类型的反射和检查器输入。Cargo 锁文件记录 Rust 工具的实际版本，Python 驱动独立安装。更新工具时按[验收启动准备](../../testing/README.md#自动化启动准备)重新验证两者。

## Verification

按[测试指南](../../testing/README.md)检查默认与专用入口构建、业务 BRP 契约、Python 驱动和五套无窗验收。调度导出按[调度导出边界](https://github.com/fedoraiver/demo/blob/054f6fdf596d2f6b4c9c0ce9ce6999250e28da4f/docs/diagrams/maintenance.md#调度导出边界)检查普通窗口配置与源码指纹。普通窗口交互由用户验收。
