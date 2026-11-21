# 应用验收接入

[主入口](../../src/main.rs)为开启 `acceptance-test` 的游戏安装 [AcceptancePlugin](../../src/acceptance/mod.rs)。插件在 `RenderApp` 创建前安装 Bevy 自带的 `RemotePlugin` 和 `RemoteHttpPlugin`，只绑定主世界的 `127.0.0.1:15702`。HTTP 响应通过插件的标头配置提供 `X-Bevy-Pid`。普通游戏和调度导出装配[检查器](inspector.md)，开启验收的游戏省去 Inspector、Egui 及相机 Egui 上下文。

验收接入注册脚本使用的组件、资源、消息和事件。菜单、应用状态、玩法实体、实际设置和会话日志由各功能模块维护。脚本通过 `world.query`、`world.get_components` 和 `world.get_resources` 读取这些数据。

按键、按钮、相对鼠标位移和窗口关闭通过 `world.write_message` 投递。玩法消费具体键鼠消息，Picking 从 Bevy 原生 `WindowEvent` 转换光标和鼠标按钮。改变绝对位置时同步窗口的物理光标位置，按窗口缩放向 `CursorMoved` 提交逻辑坐标。BRP 响应只表示消息写入，脚本通过键鼠和业务状态确认消费。

截图使用 `world.observe+watch` 订阅 `ScreenshotCaptured`，随后用 `world.spawn_entity` 创建指向主窗口的 `Screenshot`。事件传输图像尺寸、纹理格式、像素和请求实体。客户端按实体关联事件，将 RGBA8 或 BGRA8 像素编码为 PNG。菜单和玩法验收要求有可见内容，渲染准备期间只收到纯色图像时在时限内重新捕获。具体运行、退出、恢复及覆盖见[验收测试指南](../testing/README.md#自动化启动准备)。
