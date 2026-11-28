# Agent Note: 四个应用独立装配

Status: implemented

## Problem

[先前的装配方式](2026-11-22-app-assembly-and-acceptance.md)将入口分开，仍由根包提供普通游戏与共享库。入口从应用目录引入相同的 App 构建辅助模块。一个命令同时构建多个应用时，共享库的诊断 feature 也可能合并。

## Decision

根清单管理 workspace 和共享依赖，普通游戏与其他入口各自拥有应用包。各入口直接装配 App，通过模块路径将同一份玩法源码编译进各自的二进制。调度导出按普通游戏的插件顺序装配。

## Changes

[应用装配](../../architecture/game_flow.md#应用装配)记录入口与源模块的边界。[验收驱动](../../../scripts/acceptance/driver.py)使用 `demo_acceptance::` 下的反射类型，从脚本位置定位仓库根与资源。

编译器规则在虚拟 workspace 根目录选择默认成员。传入成员目录时检查该成员。实体命名与模板提取按照请求的工作区根识别本地创建位置，涵盖包目录外通过 `#[path]` 引入的共享源码。架构提取配对 `demo-debugdump` 同一次编译的类型事实与快照，源码指纹跟踪普通游戏和导出的独立清单及入口。

实体命名和具名字段工具各自维护独立的 Cargo 清单及锁文件。游戏 workspace 显式排除这两个工具，使 CI 可直接使用各工具的清单。

Python 验收、音频维护脚本和回归测试移到仓库根目录的 [scripts/](../../../scripts/)。脚本按新位置定位共享资源和测试输入。

[VS Code 工作区设置](../../../.vscode/settings.json)通过 `rust-analyzer.vfs.extraIncludes` 将共享 `src/` 纳入模块索引。VS Code 扩展把 `${workspaceFolder}` 展开为当前工作区根路径，所以各 worktree 可使用同一份设置。

共享构建脚本为 Cargo 登记共享源码用到的条件编译值和 Windows 链接清单。各入口在自己的 Cargo 清单中决定启用哪些 feature。跨 worktree 的构建输出约束见[构建与调试](../../development.md#构建与调试)。

## Alternatives considered

共享玩法库可以减少各入口重复编译，也会让诊断配置和类型身份落在共同的库包。保留根包可以沿用原编译器选包规则，同时会使普通游戏的清单和其他入口分布在不同层级。

## Consequences

根目录的 `cargo run --locked` 仍运行普通游戏。各入口单独决定装配顺序和诊断配置，修改普通游戏的窗口或插件装配时同步核对导出入口。不同二进制的玩法类型有各自的编译身份，验收协议与架构提取均绑定对应入口。

## Verification

按[测试指南](../../testing/README.md)检查二进制目标、Rust 与 Python 回归、五套无窗验收、截图和设置恢复。按[调度导出边界](https://github.com/fedoraiver/demo/blob/054f6fdf596d2f6b4c9c0ce9ce6999250e28da4f/docs/diagrams/maintenance.md#调度导出边界)核对 Windows 原生导出、来源指纹及类型绑定。[Windows 链接产物检查](../../testing/window_policy.md#windows-msvc-链接产物)覆盖 Common Controls v6 清单，实际窗口交互由用户验收。
