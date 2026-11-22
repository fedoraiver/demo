# Agent Note: 验收启动音量

Status: implemented

设置目录和恢复流程见后续决策 [共用设置文件的应用验收](2026-11-22-acceptance-shared-settings.md)。

## Problem

[无窗 BRP 验收](2026-11-22-headless-brp-acceptance.md)用专用 Kira 输出轨增益控制静音。验收需要由正常的总音量设置决定是否播放声音，并避免改写玩家设置。

## Decision

每次脚本运行先在私有 `settings.toml` 写入 `game.audio.master_volume = 0`，让 Bevy 正常加载并由游戏混音处理。脚本在启动前校验磁盘值，在输入前通过 BRP 核对生效值。设置用例将写出的配置恢复成此次启动配置的原始字节。

## Changes

[音频插件](../../../src/audio/mod.rs)统一使用正常的音频轨。[验收驱动](../../../scripts/acceptance/driver.py)准备和校验启动音量。手动探索启动步骤见[测试指南](../../testing/README.md#探索性应用验收)。

## Alternatives considered

验收专用轨道增益将静音行为放在游戏总音量之外。专用虚拟端点会引入设备路由和系统驱动依赖。私有配置能使用现有设置加载和混音流程。

## Consequences

Kira 仍初始化系统默认设备。运行中的音量预览遵循游戏行为，有声设置会立即影响输出。自动化脚本的静音条件由启动配置与用例输入共同维持。

## Verification

检查启动设置、BRP 生效值与私有设置恢复。应用验收按[自动化启动准备](../../testing/README.md#自动化启动准备)串行执行，实际结果随报告和会话日志保留。
