# Agent Note: 按用途拆分应用入口

Status: implemented

## Problem

此前普通游戏、检查器、BRP 验收和调度导出共用一个可执行目标。编译 feature 和命令行参数会改变该程序的启动路径，脚本及架构工具因此依赖同一个程序名和相应参数。相关诊断能力之前由[可选检查器与诊断反射](2026-11-22-optional-inspector-reflection.md)和[独立 Bevy 无窗验收工具](2026-11-22-portable-bevy-acceptance.md)引入。

## Decision

普通游戏保留工作区默认入口。检查器、验收和调度导出各用一个可执行包，通过包名选入口。各包在依赖声明中启用所需能力，共用 `demo` 库的玩法装配，Rust 回归在库测试目标运行。BRP 验收脚本指定验收程序，架构事实提取明确选择调度导出程序。

## Changes

当时由 `src/app.rs` 提供窗口、检查器和无窗构建。[启动说明](../../../README.md#运行)和[自动化启动准备](../../testing/README.md#自动化启动准备)使用按包选择的命令。调度导出专包接受 `--output`，当时另提供 `cargo dump-inspector` 显式导出检查器调度。[架构提取](../../../tools/rustc-analysis/runner/src/host.rs)绑定导出包及目标，模型识别共享装配，调度快照的指纹覆盖新入口源码。后续调整见[普通游戏调度导出与入口参数](2026-11-22-ordinary-game-schedule-export.md)及[应用入口装配与外部验收工具](2026-11-22-app-assembly-and-acceptance.md)。

## Alternatives considered

单包多二进制可共用 Cargo 清单，但调用者仍须显式启用该入口需要的 feature。工作区可执行包自行声明依赖，命令只需选包。

## Consequences

同时选择多个包时，共享库的 feature 可能合并。普通产物按默认包单独构建时维持独立的编译配置。Cargo 从子包传入运行时 `CARGO_MANIFEST_DIR`，[工作区 Cargo 配置](../../../.cargo/config.toml)为各入口提供共享资源根，并允许调用方覆盖。Windows 链接清单由各包共用的构建配置生成。

## Verification

在 Windows 验证默认和工作区 Rust 回归、Python 回归、专用 CLI 参数与 Common Controls v6 清单。五套 BRP 验收脚本通过独立验收程序运行，校验原有游戏条件、截图和共享设置恢复。两种调度导出比较检查器调度并核对源码指纹。架构工具的冷、热编译回归验证仅执行指定导出包，实际模型确认普通入口及共享装配均有源码证据，并保留玩法插件注册关系。普通游戏和检查器的原生窗口交互属于用户验收范围。
