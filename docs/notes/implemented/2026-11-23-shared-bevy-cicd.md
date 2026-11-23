# Agent Note: 接入共享 Bevy CI/CD

Status: implemented

## Problem

本仓库独立维护 Rust 检查、编译器规则、调度导出与架构站点发布。普通游戏和调度导出分别装配插件，入口变化时需要同步两份代码。

## Decision

由共享工作流执行检查、导出和发布。[bevy-cicd](https://github.com/fedoraiver/bevy-cicd)

工作区声明 `demo` 为架构提取包。共享启动器调用该包的 `build_app`，与普通游戏复用相同的插件装配。检查器和验收继续使用各自的 Cargo 入口。

## Changes

[Rust 工作流](../../../.github/workflows/rust-rules.yml)调用共享检查与编译器规则。[架构工作流](../../../.github/workflows/ecs-architecture.yml)调用共享构建与 Pages 发布。架构图文档与生成器由共享仓库维护，项目保留在线图入口。

[普通游戏库](../../../apps/game/src/lib.rs)提供应用构造函数，导出期间由应用持有日志守卫。[独立调度导出程序](2026-11-22-independent-apps.md)及其依赖已移除。[临时测试工作区隔离](2026-11-23-isolate-rule-test-workspaces.md)随规则测试移交共享仓库。

## Alternatives considered

保留独立调度程序需要继续同步窗口、日志及插件配置，并维护项目锁文件中的导出依赖。

## Consequences

调度导出使用共享仓库的工具链和维护命令。普通游戏的无窗口回归由库测试目标运行。

## Verification

编译与无窗口测试覆盖工作区各应用，Windows 链接产物检查核对游戏及测试程序内的 Common Controls v6 清单。架构验证以共享工作流的运行证据为准，检查普通游戏的主应用及渲染子应用调度、插件装配和 Pages 静态包。
