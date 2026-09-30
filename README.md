# demo

使用 Bevy 0.19.1，构建策略在 `Cargo.toml` 中配置。

## 日常开发与调试

```powershell
cargo run
cargo build
cargo check
```

项目代码使用一级优化并保留完整调试信息，兼顾编译速度和运行性能。
Bevy 等依赖使用三级优化，避免调试构建的引擎运行过慢。
调试断言和整数溢出检查保持开启。优化可能使单步调试跳行，或使部分变量无法查看。
首次构建依赖耗时较长，后续修改项目代码可以复用依赖缓存。

输出：`target/debug/demo.exe`。

## 正式发布

```powershell
cargo build --release --locked
cargo run --release --locked
```

使用三级优化、Thin LTO 和单个代码生成单元，优先考虑运行性能；构建会比调试模式更慢。
移除调试信息，使用 Cargo 默认的发布模式断言与溢出检查设置。
保留默认 panic 行为，便于正常清理资源和处理线程异常。
`--locked` 确保使用提交的 `Cargo.lock`，依赖需要变化时直接报错。

输出：`target/release/demo.exe`。后续添加外部资源时，发布包也需要包含对应的 `assets` 文件。
