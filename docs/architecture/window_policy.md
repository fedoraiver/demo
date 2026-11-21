# 原生窗口策略

源码入口见 [window_policy/](../../src/window_policy/mod.rs)。

`WindowPolicyPlugin` 在窗口线程的 `PreUpdate` 通过 `NonSendMarker` 读取线程局部 `WINIT_WINDOWS`，确认真实主窗口后安装策略；Windows 与 macOS 初始隐藏窗口，安装完成再显示。取得身份快照后结束后端表借用，再调用原生 API，避免同步通知重入。

原生守卫由 NonSend 资源拥有，窗口实体或后端退出时清理；安装失败显示固定窗口并记录错误。仅有 `Window` ECS 数据的测试不调用原生 API。窗口行为见 [玩家指南](../player-guide.md#菜单与占位功能)。

## 平台适配

窗口尺寸由平台适配层约束。业务键鼠输入由 Enhanced Input 与 Bevy UI 处理。

- macOS 通过 `NSWindow` 的 `contentAspectRatio` 和工作区边界约束拖拽，保留 Winit 代理并禁用系统全屏和全屏平铺。系统 Zoom 等操作若绕过属性，策略会在 `PreUpdate` 检查已生效的尺寸，仅在越界时校准。
- Windows 通过 `SetWindowSubclass` 处理 `WM_SIZING / WM_WINDOWPOSCHANGING`，保留 `DefSubclassProc` 链与 Winit 的 DPI 处理。客户区按 `(16k, 9k)` 计算；最大化转换为工作区内的普通窗口。共用几何入口见 [geometry.rs](../../src/window_policy/geometry.rs)。

Windows MSVC 的 `GetWindowSubclass` 等静态导入依赖 Common Controls v6 清单；缺少清单时可能以 `0xc0000139`（`STATUS_ENTRYPOINT_NOT_FOUND`）在初始化前退出，此时既没有窗口策略回退，也没有会话日志。清单嵌入与链接检查见 [构建与调试](../development.md#构建与调试)。
