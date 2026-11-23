# 日志验证

测试分层、运行方式与执行边界见[测试指南](README.md)。

## 会话日志无窗口验证

在仓库根运行以下无窗口检查。

```powershell
cargo test --locked --workspace game_flow::tests::initialization_tests
cargo test --locked -p demo-acceptance --bin demo-acceptance tests::native_log_plugin_writes_separate_files_with_shared_filter
```

[初始化日志测试](../../src/game_flow/tests.rs) 安装实际功能插件并执行 `Startup`，核对玩法配置、固定模拟时步和检查器启用等启动日志。

[验收入口的日志测试](../../apps/acceptance/src/tests.rs)在独立子进程中装配全局 `LogPlugin` 和环境变量。两次启动分别创建新的文件并保留首次写入的内容。检查文件名格式、UTC 时间、级别、target、结构化字段和无 ANSI 色码的输出，并比较 `RUST_LOG` 对 stderr 和文件的过滤结果。

## 日志检查与问题反馈

业务日志验收以驱动捕获的进程输出为证据。[应用自动化验收](app-acceptance.md#会话日志) · [日志位置与问题反馈](../player-guide.md#会话日志)
