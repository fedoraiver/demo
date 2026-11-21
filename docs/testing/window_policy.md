# window_policy 测试

[测试指南](README.md)说明分层和执行边界；实机步骤由用户执行。

## 无窗口验证

窗口策略回归用 `cargo test --locked window_policy::`：覆盖初始 16:9、最小尺寸、无窗口应用不安装原生后端、Windows 拖边／拖角锚点及角内拖缩小、DPI 物理最小尺寸、工作区最大化和重复请求幂等。平台无关几何与 Windows 桥接共用源码，macOS 也运行这些数学检查，并检查工作区内容尺寸拟合；原生消息、跨屏和实际最大化效果由用户验收。

### Windows MSVC 链接产物

Windows MSVC 的启动依赖还需检查最终链接产物：[build.rs](../../build.rs) 应为游戏和测试程序嵌入 Common Controls v6 清单。

执行 `cargo build --locked` 与 `cargo test --locked --no-run window_policy::` 后，使用 PE 资源检查工具读取游戏 EXE 和 Cargo 输出中指定的测试 EXE，确认存在 `RT_MANIFEST`（资源类型 24、ID 1），且依赖包含 `Microsoft.Windows.Common-Controls`、版本 `6.0.0.0`。

启用共享 `build-dir` 时，测试程序位置以 Cargo 输出为准。只有 `cargo check` 通过或看到静态导入名称不能代替清单检查；此检查不执行游戏，测试仍须遵守无窗口边界。Windows GNU 不适用本构建脚本的 MSVC 清单参数。

Windows MSVC 构建若在应用初始化前以 `0xc0000139`（`STATUS_ENTRYPOINT_NOT_FOUND`）或其他错误退出且没有新会话日志，保留终端退出码和构建目标。窗口策略以应用初始化后的行为和日志为证据。

窗口缩放、最大化及日志的验收条件见[菜单与暂停验收](ui.md#英文菜单与暂停验收)。
