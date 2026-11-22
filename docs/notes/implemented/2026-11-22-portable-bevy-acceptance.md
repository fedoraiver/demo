# Agent Note: 独立 Bevy 无窗验收工具

Status: implemented

## Problem

[无窗验收](../implemented/2026-11-22-headless-brp-acceptance.md)已通过原生 Bevy BRP 驱动输入、读取状态和截图。Rust 插件沿用 `demo` 的默认 UI 相机标记，Python 驱动依赖游戏状态、设置结构和用例组织。其他 Bevy 项目需要提取通用机制后才能接入。

## Decision

在独立仓库维护可选 Rust 插件、Python 标准库驱动及最小 Bevy 示例。应用指定离屏相机、所需业务反射和就绪条件。`demo` 从同一版本取用 Rust 和 Python 快照，保留场景用例、验收入口、会话日志及[共用设置恢复](2026-11-22-acceptance-shared-settings.md)。

## Changes

当时仓库内的工具快照提供原生 BRP、逻辑窗口、离屏图像、Picking 路由及 Python 驱动。Demo 用单独插件标记菜单与玩法相机。[项目脚本](../../../scripts/acceptance/driver.py)管理设置、日志校验和业务用例。独立示例包含按键、相对鼠标与真实 UI 点击。外部依赖的迁移见[应用入口装配与外部验收工具](2026-11-22-app-assembly-and-acceptance.md)。

## Alternatives considered

从 `demo` 直接复制整套脚本会把场景与用户设置约定带到目标项目。独立维护允许多个项目使用同一实现。本机绝对路径依赖会要求其他工作树和 CI 具备相同目录，因此 `demo` 使用仓库中的快照。

## Consequences

工具可从独立仓库构建和安装。两份快照需要按同一版本同步。Bevy 版本可能改变反射路径、消息序列化或 Picking 调度，升级时应重跑真实键鼠和离屏截图。

## Verification

在 Windows 与 Bevy 0.20.1 验证两边的 Rust 与 Python 回归。独立示例通过原生键鼠验证状态变化、异常释放、正常退出和两张 `1920×1080` PNG。`demo` 的五套无窗脚本通过原有 25 项，确认相同视口尺寸、共享设置恢复和日志完整。后续按[验收指南](../../testing/README.md#自动化启动准备)复测。
