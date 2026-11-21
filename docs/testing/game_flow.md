# game_flow 测试

[测试指南](README.md)说明分层和执行边界。

## 无窗口集成验证

运行 `cargo test --locked game_flow::tests`，检查状态、暂停及初始化日志；相关跨功能条件见 [菜单测试](ui.md) 和 [会话日志测试](session_log.md)。

暂停、恢复和重新开始的窗口场景及脚本覆盖见[应用验收](app-acceptance.md#菜单与暂停)。
