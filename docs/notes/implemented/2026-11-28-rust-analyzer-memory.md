# Agent Note: 降低 Rust Analyzer 工作区内存占用

Status: implemented

## Problem

VS Code 打开本项目后，Rust Analyzer 的主进程工作集约为 3.9 GiB。项目的三个 Cargo 应用均依赖 Bevy，并通过路径属性编译共享源码。保存检查还可能读到其他 worktree 缓存的编译期资源绝对路径，在该 worktree 删除后报找不到音频清单和字体。

## Decision

保留根目录监听，用排除项缩小 VFS 的递归范围。限制保存检查的并行编译，保留默认的检查范围。编译期资源改用相对源码的路径，测试 fixture 用 Cargo 启动测试时提供的 `CARGO_MANIFEST_DIR` 定位仓库。

## Changes

Rust Analyzer 跳过仓库根的 `tmp/`、`target/` 和 `logs/`。共享 `src/` 和根目录构建配置仍由 VFS 加载。保存检查传入 `--jobs 2`，其他 Cargo 调用沿用各自的并行设置。[VS Code 工作区设置](../../../.vscode/settings.json) · [应用装配记录](2026-11-22-independent-apps.md)

音频清单和 UI 测试字体从当前源码位置嵌入。共享构建脚本输出只携带条件编译和链接配置。[构建与调试](../../development.md#构建与调试)

## Alternatives considered

关闭预热可降低项目加载完成时的工作集。首次跳转和宏展开会把部分成本推迟到编辑时，工作集随后接近开启预热时的水平。

把 VFS 附加路径收窄到 `src/` 和 `build_configuration.rs` 时，初始加载可以读取构建配置。VS Code 的目录相对监听模式无法匹配以该文件本身为基准的变更，也会失去工作区根的锁文件监听。[监听注册实现](https://github.com/rust-lang/rust-analyzer/blob/37721d1413/crates/rust-analyzer/src/reload.rs#L515-L590)

限制后台线程主要影响并发峰值。安装的 Rust Analyzer 0.3.3130 仍声明 LRU 设置，对应的缓存容量更新函数为空。[版本源码](https://github.com/rust-lang/rust-analyzer/blob/37721d1413/crates/ide-db/src/lib.rs#L203-L235)

反复编辑后，关闭即时诊断或自动导入补全、缩短分配器回收延迟和减少过程宏进程数，对语言服务器的常驻内存影响很小。保留这些设置的默认值。

## Consequences

保存检查的编译进程峰值由其并行度影响，限制并行编译后冷缓存检查可能耗时更久。

## Verification

独立 LSP 会话使用同一版本和 Cargo 工作区比较预热、VFS 范围和反复编辑后的内存。编辑测量包含悬停、补全、内联提示和诊断，导航验证覆盖共享模块、构建脚本模块、Bevy `bsn!` 展开及工作区符号搜索。单独测量保存检查，比较同一共享源码触发全部目标检查时 Cargo 进程树的内存峰值和并发编译进程数。

资源路径验证使用相同共享构建缓存执行 `cargo check --locked --workspace --all-targets` 和无窗口测试。独立最小复现确认为不同工作副本复用同一个测试二进制时，Cargo 启动测试使用当前工作副本的路径。
