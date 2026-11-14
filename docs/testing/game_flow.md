# game_flow 测试

[测试指南](README.md)说明分层和执行边界；实机步骤由用户执行。

## 无窗口集成验证

运行 `cargo test --locked game_flow::tests`，检查状态、暂停及初始化日志；相关跨功能条件见 [菜单测试](ui.md) 和 [会话日志测试](session_log.md)。

用户检查暂停与恢复按 [菜单与暂停验收](ui.md#英文菜单与暂停验收) 执行。
