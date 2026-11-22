# 应用验收接入

[主入口](../../src/main.rs)为开启 `acceptance-test` 的游戏安装 [AcceptancePlugin](../../src/acceptance/mod.rs)。插件在 `RenderApp` 创建前安装 Bevy 自带的 `RemotePlugin` 和 `RemoteHttpPlugin`，只绑定主世界的 `127.0.0.1:15702`。HTTP 响应通过插件的标头配置提供 `X-Bevy-Pid`。

验收入口由 `ScheduleRunnerPlugin` 以约 `60 Hz` 驱动，保留一个 `1920×1080`、缩放因子为 `1` 的逻辑主窗口。逻辑窗口给输入路由、鼠标捕获状态与正常退出提供实体身份。菜单和玩法相机共享同尺寸的离屏图像渲染目标。普通游戏和调度导出的窗口与检查器装配见[原生窗口策略](window_policy.md)与[检查器](inspector.md)。

无窗验收与普通游戏都通过 `GameSettingsPlugin` 读写同一个用户设置文件。自动化脚本负责启用测试配置，并在进程退出后恢复用户设置。[设置架构](settings.md#设置草稿与持久化) · [共用设置与恢复](../testing/README.md#共用设置与恢复)

验收接入注册脚本使用的组件、资源、消息和事件。菜单、应用状态、玩法实体、实际设置和会话日志由各功能模块维护。脚本通过 `world.query`、`world.get_components` 和 `world.get_resources` 读取这些数据。

按键、按钮、相对鼠标位移和逻辑窗口关闭通过 `world.write_message` 投递。玩法消费具体键鼠消息，Picking 从 Bevy 原生 `WindowEvent` 转换光标和鼠标按钮。绝对光标位置在逻辑窗口及 `CursorMoved` 中同步，Picking 的指针目标由逻辑窗口映射到离屏图像。连续 BRP 请求可以在同一帧处理，脚本轮询键鼠和业务状态确认输入已被消费。

脚本共用[开局、相对鼠标位移与状态采样](../../scripts/acceptance/gameplay.py)，由[驱动](../../scripts/acceptance/driver.py)管理按键保持和释放。验收项可以通过原生 `world.insert_components` 为当前会话的角色同时准备 Avian `Position` 和 `LinearVelocity`，再等待物理位置、呈现位置和接地状态符合前置条件。场景行为继续由键鼠消息触发。

脚本查询相机的离屏 `RenderTarget`，用 `world.observe+watch` 订阅 `ScreenshotCaptured`，随后用 `world.spawn_entity` 创建指向该图像的 `Screenshot`。事件传输图像尺寸、纹理格式、像素和请求实体。客户端按实体关联事件，将 RGBA8 或 BGRA8 像素编码为 PNG。菜单和玩法验收要求有可见内容，渲染准备期间只收到纯色图像时在时限内重新捕获。具体运行、退出、恢复及覆盖见[验收测试指南](../testing/README.md#自动化启动准备)。

截图事件异步到达。镜头与移动脚本在关键阶段的截图前后读取 BRP 状态，以两次采样核对截图期间的稳定性。采样覆盖的时点及观察要求见[人物移动与镜头验收](../testing/app-acceptance.md#人物移动与镜头)。
