# Agent Note: Rust 无窗口测试插桩覆盖率

Status: implemented

## Problem

普通游戏已有无窗口 Rust 测试。需要确认如何用锁定的 Rust 工具链定位这些测试实际执行到的项目源码。[Issue #35](https://github.com/fedoraiver/demo/issues/35)

## Decision

只为 `demo` 库测试目标启用 `-C instrument-coverage`，让 Cargo 复用匹配的普通依赖产物。使用固定工具链的 `llvm-profdata` 合并主测试进程和子进程的计数，并用对应的测试可执行文件生成源码覆盖率报告。[Cargo rustc](https://doc.rust-lang.org/cargo/commands/cargo-rustc.html) · [Rust 插桩覆盖率](https://doc.rust-lang.org/rustc/instrument-coverage.html)

## Changes

[测试指南](../../testing/README.md#本地-rust-源码覆盖率)提供从构建库测试到生成文本汇总和逐行 HTML 报告的 Windows 命令。报告以工作区路径筛选具有映射的库源码，支持以 `#[path]` 引入的共享模块。

## Alternatives considered

给整个依赖图设置 `RUSTFLAGS=-C instrument-coverage` 会重编依赖并扩大统计范围。引入 `cargo-llvm-cov` 可以简化命令，当前单个库目标可用 Rust 工具链组件直接完成。按文件名传递 `llvm-cov -sources` 时，编译器记录中的 `..` 可能使跨目录模块匹配失败，因此使用目录正则筛选。

## Consequences

报告反映当前平台上普通游戏库测试执行到的已映射源码。参加编译的条件代码随测试目标和平台变化。无窗验收、检查器和原生窗口各有独立验证入口。[验证边界](../../testing/README.md#agent-验证边界)

## Verification

使用 [仓库固定工具链](../../../rust-toolchain.toml) 在 Windows 构建并执行了完整的 `demo` 库测试，生成了项目源码汇总和逐行报告。核对了日志用例启动的子进程产生的原始计数。复现和比较时使用同一平台及测试配置。
